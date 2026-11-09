/**
 * @jest-environment node
 *
 * `FileLibraryProvider` against the `LibraryProvider` contract
 * (`runProviderConformance`, PROVIDER.md), plus the file behaviours the
 * suite can't see: folders, read-only files, refusing a bad file whole, line
 * numbers, and what a publish writes. A deliberately broken provider proves
 * the suite fails when the contract is broken.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AEC_LIBRARY,
  FileLibraryProvider,
  LibraryError,
  builtinLibraryBundle,
  builtinLibrarySource,
  contentHashOf,
  makeItem,
  runProviderConformance,
  type FileLibraryProviderOptions,
  type LibraryBundleInput,
  type LibraryFileSystem,
  type LibraryProvider,
} from "../src";
import { nodeLibraryFileSystem } from "../src/node-fs";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env = { formula: bimFormulaEngine, units: bimUnitsCatalog };

const keyOf = (item: unknown): unknown => (typeof item === "object" && item !== null && "key" in item ? item.key : undefined);

function memoryFs(files: Record<string, string>, opts: { readOnly?: boolean } = {}): LibraryFileSystem & { files: Record<string, string> } {
  return {
    files,
    readText: async (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
    listDir: async (dir) => Object.keys(files).filter((p) => path.dirname(p) === dir).map((p) => path.basename(p)),
    ...(opts.readOnly
      ? {}
      : {
          writeText: async (p: string, text: string) => {
            files[p] = text;
          },
        }),
  };
}

const firmFile: LibraryBundleInput = {
  format: "mutinybim-library",
  version: 1,
  id: "permitzip",
  name: "PermitZIP",
  publisher: "PermitZIP",
  revision: 1,
  fields: [
    { id: "firm-seismic", revision: 4, key: "seismic_restraint_required", label: "Seismic restraint required", appliesTo: ["mep.equipment"], valueType: "boolean", editable: true, storage: { kind: "parameter", scope: "instance", name: "seismic_restraint_required" } },
  ],
};

function provider(fs: LibraryFileSystem, extra: Partial<FileLibraryProviderOptions> = {}): FileLibraryProvider {
  return new FileLibraryProvider({
    env,
    fs,
    sources: [{ scope: { id: "firm:permitzip", kind: "firm", name: "PermitZIP" }, kind: "folder", path: "/lib/firm" }, builtinLibrarySource()],
    ...extra,
  });
}

describe("FileLibraryProvider conformance", () => {
  it("passes the provider conformance suite with a writable firm folder over the built-in library", async () => {
    const fs = memoryFs({ "/lib/firm/permitzip.mutinylib.json": JSON.stringify(firmFile, null, 2) });
    const report = await runProviderConformance({ provider: provider(fs), writableScope: "firm:permitzip", readOnlyScope: "builtin" });
    expect(report.failures).toEqual([]);
    expect(report.checks.length).toBeGreaterThanOrEqual(12);
    // The published items landed in the folder as a library file.
    const published = Object.keys(fs.files).find((p) => p.endsWith("-published.mutinylib.json"));
    expect(published).toBeDefined();
  });

  it("passes as a read-only provider (no file system writes)", async () => {
    const fs = memoryFs({ "/lib/firm/permitzip.mutinylib.json": JSON.stringify(firmFile) }, { readOnly: true });
    const p = provider(fs);
    const report = await runProviderConformance({ provider: p });
    expect(report.failures).toEqual([]);
    expect(await p.capabilities("firm:permitzip")).toEqual({ read: true, publish: false, reason: "The folder /lib/firm can't be written to." });
  });

  it("fails a provider that breaks the contract", async () => {
    const good = provider(memoryFs({ "/lib/firm/permitzip.mutinylib.json": JSON.stringify(firmFile) }));
    const broken: LibraryProvider = {
      scopes: () => good.scopes(),
      list: (scope, q) => good.list(scope, q),
      capabilities: (scope) => good.capabilities(scope),
      // Edits content after hashing, and turns "not found" into a generic error.
      async get(id, revision) {
        try {
          const item = await good.get(id, revision);
          return { ...makeItem(item.type, { ...item.body, description: "changed after hashing" }), scope: item.scope };
        } catch {
          throw new Error("nope");
        }
      },
      publish: async () => ({ ok: true, summary: { id: "x", type: "field", key: "x", name: "x", revision: 7, contentHash: "", scope: "firm:permitzip", deprecated: false } }),
    };
    const report = await runProviderConformance({ provider: broken, writableScope: "firm:permitzip" });
    const failed = report.failures.map((f) => f.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        "firm:permitzip: every listed item reads back with a matching revision and content hash",
        "an unknown item id is refused as not found",
        "firm:permitzip: publishing a new item from revision 0 stores revision 1",
      ]),
    );
  });
});

describe("FileLibraryProvider files", () => {
  it("refuses to load when any file is bad, naming the file, the item and its line", async () => {
    const bad = { ...firmFile, fields: [{ ...firmFile.fields?.[0], unit: "psi" }] };
    const text = JSON.stringify(bad, null, 2);
    const p = provider(memoryFs({ "/lib/firm/permitzip.mutinylib.json": text }));
    await expect(p.scopes()).rejects.toThrow(LibraryError);
    try {
      await p.scopes();
    } catch (err) {
      if (!(err instanceof LibraryError)) throw err;
      expect(err.code).toBe("invalid");
      expect(err.problems).toEqual([
        expect.objectContaining({
          itemId: "firm-seismic",
          line: text.split("\n").findIndex((l) => l.includes('"id": "firm-seismic"')) + 1,
          message: "/lib/firm/permitzip.mutinylib.json: Field seismic_restraint_required (library item firm-seismic@4) is boolean, so it can't carry a kind or unit.",
        }),
      ]);
    }
  });

  it("checks a project library against the firm library below it", async () => {
    const project: LibraryBundleInput = {
      format: "mutinybim-library",
      version: 1,
      id: "p7301",
      name: "7301",
      publisher: "PermitZIP",
      revision: 1,
      formulas: [
        {
          id: "calc-gas",
          revision: 1,
          key: "P7301.Demand",
          name: "Demand",
          expression: "mbh * 0.8",
          params: [{ name: "mbh", type: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" } }],
          result: { valueType: "quantity", kind: "flow_gas_energy", unit: "MBH" },
          appliesTo: ["mep.water_heater"],
          examples: [{ inputs: { mbh: { value: 100, unit: "MBH" } }, expected: { value: 80, unit: "MBH" } }],
        },
      ],
    };
    const fs = memoryFs({ "/lib/firm/permitzip.mutinylib.json": JSON.stringify(firmFile), "/lib/p7301.mutinylib.json": JSON.stringify(project) });
    const p = new FileLibraryProvider({
      env,
      fs,
      sources: [
        { scope: { id: "project:7301", kind: "project", name: "7301" }, kind: "file", path: "/lib/p7301.mutinylib.json" },
        { scope: { id: "firm:permitzip", kind: "firm", name: "PermitZIP" }, kind: "folder", path: "/lib/firm" },
        builtinLibrarySource(),
      ],
    });
    const { resolved, registry } = await p.resolved();
    expect(resolved.byKey("formula", "P7301.Demand")?.scope).toBe("project:7301");
    expect(registry.fieldsFor("mep.water_heater").map((f) => f.path)).toContain("seismic_restraint_required");

    // Without the built-in layer the project's water heater class doesn't exist, so it is refused.
    const alone = new FileLibraryProvider({ env, fs, sources: [{ scope: { id: "project:7301", kind: "project", name: "7301" }, kind: "file", path: "/lib/p7301.mutinylib.json" }] });
    await expect(alone.scopes()).rejects.toThrow("applies to class mep.water_heater, which does not exist");
  });

  it("refuses a publish that would break a library above it, and changes nothing", async () => {
    const project: LibraryBundleInput = {
      format: "mutinybim-library",
      version: 1,
      id: "p1",
      name: "P",
      publisher: "P",
      revision: 1,
      fields: [{ id: "proj-note", revision: 1, key: "install_note", label: "Install note", appliesTo: ["fp.custom_head"], valueType: "text", editable: true, storage: { kind: "parameter", scope: "instance", name: "install_note" } }],
    };
    const firm: LibraryBundleInput = { ...firmFile, classes: [{ id: "firm-head", revision: 1, key: "fp.custom_head", label: "Custom heads", discipline: "fire_protection" }] };
    const fs = memoryFs({ "/lib/firm/permitzip.mutinylib.json": JSON.stringify(firm), "/lib/p.mutinylib.json": JSON.stringify(project) });
    const p = new FileLibraryProvider({
      env,
      fs,
      sources: [{ scope: { id: "project:1", kind: "project", name: "P" }, kind: "file", path: "/lib/p.mutinylib.json" }, { scope: { id: "firm:permitzip", kind: "firm", name: "PermitZIP" }, kind: "folder", path: "/lib/firm" }, builtinLibrarySource()],
    });
    const head = await p.get("firm-head");
    const before = fs.files["/lib/firm/permitzip.mutinylib.json"];
    // Renaming the class's key out from under the project's field.
    if (head.type !== "class") throw new Error("expected a class");
    const renamed = makeItem("class", { ...head.body, key: "fp.renamed_head" });
    const result = await p.publish("firm:permitzip", renamed, 1);
    expect(result).toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("applies to class fp.custom_head, which does not exist") });
    expect(fs.files["/lib/firm/permitzip.mutinylib.json"]).toBe(before);
    expect((await p.get("firm-head")).body.revision).toBe(1);
    expect(await p.list("firm:permitzip", { type: "class" })).toHaveLength(1);
  });

  it("writes a publish back to the file it came from, readable by a fresh provider", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mutinylib-"));
    try {
      const file = path.join(dir, "firm.mutinylib.json");
      await writeFile(file, JSON.stringify(firmFile, null, 2));
      const sources: FileLibraryProviderOptions["sources"] = [{ scope: { id: "firm:permitzip", kind: "firm", name: "PermitZIP" }, kind: "file", path: file }, builtinLibrarySource()];
      const p = new FileLibraryProvider({ env, fs: nodeLibraryFileSystem(), sources });
      const current = await p.get("firm-seismic");
      expect(current.body.revision).toBe(4);
      if (current.type !== "field") throw new Error("expected a field");
      const edited = makeItem("field", { ...current.body, label: "Seismic restraint" });
      const result = await p.publish("firm:permitzip", edited, 4);
      expect(result).toMatchObject({ ok: true, summary: { revision: 5, name: "Seismic restraint" } });

      const onDisk = JSON.parse(await readFile(file, "utf8")) as { fields: { revision: number; contentHash: string; label: string }[] };
      expect(onDisk.fields[0]).toMatchObject({ revision: 5, label: "Seismic restraint" });
      const fresh = new FileLibraryProvider({ env, fs: nodeLibraryFileSystem(), sources });
      const reread = await fresh.get("firm-seismic");
      expect(reread.body.contentHash).toBe(contentHashOf(reread));
      expect(reread.body.contentHash).toBe(result.ok ? result.summary.contentHash : "");
      expect(await fresh.exportScope("builtin")).toContain('"mep.water_heater"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves the built-in library read-only, with a reason", async () => {
    const p = new FileLibraryProvider({ env, sources: [builtinLibrarySource()] });
    expect(await p.capabilities("builtin")).toEqual({ read: true, publish: false, reason: "Built-in is built in and can't be changed. Save a copy to your firm's library instead." });
    const classes = await p.list("builtin", { type: "class" });
    expect(classes.map((c) => c.key)).toEqual((builtinLibraryBundle().classes ?? []).map(keyOf));
    // The kernel's own rows come first; Structural's footing joins from its add-on, not from the kernel's list.
    const own = (AEC_LIBRARY.classes ?? []).map((c) => c.key);
    expect(classes.map((c) => c.key).slice(0, own.length)).toEqual(own);
    expect(own).not.toContain("struct.footing");
    expect(classes.map((c) => c.key)).toContain("struct.footing");
    await expect(p.get("missing")).rejects.toMatchObject({ code: "not_found" });
  });
});
