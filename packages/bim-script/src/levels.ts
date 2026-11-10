import type { Level } from "@permitzip/bim-kernel";
import { ScriptRunError, type ScriptContext } from "./context";
import { ScriptReadError } from "./slice";
import { onWorkingIfAny } from "./working";

/**
 * A kit helper's level argument as the level's id. Kernel commands take a
 * level's id; the kit also takes the name of exactly one level the script
 * read (`reads.levels`), so "Level 2" works as well as its id. Anything else
 * is refused in words with the levels there are. A script that didn't read
 * the levels, or a context with no run behind it (a test's recorder), passes
 * its argument on unchanged: the kernel decides it.
 */
export function levelOf(ctx: ScriptContext, given: string, what = "The level"): string {
  if (!onWorkingIfAny(ctx, () => true)) return given;
  const direct = ctx.model.find(given);
  if (direct) {
    if (direct.kind === "level") return given;
    throw new ScriptRunError(`${what} "${given}" is a ${direct.kind}, not a level. A level argument is the level's id, or the name of exactly one level.`);
  }
  let levels: Level[];
  try {
    levels = ctx.model.levels().filter((l): l is Level => l.kind === "level");
  } catch (err) {
    if (err instanceof ScriptReadError) return given;
    throw err;
  }
  const want = given.trim().toLowerCase();
  const named = levels.filter((l) => l.name.trim().toLowerCase() === want);
  const [only] = named;
  if (named.length === 1 && only) return only.id;
  if (named.length > 1) throw new ScriptRunError(`${named.length} levels are named "${given}" (${named.map((l) => l.id).join(", ")}). Give the level's id.`);
  throw new ScriptRunError(`${what} "${given}" isn't a level here. A level argument is the level's id, or the name of exactly one level. The levels: ${levelList(levels)}.`);
}

function levelList(levels: readonly Level[]): string {
  if (levels.length === 0) return "none yet (make one with building.level)";
  const shown = levels.slice(0, 12).map((l) => `${l.id} ("${l.name}")`);
  return levels.length > shown.length ? `${shown.join(", ")} and ${levels.length - shown.length} more` : shown.join(", ");
}
