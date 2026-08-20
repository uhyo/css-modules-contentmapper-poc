#!/usr/bin/env node
/**
 * Minimal LSP client that drives the native `tsc --lsp -stdio` to demonstrate
 * go-to-definition from a TypeScript file into a content-mapped CSS Module.
 *
 * Usage: node scripts/lsp-goto-def.mjs <tsc-path> <project-dir> <file> <needle>
 *
 * Sends initialize (with initializationOptions.runExternalCode: true — the LSP
 * equivalent of the --runExternalCode CLI flag, normally gated on workspace
 * trust by the editor), opens <file>, and requests textDocument/definition at
 * the first occurrence of <needle>, printing the location(s) the server returns.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [tscPath, projectDir, file, needle] = process.argv.slice(2);
if (!tscPath || !projectDir || !file || !needle) {
  console.error("usage: lsp-goto-def.mjs <tsc-path> <project-dir> <file> <needle>");
  process.exit(2);
}

const absProject = resolve(projectDir);
const absFile = resolve(absProject, file);
const text = readFileSync(absFile, "utf8");
const needleIndex = text.indexOf(needle);
if (needleIndex < 0) {
  console.error(`needle ${JSON.stringify(needle)} not found in ${absFile}`);
  process.exit(2);
}
const before = text.slice(0, needleIndex);
const line = (before.match(/\n/g) ?? []).length;
const character = needleIndex - (before.lastIndexOf("\n") + 1);

const server = spawn(tscPath, ["--lsp", "-stdio"], { stdio: ["pipe", "pipe", "inherit"] });
const timeout = setTimeout(() => {
  console.error("timed out waiting for the server");
  server.kill();
  process.exit(1);
}, 30000);

let nextId = 1;
const pending = new Map();

function send(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  server.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
  server.stdin.write(json);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let buffer = Buffer.alloc(0);
server.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("ascii"));
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(body);
  }
});

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } else if (message.id !== undefined) {
    // Server-to-client request; answer with harmless defaults.
    let result = null;
    if (message.method === "workspace/configuration") {
      result = message.params.items.map(() => null);
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  }
  // Notifications (diagnostics, log messages) are ignored.
}

const fileUri = pathToFileURL(absFile).href;

const initResult = await request("initialize", {
  processId: process.pid,
  rootUri: pathToFileURL(absProject).href,
  workspaceFolders: [{ uri: pathToFileURL(absProject).href, name: "demo" }],
  capabilities: { textDocument: { definition: {} } },
  initializationOptions: { runExternalCode: true },
});
console.log(`initialize ok (server: ${JSON.stringify(initResult.result?.serverInfo ?? "?")})`);
send({ jsonrpc: "2.0", method: "initialized", params: {} });
send({
  jsonrpc: "2.0",
  method: "textDocument/didOpen",
  params: {
    textDocument: { uri: fileUri, languageId: "typescript", version: 1, text },
  },
});

console.log(`definition request at ${file}:${line + 1}:${character + 1} (on ${JSON.stringify(needle)})`);
const definition = await request("textDocument/definition", {
  textDocument: { uri: fileUri },
  position: { line, character },
});
console.log(JSON.stringify(definition.result ?? definition.error, null, 2));

await request("shutdown");
send({ jsonrpc: "2.0", method: "exit" });
clearTimeout(timeout);
setTimeout(() => { server.kill(); process.exit(0); }, 500);
