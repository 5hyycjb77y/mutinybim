import type { Interest } from "@permitzip/bim-kernel";
import type { AgentSession } from "@permitzip/bim-sync";
import { failure } from "./answers";
import { resolveAreaLevel } from "./level-ref";

/** The areas an agent loads: one level (and one zone of it), or the whole model. */
export function interestOf(level: string | undefined, zone: string | undefined): Interest | undefined {
  return level ? { areas: [{ level, ...(zone ? { zone } : {}) }] } : undefined;
}

type AreaStep<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "reload"; readonly name: string } | { readonly kind: "refused"; readonly message: string };

/** Opens a session on the areas asked for, runs `work`, closes it. */
export type SessionOpener = <T>(interest: Interest | undefined, work: (session: AgentSession) => Promise<T>) => Promise<T>;

/**
 * A session loaded with the area an agent named. The level may be its id or
 * a loose name (resolveAreaLevel): the area loads under the level's canonical
 * name, which `work` receives for filters. Levels are in every slice, so the
 * first open resolves the name; a second open loads the area when the name
 * given wasn't already the canonical one. An unknown level refuses with the
 * candidates instead of loading nothing.
 */
export async function withAreaSessionVia<T>(open: SessionOpener, area: { level?: string; zone?: string }, work: (session: AgentSession, level: string | undefined) => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  const ref = area.level;
  if (!ref) return open(undefined, (s) => work(s, undefined));
  const step = await open(interestOf(ref, area.zone), async (s): Promise<AreaStep<T>> => {
    const level = resolveAreaLevel(s.model(), ref);
    if (!level.ok) return { kind: "refused", message: level.message };
    if (level.name !== ref) return { kind: "reload", name: level.name };
    return { kind: "done", value: await work(s, level.name) };
  });
  if (step.kind === "done") return step.value;
  if (step.kind === "refused") return failure(step.message);
  return open(interestOf(step.name, area.zone), (s) => work(s, step.name));
}
