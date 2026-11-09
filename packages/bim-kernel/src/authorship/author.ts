import type { Actor } from "../changeset";
import { AuthorshipWriteError, type AuthorRef, type AuthorshipRead } from "./types";

/** A provider id: lower case, dots, colons or dashes between parts ("host", "acme.oidc"). */
export const PROVIDER_ID = /^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;
const MAX_PROVIDER = 64;
const MAX_SUBJECT = 256;
const MAX_NAME = 120;
const MAX_KEY_ID = 512;

/**
 * The agent subject grammar the model server already uses for agent actors
 * (`agent:<personSubject>:<runId>`, packages/bim-sync agent-principal).
 */
const AGENT_PREFIX = "agent:";
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** The person and run an agent subject names, or null when it isn't one. */
export function parseAgentSubject(subject: string): { readonly personSubject: string; readonly runId: string } | null {
  if (!subject.startsWith(AGENT_PREFIX)) return null;
  const rest = subject.slice(AGENT_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const runId = rest.slice(sep + 1);
  return RUN_ID.test(runId) ? { personSubject: rest.slice(0, sep), runId } : null;
}

/** An agent acting for `person` in one run. */
export function agentAuthor(person: AuthorRef, runId: string, displayName?: string): AuthorRef {
  if (person.kind !== "person") throw new AuthorshipWriteError("An agent acts for a person, not for another agent.");
  if (!RUN_ID.test(runId)) throw new AuthorshipWriteError(`Agent run id "${runId}" must be 1-80 letters, digits, dot, dash or underscore.`);
  return {
    provider: person.provider,
    subject: `${AGENT_PREFIX}${person.subject}:${runId}`,
    kind: "agent",
    ...(displayName ? { displayName: displayName.slice(0, MAX_NAME) } : {}),
    onBehalfOf: person,
  };
}

/**
 * The author a changeset actor stands for, under the provider the actor
 * names, or else the one the session authorized it with. An agent actor
 * names its person in its id; an agent id that names no one comes back with
 * no `onBehalfOf`, which every writer refuses.
 */
export function authorFromActor(actor: Actor, sessionProvider: string): AuthorRef {
  const provider = actor.provider ?? sessionProvider;
  if (actor.kind === "human") return { provider, subject: actor.id, kind: "person", displayName: actor.name };
  const parsed = parseAgentSubject(actor.id);
  return {
    provider,
    subject: actor.id,
    kind: "agent",
    displayName: actor.name,
    ...(parsed ? { onBehalfOf: { provider, subject: parsed.personSubject, kind: "person" } } : {}),
  };
}

/** Whether two refs name the same author (provider and subject; names and keys don't count). */
export function sameAuthor(a: AuthorRef, b: AuthorRef): boolean {
  return a.provider === b.provider && a.subject === b.subject;
}

/** How to name an author in a sentence. */
export function authorWords(a: AuthorRef): string {
  const name = a.displayName ?? a.subject;
  if (a.kind === "agent") return a.onBehalfOf ? `${name} (agent for ${a.onBehalfOf.displayName ?? a.onBehalfOf.subject})` : `${name} (agent)`;
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRef(value: unknown, depth: number, notes: string[]): AuthorshipRead<AuthorRef> {
  if (!isRecord(value)) return { ok: false, reason: "An author must be an object with a provider and a subject." };
  const { provider, subject, kind, displayName, keyId, onBehalfOf } = value;
  if (typeof provider !== "string" || provider.length === 0) return { ok: false, reason: "An author has no identity provider." };
  if (typeof subject !== "string" || subject.length === 0) return { ok: false, reason: "An author has no subject (the provider's id for them)." };
  if (typeof kind !== "string" || kind.length === 0) return { ok: false, reason: `Author ${subject} doesn't say whether it is a person or an agent.` };
  if (kind !== "person" && kind !== "agent") notes.push(`Author ${subject} is a "${kind}", which this release doesn't know; it is shown but can never sign.`);
  if (!PROVIDER_ID.test(provider)) notes.push(`Author ${subject} names provider "${provider}", which isn't a well-formed provider id.`);
  let behalf: AuthorRef | undefined;
  if (onBehalfOf !== undefined) {
    if (depth > 0) return { ok: false, reason: `Author ${subject} acts for someone who acts for someone else; an agent acts for a person directly.` };
    const read = readRef(onBehalfOf, depth + 1, notes);
    if (!read.ok) return read;
    behalf = read.value;
  }
  return {
    ok: true,
    notes,
    value: {
      provider,
      subject,
      kind,
      ...(typeof displayName === "string" ? { displayName } : {}),
      ...(typeof keyId === "string" ? { keyId } : {}),
      ...(behalf ? { onBehalfOf: behalf } : {}),
    },
  };
}

/** Tolerant reader: keeps unknown providers and kinds (with a note); refuses only what can't name an author. */
export function readAuthorRef(value: unknown): AuthorshipRead<AuthorRef> {
  return readRef(value, 0, []);
}

/** The wire form of an author: a plain object. */
export type AuthorRefJson = {
  provider: string;
  subject: string;
  kind: "person" | "agent";
  displayName?: string;
  keyId?: string;
  onBehalfOf?: AuthorRefJson;
};

/**
 * Strict writer. Refuses an unknown kind, a malformed provider id, an agent
 * that names no person, an agent acting for an agent, and a person "on
 * behalf of" anyone.
 */
export function writeAuthorRef(ref: AuthorRef): AuthorRefJson {
  const who = ref.displayName ?? ref.subject;
  if (!PROVIDER_ID.test(ref.provider) || ref.provider.length > MAX_PROVIDER) throw new AuthorshipWriteError(`"${ref.provider}" isn't a provider id (lower case letters, digits, and . : - between parts, at most ${MAX_PROVIDER}).`);
  if (ref.subject.length === 0 || ref.subject.length > MAX_SUBJECT) throw new AuthorshipWriteError(`An author's subject must be 1-${MAX_SUBJECT} characters.`);
  if (ref.kind !== "person" && ref.kind !== "agent") throw new AuthorshipWriteError(`Author ${who} is a "${ref.kind}"; only a person or an agent can be written.`);
  if (ref.displayName !== undefined && (ref.displayName.length === 0 || ref.displayName.length > MAX_NAME)) throw new AuthorshipWriteError(`Author ${ref.subject}'s name must be 1-${MAX_NAME} characters.`);
  if (ref.keyId !== undefined && (ref.keyId.length === 0 || ref.keyId.length > MAX_KEY_ID)) throw new AuthorshipWriteError(`Author ${who}'s key id must be 1-${MAX_KEY_ID} characters.`);
  let behalf: AuthorRefJson | undefined;
  if (ref.kind === "person") {
    if (ref.onBehalfOf) throw new AuthorshipWriteError(`${who} is a person; only an agent acts on behalf of someone.`);
  } else {
    if (!ref.onBehalfOf) throw new AuthorshipWriteError(`Agent ${who} doesn't name the person it acted for. An agent's act must carry that person.`);
    if (ref.onBehalfOf.kind !== "person" || ref.onBehalfOf.onBehalfOf) throw new AuthorshipWriteError(`Agent ${who} must act for a person directly, not for another agent.`);
    behalf = writeAuthorRef(ref.onBehalfOf);
  }
  return {
    provider: ref.provider,
    subject: ref.subject,
    kind: ref.kind === "person" ? "person" : "agent",
    ...(ref.displayName !== undefined ? { displayName: ref.displayName } : {}),
    ...(ref.keyId !== undefined ? { keyId: ref.keyId } : {}),
    ...(behalf ? { onBehalfOf: behalf } : {}),
  };
}
