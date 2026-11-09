import { assemblePackage, contentHashOf, makeItem, markRegistryVersion, packPackageTgz, parseItem, publishToRegistry, type PackageCodec, type RegistryStore } from "@permitzip/bim-library";
import { checkScriptOutput } from "./check";
import { runScript } from "./context";
import { resolveValues, type ScriptDefinition } from "./define";
import { modelSliceSchema, sliceAsModel, type ModelSlice } from "./slice";

/**
 * `mutinybim-script run | check | pack` (SCRIPTING-PROPOSAL §5.1), for
 * outside harnesses and CI: run a library script against a downloaded
 * slice, check an output, build a package. The host process gives file
 * access and the TypeScript loader (the kit never opens files or the
 * network itself); a Node bin wraps this with `node:fs` and a loader.
 *
 *   run   <script.json> --slice <slice.json> [--values '<json>'] [--preset <id>] [--out <output.json>]
 *   check <output.json> --slice <slice.json>
 *   pack  <dir> [--out <file.tgz>]    (dir holds mutinybim.json with contents listed, hashes left out)
 *   publish <file.tgz> --registry <dir> [--name <registry name>]   (a signed package into a static registry folder)
 *   yank | unyank <@scope/name> <version> --registry <dir> [--reason <words>]
 *
 * A registry folder is plain files (registry.json, index/, packages/): serve
 * it from a bucket, GitHub Pages or a company file server.
 */

export interface CliIo {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Every file under a directory, as paths relative to it (forward slashes). */
  listFiles(dir: string): Promise<string[]>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Loads a script module's source into its definition (the host's TypeScript loader, in the host's own sandbox). */
  loadScript(source: string): Promise<ScriptDefinition>;
  readonly codec?: PackageCodec;
  /** A file's bytes, or null when there is no such file (publish reads a registry folder that may be new). */
  readFileIfExists?(path: string): Promise<Uint8Array | null>;
  /** The time a publish or yank is stamped with; absent: now. */
  now?(): string;
}

const USAGE = "usage: mutinybim-script run <script.json> --slice <slice.json> [--values <json>] [--preset <id>] [--out <file>] | check <output.json> --slice <slice.json> | pack <dir> [--out <file.tgz>] | publish <file.tgz> --registry <dir> [--name <registry name>] | yank|unyank <@scope/name> <version> --registry <dir> [--reason <words>]";

function flags(args: readonly string[]): { positional: string[]; named: Map<string, string> } {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a.startsWith("--")) {
      named.set(a.slice(2), args[i + 1] ?? "");
      i++;
    } else positional.push(a);
  }
  return { positional, named };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const jsonBytes = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

async function readSlice(io: CliIo, path: string | undefined): Promise<ModelSlice> {
  if (!path) throw new Error("--slice <slice.json> is required.");
  const parsed = modelSliceSchema.safeParse(JSON.parse(text(await io.readFile(path))));
  if (!parsed.success) throw new Error(`${path} isn't a model slice: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
  return parsed.data;
}

/** A registry folder through the host's files. */
function registryFolder(io: CliIo, dir: string | undefined): RegistryStore {
  if (!dir) throw new Error("--registry <dir> is required: the folder the registry's files live in.");
  const read = io.readFileIfExists?.bind(io);
  if (!read) throw new Error("This host can't publish: it can't tell a missing registry file from an unreadable one.");
  const at = (p: string) => `${dir.replace(/\/+$/, "")}/${p}`;
  return {
    getText: async (p) => {
      const bytes = await read(at(p));
      return bytes ? text(bytes) : null;
    },
    getBytes: (p) => read(at(p)),
    put: (p, bytes) => io.writeFile(at(p), bytes),
  };
}

const stamp = (io: CliIo) => (io.now ? io.now() : new Date().toISOString());

/** Runs one CLI command; resolves with the exit code. Errors are written to stderr in words. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, named } = flags(rest);
  try {
    if (command === "run") {
      const path = positional[0];
      if (!path) throw new Error(USAGE);
      const parsed = parseItem({ type: "script", body: JSON.parse(text(await io.readFile(path))) });
      if (!parsed.ok || parsed.item.type !== "script") throw new Error(`${path} isn't a library script item.`);
      const script = parsed.item.body;
      const definition = await io.loadScript(script.source);
      const values = resolveValues(definition.manifest, named.has("values") ? (JSON.parse(named.get("values") ?? "{}") as Record<string, string | number | boolean>) : {}, named.get("preset"));
      const output = await runScript(definition, { slice: await readSlice(io, named.get("slice")), values, scriptHash: contentHashOf(makeItem("script", script)) });
      const out = named.get("out");
      if (out) await io.writeFile(out, jsonBytes(output));
      else io.stdout(JSON.stringify(output));
      return 0;
    }
    if (command === "check") {
      const path = positional[0];
      if (!path) throw new Error(USAGE);
      const slice = await readSlice(io, named.get("slice"));
      const report = checkScriptOutput(sliceAsModel(slice), JSON.parse(text(await io.readFile(path))), { features: slice.features });
      io.stdout(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    if (command === "pack") {
      const dir = positional[0];
      if (!dir) throw new Error(USAGE);
      const files = new Map<string, Uint8Array>();
      for (const rel of await io.listFiles(dir)) files.set(rel, await io.readFile(`${dir}/${rel}`));
      const draft = files.get("mutinybim.json");
      if (!draft) throw new Error(`${dir} has no mutinybim.json.`);
      const assembled = assemblePackage(JSON.parse(text(draft)), files);
      const manifest = JSON.parse(text(assembled.get("mutinybim.json") ?? new Uint8Array())) as { name: string; version: string };
      const out = named.get("out") ?? `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
      await io.writeFile(out, await packPackageTgz(assembled, io.codec));
      io.stdout(`Packed ${manifest.name} ${manifest.version} → ${out} (unsigned: a person signs it to publish).`);
      return 0;
    }
    if (command === "publish") {
      const file = positional[0];
      if (!file) throw new Error(USAGE);
      const dir = named.get("registry");
      const registryName = named.get("name") || "MutinyBIM scripts";
      const result = await publishToRegistry(registryFolder(io, dir), await io.readFile(file), { now: () => stamp(io), registryName, ...(io.codec ? { codec: io.codec } : {}) });
      io.stdout(
        result.status === "published"
          ? `Published ${result.name} ${result.version} to ${dir} (${result.signatures} signature${result.signatures === 1 ? "" : "s"}, ${result.digest}). Serve the folder as it is.`
          : `${result.name} ${result.version} is already in ${dir} with these exact contents; nothing changed.`,
      );
      return 0;
    }
    if (command === "yank" || command === "unyank") {
      const [name, version] = positional;
      if (!name || !version) throw new Error(USAGE);
      const dir = named.get("registry");
      const reason = named.get("reason");
      await markRegistryVersion(registryFolder(io, dir), name, version, command, { now: () => stamp(io), registryName: dir ?? "the registry", ...(reason ? { reason } : {}) });
      io.stdout(command === "yank" ? `Yanked ${name} ${version}: projects that pinned it keep it, with a warning; new installs skip it.` : `${name} ${version} is offered again.`);
      return 0;
    }
    io.stderr(USAGE);
    return 2;
  } catch (err) {
    console.error("[mutinybim-script] command failed", { command, err });
    io.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
