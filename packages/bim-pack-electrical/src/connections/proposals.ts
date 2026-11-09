import { executeCommand, type Command, paramValue, type BimElement, type ElementId, type ModelState, type PartInstance, linkServing, linksFedFrom, serviceLinkName } from "@permitzip/bim-kernel";
import { existingPhaseOf } from "./panel";
import { distributionOf, electricalConnectorIds, electricalName } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Proposals from the free text people typed before links existed: a
 * device's `circuit` ("L1-3", "HP1-43,45") and a panel's `fed_from`
 * ("MDP", "T1"). Each proposal is the command that would make the link,
 * checked against the model, for the engineer to confirm one by one. Nothing
 * here commits anything, and membership is exactly what the text says:
 * devices whose text names the same panel and circuit numbers are proposed
 * together because the engineer wrote the same circuit on each of them, never
 * because of where they are (internal design note). An existing circuit on a
 * renovation takes no new loads from here: new loads go on new circuits.
 */

export type ProposalStatus = "ready" | "refused" | "unmatched" | "ambiguous";

export interface ProposalMember {
  readonly elementId: ElementId;
  readonly name: string;
  readonly connector: string;
  /** The text the proposal was read from. */
  readonly text: string;
}

export interface LinkProposal {
  /** Stable for the same model text: "branch:<panel>:<positions>", "feeder:<equipment>", "text:<element>". */
  readonly id: string;
  readonly role: "branch" | "feeder";
  readonly status: ProposalStatus;
  readonly sourceId: ElementId | null;
  readonly sourceName: string | null;
  readonly positions: readonly number[];
  readonly members: readonly ProposalMember[];
  /** In plain words: what would be made, or why nothing can be. */
  readonly reason: string;
  /** The command to run once the engineer confirms (null unless ready). */
  readonly command: Command | null;
}

const norm = (s: string) => s.toUpperCase().replace(/[\s_]+/g, "");

