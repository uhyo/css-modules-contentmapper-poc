# Draft: upstream report for the content-mappers branch

Target: PR [microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712)
(branch `content-mappers` of `andrewbranch/typescript-go`, observed at commit
`d07c1fff6efd364533b7073dd87b39aaf03029c8`). Posted 2026-08-16; kept here as
the record of the diagnosis.

---

## `tsc` hangs forever at exit when the mapper's `node` is a launcher shim (Volta)

### Symptom

With a content mapper whose manifest is `"exec": ["node", "dist/server.js"]`,
`tsgo -p <project> --runExternalCode` completes the compile (the mapper's
`initialize` and `transform` round-trips all succeed) but then hangs
indefinitely, printing nothing — not even diagnostics. Each run also leaks one
orphaned `node dist/server.js` process.

This happens whenever `node` on `PATH` is not the real binary but a launcher
that runs the real `node` as a *separate* process, so that the real interpreter
is not a direct child of `tsgo`. Volta is the concrete case here
(`~/.volta/bin/node` → `volta-shim`; the real node ends up reparented to init),
but any launcher with this shape reproduces it. Version managers that `exec`
into the real binary (nvm, asdf's exec-style shims) are unaffected, which is
presumably why this hasn't surfaced in local testing.

### Root cause

`childProcess.Close` in `cmd/tsgo/sys.go` (lines 110–121) tears a mapper down
with:

```go
_ = p.cmd.Process.Kill()
err := p.cmd.Wait()
```

`cmd.Stderr` is a non-`*os.File` writer, so `os/exec` created a stderr pipe
plus an internal copying goroutine, and `Wait` blocks in `awaitGoroutines`
until that pipe reaches EOF. Volta's shim stays resident as a middleman
(`tsgo → volta-shim → node`), so the `Kill` terminates only the shim; the real
`node` — a grandchild — survives, is reparented to init, and keeps the write
end of the inherited stderr pipe open. The mapper protocol tells servers to
exit on stdin EOF, but `Close` never closes the child's stdin, so the real
`node` also never exits on its own. Result: a mutual wait — `tsgo` waits for
the mapper's stderr to close while the mapper waits for its stdin to close —
after the compile has already succeeded.

Two details verified while diagnosing, relevant to the fix space:

- Volta's shim does not forward signals: even SIGTERM sent to the shim leaves
  the real `node` running. So switching `Kill` to a catchable signal would not
  help; nothing signal-based that targets only the direct child's PID can.
- The stdin-EOF path works exactly as the protocol intends, through the shim:
  closing the spawner's write end makes the (even already-orphaned) real
  `node` exit promptly, because pipe fds follow inheritance, not process
  ancestry.

Main-goroutine stack at the hang (`SIGQUIT` dump, abbreviated):

```
goroutine 1 [chan receive]:
os/exec.(*Cmd).awaitGoroutines(...)
os/exec.(*Cmd).Wait(...)
main.(*childProcess).Close(...)
        cmd/tsgo/sys.go:116
github.com/microsoft/typescript-go/internal/contentmapper.(*host).release(...)
        internal/contentmapper/hostimpl.go:982
github.com/microsoft/typescript-go/internal/contentmapper.(*projectLease).release(...)
github.com/microsoft/typescript-go/internal/contentmapper.(*projectLease).Close.func1()
github.com/microsoft/typescript-go/internal/execute.performCompilation.deferwrap1()
        internal/execute/tsc.go:358
```

### Reproduction

1. Install Volta and a Volta-managed node (observed with node 24.13.1 on
   linux/amd64 under WSL2; binary built with Go 1.26.0).
2. Set up any working content mapper with `"exec": ["node", ...]` — e.g. the
   CSS Modules PoC at <https://github.com/uhyo/css-modules-contentmapper-poc>.
3. `tsgo -p demo --runExternalCode` → hangs after a successful compile; an
   orphaned `node dist/server.js` remains.

Workaround: prepend a directory containing a symlink to the real binary
(`ln -s "$(volta which node)" dir/node`; `PATH="dir:$PATH" tsgo ...`).

### Suggested fixes (any one suffices; they compose)

1. **Set `cmd.WaitDelay`** in `spawnProcess`. This is exactly the situation
   `WaitDelay` exists for: once the child itself has exited, `Wait` stops
   waiting for inherited pipe fds after the delay and closes them. A small
   delay (e.g. 1–2s) bounds shutdown without affecting well-behaved mappers.
2. **Close the child's stdin before waiting.** The protocol already specifies
   stdin EOF as the shutdown signal, and (verified above) EOF reaches the real
   interpreter through any launcher; a graceful `stdin.Close()` → bounded wait
   → `Kill` sequence lets launcher-wrapped servers exit on their own and beats
   kill-first even in the non-shim case.
3. **Kill the process group** (`Setpgid: true` at spawn, `kill(-pgid)`) so the
   real interpreter behind a launcher is also terminated and never leaks.

Happy to turn this into a PR against the branch if that's useful.
