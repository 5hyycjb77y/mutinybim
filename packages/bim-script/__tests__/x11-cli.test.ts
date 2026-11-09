/**
 * @jest-environment node
 *
 * Round 11 lane X11: `mutinybim-script run | check | pack` over an in-memory
 * host (the kit opens no file and no connection itself).
 */
import { DEFAULT_SETTINGS, exampleFloorDrain, type BimElement, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { readPackageTar, type PackageCodec } from "@permitzip/bim-library";
import { gunzipSync, gzipSync } from "node:zlib";
import { defineScript, sliceModel, type ScriptDefinition } from "../src";
import { runCli, type CliIo } from "../src/cli";

const level = { id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement;
const model: ModelState = { modelId: "x11-cli", revision: 3 as Revision, elements: { L1: level }, connections: [], settings: DEFAULT_SETTINGS };
const drains = defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: { count: { type: "number", label: "How many", integer: true, default: 2, min: 1, max: 20 } },
  run(ctx, v) {
    for (let i = 0; i < v.count; i++) ctx.edit({ type: "place_part", partId: ctx.id("d"), typeId: "x11-drain", partType: exampleFloorDrain(), levelId: "L1", position: { x: i * 1000, y: 0 } });
  },
});
const NODE: PackageCodec = { gzip: async (b) => new Uint8Array(gzipSync(b)), gunzip: async (b) => new Uint8Array(gunzipSync(b)) };
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const PERSON = { provider: "test.identity", subject: "jlee", kind: "person", displayName: "J. Lee" };

function host(files: Map<string, Uint8Array>, loaded: ScriptDefinition): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    codec: NODE,
    readFile: async (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`no file ${p}`);
      return b;
    },
    writeFile: async (p, b) => void files.set(p, b),
    listFiles: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    loadScript: async () => loaded,
  };
}

describe("x11 mutinybim-script CLI", () => {
  it("runs a library script against a slice, checks the output, and packs a package", async () => {
    const files = new Map<string, Uint8Array>([
      ["slice.json", enc(sliceModel(model, drains.manifest.reads))],
      ["script.json", enc({ id: "acme.drains", revision: 1, key: "acme.drains", name: "Drains", version: "1.0.0", language: "typescript", kit: ">=0.1.0", manifest: drains.manifest, source: 'import { defineScript } from "@permitzip/bim-script";\n', license: "Apache-2.0", authors: [PERSON] })],
    ]);
    const io = host(files, drains);
    expect(await runCli(["run", "script.json", "--slice", "slice.json", "--values", '{"count":3}', "--out", "out.json"], io)).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(files.get("out.json"))) as { steps: number };
    expect(output.steps).toBe(3);
    expect(await runCli(["check", "out.json", "--slice", "slice.json"], io)).toBe(0);
    expect(JSON.parse(io.out[0] ?? "{}")).toMatchObject({ kind: "edits", ok: true });

    files.set("pkg/mutinybim.json", enc({ format: "mutinybim-package", formatVersion: 1, name: "@acme/drains", version: "1.0.0", license: "Apache-2.0", authors: [PERSON], requires: { kernelContract: ">=1.9.0" }, contents: [{ type: "script", id: "acme.drains", path: "scripts/acme.drains.json" }], rightsDeclaration: { basis: "own_work", statement: "Ours.", declaredBy: PERSON, declaredAt: "2026-11-02T00:00:00Z" } }));
    files.set("pkg/scripts/acme.drains.json", files.get("script.json") ?? new Uint8Array());
    files.set("pkg/LICENSE", enc("Apache-2.0"));
    expect(await runCli(["pack", "pkg"], io)).toBe(0);
    const tgz = files.get("acme-drains-1.0.0.tgz");
    expect(tgz).toBeDefined();
    const unpacked = readPackageTar(new Uint8Array(gunzipSync(tgz ?? new Uint8Array())));
    expect([...unpacked.keys()].sort()).toEqual(["LICENSE", "mutinybim.json", "scripts/acme.drains.json"]);
    expect(io.out.at(-1)).toMatch(/unsigned: a person signs it to publish/);
  });

  it("says what's wrong in words and exits non-zero", async () => {
    const io = host(new Map([["slice.json", enc(sliceModel(model, {}))]]), drains);
    expect(await runCli(["run", "missing.json", "--slice", "slice.json"], io)).toBe(1);
    expect(io.err[0]).toMatch(/no file missing.json/);
    expect(await runCli(["frobnicate"], io)).toBe(2);
    expect(io.err.at(-1)).toMatch(/^usage: mutinybim-script/);
  });
});