function textParam(elements: Elements, part: PartInstance, name: string): string | null {
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return null;
  const v = paramValue(type.definition, part.values, name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

interface Named {
  readonly id: ElementId;
  readonly name: string;
  readonly key: string;
}

/** "L1-3,5", "HP1 43/45", "MDP-1:7" → the panel among `names` and the circuit numbers, longest panel name first. */
export function parseCircuitText(text: string, sources: readonly Named[]): { source: Named; positions: number[] } | "unmatched" | "ambiguous" {
  const t = norm(text.replace(/\([^)]{0,200}\)/g, "").replace(/\bTYP\.?$/i, ""));
  let best: Named[] = [];
  let positions: number[] = [];
  for (const s of sources) {
    if (!t.startsWith(s.key) || s.key.length === 0) continue;
    const rest = /^[-:#.]*(\d+(?:[,/&+]\d+)*)$/.exec(t.slice(s.key.length));
    if (!rest?.[1]) continue;
    const longer = best.length === 0 || s.key.length > (best[0]?.key.length ?? 0);
    if (longer) {
      best = [s];
      positions = rest[1].split(/[,/&+]/).map(Number);
    } else if (s.key.length === best[0]?.key.length) best.push(s);
  }
  if (best.length > 1) return "ambiguous";
  const source = best[0];
  return source ? { source, positions: [...new Set(positions)].sort((a, b) => a - b) } : "unmatched";
}

function isNew(elements: Elements, id: ElementId): boolean {
  const el = elements[id];
  return el !== undefined && existingPhaseOf(elements, el) === null;
}

function check(model: ModelState, command: Command): string | null {
  const r = executeCommand(model, command);
  return r.ok ? null : r.error.message;
}

/** Proposals for every unlinked `circuit` and `fed_from` value in the model, feeders first (circuits on a panel need it fed to report its totals). */
export function proposeLinksFromText(model: ModelState): LinkProposal[] {
  const elements = model.elements;
  const sources: Named[] = [];
  const parts: PartInstance[] = [];
  for (const id in elements) {
    const el = elements[id];
    if (el?.kind !== "part") continue;
    parts.push(el);
    const info = distributionOf(elements, el);
    if (info) sources.push({ id: el.id, name: info.name, key: norm(info.name) });
  }
  parts.sort((a, b) => a.id.localeCompare(b.id));
  const out: LinkProposal[] = [];

  for (const part of parts) {
    const info = distributionOf(elements, part);
    const text = info ? textParam(elements, part, "fed_from") : null;
    if (!info || !text || !info.input || linkServing(elements, part.id, info.input)) continue;
    const member: ProposalMember = { elementId: part.id, name: info.name, connector: info.input, text };
    const matches = sources.filter((s) => s.id !== part.id && (s.key === norm(text) || norm(text).startsWith(`${s.key}VIA`) || norm(text).startsWith(`${s.key}-`)));
    const longest = Math.max(0, ...matches.map((m) => m.key.length));
    const top = matches.filter((m) => m.key.length === longest);
    const id = `feeder:${part.id}`;
    if (top.length !== 1 || !top[0]) {
      out.push({ id, role: "feeder", status: top.length > 1 ? "ambiguous" : "unmatched", sourceId: null, sourceName: null, positions: [], members: [member], reason: top.length > 1 ? `"${text}" names more than one piece of equipment (${top.map((m) => m.name).join(", ")}); feed ${info.name} by choosing one` : `No distribution equipment is named "${text}"; feed ${info.name} by choosing its source`, command: null });
      continue;
    }
    const source = top[0];
    const command: Command = { type: "create_service_link", linkId: `link-fed-${part.id}`, sourceId: source.id, members: [{ elementId: part.id, connector: info.input }] };
    const why = check(model, command);
    out.push({
      id,
      role: "feeder",
      status: why ? "refused" : "ready",
      sourceId: source.id,
      sourceName: source.name,
      positions: [],
      members: [member],
      reason: why ? `${info.name}'s "Fed from" says ${text}, but ${why}` : `Feed ${info.name} from ${source.name} (its "Fed from" says ${text}), on the lowest free breaker positions that fit`,
      command: why ? null : command,
    });
  }

  const groups = new Map<string, { source: Named; positions: number[]; members: ProposalMember[] }>();
  for (const part of parts) {
    const text = textParam(elements, part, "circuit");
    if (!text) continue;
    const connector = electricalConnectorIds(elements, part).find((c) => !part.served?.[c]);
    if (!connector) continue;
    const name = electricalName(elements, part);
    const member: ProposalMember = { elementId: part.id, name, connector, text };
    const parsed = parseCircuitText(text, sources);
    if (typeof parsed === "string") {
      out.push({ id: `text:${part.id}`, role: "branch", status: parsed, sourceId: null, sourceName: null, positions: [], members: [member], reason: parsed === "ambiguous" ? `"${text}" could be on more than one panel with that name; circuit ${name} by choosing the panel` : `"${text}" doesn't name a panel and circuit numbers in this model (like L1-3 or HP1-43,45)`, command: null });
      continue;
    }
    const key = `branch:${parsed.source.id}:${parsed.positions.join(",")}`;
    const g = groups.get(key) ?? { source: parsed.source, positions: parsed.positions, members: [] };
    g.members.push(member);
    groups.set(key, g);
  }
  for (const [id, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const existing = linksFedFrom(elements, g.source.id).find((l) => l.source.positions.length === g.positions.length && [...l.source.positions].sort((a, b) => a - b).every((p, i) => p === g.positions[i]));
    const circuit = `${g.source.name}-${g.positions.join(",")}`;
    const lockedPhase = existing ? existingPhaseOf(elements, existing) : null;
    const newcomers = lockedPhase !== null ? g.members.filter((m) => isNew(elements, m.elementId)) : [];
    if (existing && lockedPhase !== null && newcomers.length > 0) {
      const who = newcomers.length === 1 ? (newcomers[0]?.name ?? "") : `${newcomers.length} new devices (${newcomers.map((m) => m.name).join(", ")})`;
      out.push({ id, role: "branch", status: "refused", sourceId: g.source.id, sourceName: g.source.name, positions: g.positions, members: g.members, reason: `Their circuit text says ${circuit}, but ${serviceLinkName(elements, existing)} is an existing circuit (made in ${lockedPhase}): it keeps what it serves on this renovation, so put ${who} on a new circuit`, command: null });
      continue;
    }
    const command: Command = existing
      ? { type: "add_link_members", linkId: existing.id, members: g.members.map((m) => ({ elementId: m.elementId, connector: m.connector })) }
      : { type: "create_service_link", linkId: `link-${g.source.id}-${g.positions.join("-")}`, sourceId: g.source.id, positions: g.positions, members: g.members.map((m) => ({ elementId: m.elementId, connector: m.connector })) };
    const why = check(model, command);
    const who = g.members.length === 1 ? (g.members[0]?.name ?? "") : `${g.members.length} devices (${g.members.map((m) => m.name).join(", ")})`;
    out.push({
      id,
      role: "branch",
      status: why ? "refused" : "ready",
      sourceId: g.source.id,
      sourceName: g.source.name,
      positions: g.positions,
      members: g.members,
      reason: why ? `Their circuit text says ${circuit}, but ${why}` : existing ? `Add ${who} to ${serviceLinkName(elements, existing)}, as their circuit text says` : `Put ${who} on ${circuit}, as their circuit text says`,
      command: why ? null : command,
    });
  }
  return out;
}
