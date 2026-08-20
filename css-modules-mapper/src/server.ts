/**
 * JSON-RPC 2.0 server over stdio for the typescript-go Content Mapper protocol.
 *
 * Framing is the LSP base protocol: "Content-Length: <bytes>\r\n\r\n<utf-8 json>".
 * TypeScript is the only side that sends requests; this server answers
 * "initialize", "openProject", "closeProject", and "transform" and rejects
 * anything else. It is stateless per request — one process may serve many
 * projects in any order, and transforms are a pure function of
 * (fileName, content), so project handles need no bookkeeping here.
 *
 * stdout carries protocol frames only; all logging goes to stderr.
 */
import { transform, internalErrorResult } from "./transform.js";

const PROTOCOL_VERSION = 1;

interface RequestMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});

process.stdin.on("end", () => {
  process.exit(0);
});

function pump(): void {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Malformed header; discard it and resynchronize on the next frame.
      process.stderr.write(`css-modules-mapper: dropping malformed header: ${header}\n`);
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) {
      return; // wait for the rest of the frame
    }
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
    buffer = buffer.subarray(bodyStart + contentLength);
    handleMessage(body);
  }
}

function send(message: object): void {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${json.length}\r\n\r\n`);
  process.stdout.write(json);
}

function handleMessage(body: string): void {
  let message: RequestMessage;
  try {
    message = JSON.parse(body) as RequestMessage;
  } catch (error) {
    process.stderr.write(`css-modules-mapper: unparseable frame: ${String(error)}\n`);
    return;
  }
  if (message.method === undefined) {
    return; // a response — the protocol is parent-driven, nothing to correlate
  }
  if (message.id === undefined) {
    return; // notification — none defined by the protocol
  }
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          positionEncoding: "utf-16",
          diagnosticSource: "css-modules",
        },
      });
      break;
    case "openProject":
      // Sent before the first transform for each project (since the merged
      // protocol; formerly only for dynamicConfig mappers). This mapper has no
      // dynamic config, so the result must carry no configIdentity and no
      // watchedFiles — an empty object.
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      break;
    case "closeProject":
      send({ jsonrpc: "2.0", id: message.id, result: null });
      break;
    case "transform": {
      const params = message.params ?? {};
      const fileName = typeof params.fileName === "string" ? params.fileName : "";
      const content = typeof params.content === "string" ? params.content : "";
      let result;
      try {
        result = transform(fileName, content);
      } catch (error) {
        // Never let an exception escape: five failures disable the mapper.
        process.stderr.write(`css-modules-mapper: transform failed for ${fileName}: ${String(error)}\n`);
        result = internalErrorResult(error);
      }
      send({ jsonrpc: "2.0", id: message.id, result });
      break;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}
