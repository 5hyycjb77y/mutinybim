/**
 * One script run, in its own process (bundled with the kit into
 * `script-child.cjs`). Started by the supervisor with `childNodeArgs`: the
 * permission model lets it read only this file, so the kit and the script
 * live in this bundle and the request arrives on stdin.
 *
 * The script's source is evaluated in a fresh `vm` context that holds only the
 * kit's exports: no `require`, `process`, `fetch` or dynamic `import`. That is
 * a convenience layer, not the boundary; the boundary is this process's
 * permissions and caps and the sandbox's deny-all network.
 */
import * as kit from "@permitzip/bim-script";
import { stripTypeScriptTypes } from "node:module";
import { getHeapStatistics } from "node:v8";
import { runInNewContext } from "node:vm";
import { NEVER_FINISHED_WORDS, UNAWAITED_WORDS, type ChildLine } from "./protocol";

const KIT_MODULE = "@permitzip/bim-script";

function say(line: ChildLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** A script module as a plain script: the kit import bound to the kit, `export default` to a slot. */
export function scriptAsPlainCode(source: string): string {
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const importRe = new RegExp(String.raw`^[ \t]*import\s+([^;]*?)\s+from\s+["']${KIT_MODULE.replace("/", "\\/")}["'];?`, "gm");
  const bound = stripped.replace(importRe, (all: string, clause: string) => `${bindKit(clause)}${"\n".repeat(all.split("\n").length - 1)}`);
  return bound.replace(/^([ \t]*)export\s+default\s+/m, "$1__exports.default = ").replace(/^([ \t]*)export\s+(?=(?:const|let|var|function|class|async)\b)/gm, "$1");
}

/** One kit import as a binding to the kit (kept on one line, so the script's lines don't move). */
function bindKit(clause: string): string {
  const c = clause.trim();
  const star = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(c);
  if (star) return `const ${star[1]} = __kit;`;
  const named = /^\{([^}]*)\}$/.exec(c);
  if (!named) throw new Error(`The script imports ${KIT_MODULE} as "${c}"; import its names in braces (import { defineScript } from "@permitzip/bim-script").`);
  const names = (named[1] ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((n) => n.replace(/\s+as\s+/, ": "));
  return `const { ${names.join(", ")} } = __kit;`;
}

function isDefinition(value: unknown): value is kit.ScriptDefinition {
  return typeof value === "object" && value !== null && "manifest" in value && "runWith" in value && typeof (value as { runWith: unknown }).runWith === "function";
}

async function runOnce(raw: string): Promise<ChildLine> {
  const request: unknown = JSON.parse(raw);
  if (typeof request !== "object" || request === null) throw new Error("The run request isn't an object.");
  const { source, scriptHash, values, slice } = request as { source?: unknown; scriptHash?: unknown; values?: unknown; slice?: unknown };
  if (typeof source !== "string" || typeof scriptHash !== "string") throw new Error("The run request needs source and scriptHash.");
  const parsedSlice = kit.modelSliceSchema.safeParse(slice);
  if (!parsedSlice.success) throw new Error(`The run request's slice isn't a model slice: ${parsedSlice.error.issues.map((i) => `${i.path.join(".") || "(top)"} ${i.message}`).join("; ")}.`);
  const addOns = parsedSlice.data.addOns;
  // The add-ons load only for a run whose slice names them: a run with none starts without their code in the heap the cap limits.
  const packs = addOns ? (await import("./addons")).installRunAddOns(addOns) : undefined;
  const exportsSlot: { default?: unknown } = {};
  runInNewContext(scriptAsPlainCode(source), { __kit: kit, __exports: exportsSlot }, { filename: "script.ts" });
  const definition = exportsSlot.default;
  if (!isDefinition(definition)) throw new Error("The script's default export isn't defineScript(...).");
  // A part script makes no edits, so no add-on decides it; every other kind's edits are decided under the model's add-ons.
  if (!addOns && definition.manifest.kind !== "part") throw new Error("The run request doesn't say which add-ons the model uses, so the script's edits can't be decided as the model server would. The host sending it needs the current MutinyBIM version.");
  const given = typeof values === "object" && values !== null ? (values as Record<string, string | number | boolean>) : {};
  const resolved = kit.resolveValues(definition.manifest, given);
  const output = await kit.runScript(definition, { slice: parsedSlice.data as kit.ModelSlice, values: resolved, scriptHash, ...(packs ? { packs } : {}) });
  return { ok: true, output, manifest: definition.manifest };
}

/**
 * "Line 12: " for an error raised while the script's own code was on the
 * stack (type stripping keeps every line where it was), else "".
 */
export function scriptLineOf(err: unknown): string {
  const at = /\bscript\.ts:(\d+)(?::\d+)?/.exec(errorField(err, "stack"));
  return at ? `Line ${at[1]}: ` : "";
}

/** A field of an error from any realm: the script's errors come from its own context's Error. */
function errorField(err: unknown, field: "message" | "stack"): string {
  const value = typeof err === "object" && err !== null ? Reflect.get(err, field) : undefined;
  return typeof value === "string" ? value : "";
}

export function scriptErrorWords(err: unknown): string {
  return `${scriptLineOf(err)}${errorField(err, "message") || String(err)}`;
}

function main(): void {
  say({ ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / 1048576 });
  let raw = "";
  let answered = false;
  /** One answer per run: whichever comes first. */
  const answer = (line: ChildLine): void => {
    if (answered) return;
    answered = true;
    say(line);
  };
  // A promise the script made and didn't await was rejected: Node would end this process with no answer, and the host could only call that a machine fault.
  process.on("unhandledRejection", (err: unknown) => {
    answer({ ok: false, message: `${scriptErrorWords(err)} ${UNAWAITED_WORDS}` });
  });
  // Nothing left to wait for and still no answer: say why instead of exiting silently.
  process.on("beforeExit", () => {
    answer({ ok: false, message: NEVER_FINISHED_WORDS });
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    raw += chunk;
  });
  process.stdin.on("end", () => {
    runOnce(raw)
      .then(answer)
      .catch((err: unknown) => {
        answer({ ok: false, message: scriptErrorWords(err) });
      });
  });
}

// Run as the bundled CommonJS entry only; an ES module import has no `require`.
if (typeof require !== "undefined" && require.main === module) main();
