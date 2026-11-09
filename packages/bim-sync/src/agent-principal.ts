import { parseAgentSubject, type Actor } from "@permitzip/bim-kernel";

/**
 * An agent always acts on behalf of one signed-in person. Its actor id names
 * that person and the agent run, so the authority can bind the agent to the
 * verified login and still tell the agent's edits apart from the person's own
 * (an agent's edit conflicts with its person's concurrent edit like anyone else's).
 *
 *   agent:<userId>:<runId>
 *
 * The grammar is the kernel's (`parseAgentSubject`, authorship), so the model
 * server and every author record read it the same way.
 */
const AGENT_PREFIX = "agent:";
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function agentActorId(userId: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`Agent run id "${runId}" must be 1-80 letters, digits, dot, dash or underscore`);
  return `${AGENT_PREFIX}${userId}:${runId}`;
}

export function agentActor(userId: string, runId: string, name: string): Actor {
  return { id: agentActorId(userId, runId), name: name.slice(0, 80) || "Agent", kind: "agent" };
}

/** The person an agent actor id acts for, or null when the id is not an agent id. */
export function agentOnBehalfOf(actorId: string): string | null {
  return parseAgentSubject(actorId)?.personSubject ?? null;
}

export type PrincipalDecision =
  | { readonly ok: true; readonly actorId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Which actor id a verified login may use: its own id (a person, or an agent
 * account signed in as itself), or an agent id bound to that same person.
 * An actor that names an identity provider must name the session's: a login
 * from one provider never edits as another provider's person.
 */
export function principalFor(actor: Actor, verifiedUserId: string, sessionProvider?: string): PrincipalDecision {
  if (actor.provider !== undefined && actor.provider !== sessionProvider) return { ok: false, reason: "You can only edit as yourself (this login is from a different sign-in system)" };
  if (actor.id === verifiedUserId) return { ok: true, actorId: verifiedUserId };
  const onBehalfOf = agentOnBehalfOf(actor.id);
  if (actor.kind === "human" || onBehalfOf === null) return { ok: false, reason: "You can only edit as yourself" };
  if (onBehalfOf !== verifiedUserId) return { ok: false, reason: "An agent can only act for the person who signed it in" };
  return { ok: true, actorId: actor.id };
}
