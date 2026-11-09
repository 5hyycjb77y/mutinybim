// Web APIs jsdom leaves out; every runtime MutinyBIM targets has them natively.
const { TextEncoder, TextDecoder } = require("node:util");
const { ReadableStream, TransformStream, WritableStream } = require("node:stream/web");
const { MessageChannel, MessagePort } = require("node:worker_threads");
const nodeCrypto = require("node:crypto");

if (typeof globalThis.crypto === "undefined") globalThis.crypto = nodeCrypto.webcrypto;
if (typeof globalThis.crypto.randomUUID !== "function") {
  Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: () => nodeCrypto.randomUUID() });
}
if (typeof globalThis.crypto.subtle === "undefined") {
  Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: nodeCrypto.webcrypto.subtle });
}
for (const [name, value] of Object.entries({ TextEncoder, TextDecoder, ReadableStream, TransformStream, WritableStream, MessageChannel, MessagePort })) {
  if (typeof globalThis[name] === "undefined") globalThis[name] = value;
}
if (typeof globalThis.structuredClone === "undefined") globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
