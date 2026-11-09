import { z } from "zod";
import { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import { draftElements } from "../store";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import { finish, guard, refuse, type ExecuteResult, type IntentPredicate } from "../command-core";
import { asElementId, type BimElement, type ElementId, type ModelState, type PartInstance } from "../types";
import type { MemberCandidate, TradeAdapter } from "./adapter";
import { linkServing, occupiedPositions, serviceFingerprint, serviceLinkName, sourceTradeOf } from "./model";
import { CONDUCTOR_MATERIALS, type ElectricalLinkDesign, type ServiceEnd, type ServiceLink, type ServiceRole } from "./types";

/**
 * How a source's numbered positions are chosen (v1), per link trade: the free
 * groups of `poles` positions at a source with `spaces` positions (null:
 * unbounded) where `occupied` are taken and `valid` accepts the group, and why
 * an existing link may not be moved or renumbered. A trade with no row offers
 * only the empty group (a member that needs no positions).
 */
export interface PositionPolicyDef {
  /** The link trade it applies to (`ServiceLink.trade`); bare, it is stored. */
  readonly id: string;
  groups(spaces: number | null, occupied: ReadonlySet<number>, poles: number, valid: (positions: readonly number[]) => boolean): number[][];
  lockedRefusal?(elements: Readonly<Record<string, BimElement>>, link: ServiceLink, change: { readonly sourceId?: string; readonly positions?: readonly number[] }): string | null;
}

export const POSITION_POLICY_POINT = defineExtensionPoint<PositionPolicyDef>({ id: "kernel.position_policy", version: 1, label: "Position policies", idOf: (p) => p.id, namespaced: false });

function positionPolicy(trade: string): PositionPolicyDef | null {
  const set = activePackSet();
  return set.memo("kernel.position_policy#table", () => new Map(set.items(POSITION_POLICY_POINT).map((p) => [p.id, p] as const))).get(trade) ?? null;
}

function positionGroups(adapter: TradeAdapter, spaces: number | null, occupied: ReadonlySet<number>, poles: number, valid: (positions: readonly number[]) => boolean): number[][] {
  const policy = positionPolicy(adapter.trade);
  if (policy) return policy.groups(spaces, occupied, poles, valid);
  return poles === 0 ? [[]] : [];
}

function lockedRefusal(elements: Readonly<Record<string, BimElement>>, link: ServiceLink, change: { readonly sourceId?: string; readonly positions?: readonly number[] }): string | null {
  return positionPolicy(link.trade)?.lockedRefusal?.(elements, link, change) ?? null;
}

const idSchema = z.string().min(1).max(200);
const memberSchema = z.object({
  elementId: idSchema,
  /** Which connector of the member; may be left out when it has only one the trade can serve. */
  connector: z.string().min(1).max(40).optional(),
});
const positionsSchema = z.array(z.number().int().min(1).max(999)).max(12);
const conductorSchema = z.object({
  sets: z.number().int().min(1).max(20),
  phaseSize: z.string().trim().min(1).max(12),
  neutralSize: z.string().trim().min(1).max(12).optional(),
  groundSize: z.string().trim().min(1).max(12).optional(),
  material: z.enum(CONDUCTOR_MATERIALS),
});
const electricalSchema = z.object({
  ratingA: z.number().positive().max(10_000).optional(),
  frameA: z.number().positive().max(10_000).optional(),
  loadClass: z.string().trim().min(1).max(40).optional(),
  conductors: conductorSchema.optional(),
  lengthFt: z.number().positive().max(100_000).optional(),
  feederType: z.string().trim().min(1).max(40).optional(),
});
/** Edits: a value sets the field, null clears it. */
const electricalEditSchema = z.object({
  ratingA: z.number().positive().max(10_000).nullable().optional(),
  frameA: z.number().positive().max(10_000).nullable().optional(),
  loadClass: z.string().trim().min(1).max(40).nullable().optional(),
  conductors: conductorSchema.nullable().optional(),
  lengthFt: z.number().positive().max(100_000).nullable().optional(),
  feederType: z.string().trim().min(1).max(40).nullable().optional(),
});

/**
 * Served-from link commands, for every trade. Membership is only ever what
 * the sender lists: nothing here picks members by proximity or any other
 * computed grouping (internal design note). Positions may be left out; the
 * lowest free ones that fit are taken.
 */
export const serviceLinkCommandSchemas = [
  z.object({
    type: z.literal("create_service_link"),
    /** Chosen by the sender so a retried request makes the same link, not a second one. */
    linkId: idSchema,
    sourceId: idSchema,
    positions: positionsSchema.optional(),
    members: z.array(memberSchema).max(200),
    description: z.string().trim().max(120).optional(),
    electrical: electricalSchema.optional(),
  }),
  z.object({
    type: z.literal("edit_service_link"),
    linkId: idSchema,
    /** Move the link to another source (its positions are chosen again unless given). */
    sourceId: idSchema.optional(),
    positions: positionsSchema.optional(),
    description: z.string().trim().max(120).optional(),
    electrical: electricalEditSchema.optional(),
  }),
  z.object({
    type: z.literal("add_link_members"),
    linkId: idSchema,
    members: z.array(memberSchema).min(1).max(200),
  }),
  z.object({
    type: z.literal("remove_link_members"),
    linkId: idSchema,
    elementIds: z.array(idSchema).min(1).max(200),
  }),
  z.object({
    type: z.literal("reposition_service_links"),
    /** The source every link listed is on. */
    sourceId: idSchema,
    /** New positions for several links at once, so two circuits can swap slots; the result is checked as a whole. */
    moves: z.array(z.object({ linkId: idSchema, positions: positionsSchema.min(1) })).min(1).max(200),
  }),
] as const;

export const serviceLinkCommandSchema = z.discriminatedUnion("type", [...serviceLinkCommandSchemas]);
export type ServiceLinkCommand = z.infer<typeof serviceLinkCommandSchema>;

const LINK_COMMANDS: ReadonlySet<string> = new Set(serviceLinkCommandSchemas.map((s) => s.shape.type.value));

export function isServiceLinkCommand(command: { readonly type: string }): command is ServiceLinkCommand {
  return LINK_COMMANDS.has(command.type);
}

function nameOf(elements: Readonly<Record<string, BimElement>>, part: PartInstance): string {
  return sourceTradeOf(elements, part)?.info.name ?? (part.mark || part.id);
}

function requirePart(reader: TrackedReader, id: string, what: string): PartInstance {
  const el = reader.get(asElementId(id));
  if (el.kind !== "part") refuse("wrong_kind", `${what} must be a placed part; ${id} is a ${el.kind.replace(/_/g, " ")}`, [el.id]);
  return el;
}

function requireLink(reader: TrackedReader, id: string): ServiceLink {
  const el = reader.get(asElementId(id));
  if (el.kind !== "service_link") refuse("wrong_kind", `${id} is a ${el.kind.replace(/_/g, " ")}, not a circuit or feeder`, [el.id]);
  return el;
}

interface SourceContext {
  readonly part: PartInstance;
  readonly adapter: TradeAdapter;
  readonly info: NonNullable<ReturnType<TradeAdapter["source"]>>;
}

function sourceContext(reader: TrackedReader, sourceId: string): SourceContext {
  const part = requirePart(reader, sourceId, "What a circuit is fed from");
  const found = sourceTradeOf(reader.model.elements, part);
  if (!found) refuse("wrong_kind", `${part.mark || part.id} can't feed anything: it isn't distribution equipment with a readable voltage (a panel needs a voltage and phases)`, [part.id]);
  return { part, adapter: found.adapter, info: found.info };
}

/** Resolve each listed member's connector and check it is free (except on `linkId`). */
function resolveMembers(reader: TrackedReader, adapter: TradeAdapter, members: ReadonlyArray<{ elementId: string; connector?: string }>, linkId: string): MemberCandidate[] {
  const elements = reader.model.elements;
  const seen = new Set<string>();
  return members.map((m) => {
    const part = requirePart(reader, m.elementId, "A circuit member");
    const options = adapter.connectors(elements, part);
    const connector = m.connector ?? (options.length === 1 ? options[0] : undefined);
    if (connector === undefined) {
      refuse("invalid_value", options.length === 0 ? `${nameOf(elements, part)} has no ${adapter.trade} connector to serve` : `${nameOf(elements, part)} has ${options.length} ${adapter.trade} connectors (${options.join(", ")}); say which one`, [part.id]);
    }
    if (!options.includes(connector)) refuse("invalid_value", `${nameOf(elements, part)} has no ${adapter.trade} connector ${connector}`, [part.id]);
    const key = `${part.id}#${connector}`;
    if (seen.has(key)) refuse("invalid_value", `${nameOf(elements, part)} is listed twice`, [part.id]);
    seen.add(key);
    const current = linkServing(elements, part.id, connector);
    if (current && current.id !== linkId) {
      reader.get(current.id);
      refuse("in_use", `${nameOf(elements, part)} is already on ${serviceLinkName(elements, current)}; take it off that one first`, [part.id, current.id]);
    }
    return { part, connector };
  });
}

/** branch or feeder, from what the members are; mixing the two is refused. */
function roleOf(elements: Readonly<Record<string, BimElement>>, adapter: TradeAdapter, members: readonly MemberCandidate[], fallback: ServiceRole): ServiceRole {
  const feeders = members.filter((m) => {
    const s = adapter.source(elements, m.part);
    return s !== null && (s.input === m.connector || (s.alternateInputs ?? []).includes(m.connector));
  });
  if (feeders.length === 0) return members.length > 0 ? "branch" : fallback;
  if (feeders.length !== members.length || members.length > 1) {
    const first = feeders[0];
    refuse("invalid_value", `${first ? nameOf(elements, first.part) : "Distribution equipment"} takes its own feeder; feed it on its own, not on a circuit with other things`, members.map((m) => m.part.id));
  }
  return "feeder";
}

/** Refuse a feeder that would make distribution equipment feed itself. */
function refuseLoop(elements: Readonly<Record<string, BimElement>>, adapter: TradeAdapter, source: PartInstance, member: PartInstance): void {
  let at: PartInstance | null = source;
  for (let guardSteps = 0; at && guardSteps < 1000; guardSteps++) {
    if (at.id === member.id) refuse("invalid_value", `${nameOf(elements, member)} already feeds ${nameOf(elements, source)}; feeding it from there would make a loop`, [member.id, source.id]);
    const input: string | null | undefined = adapter.source(elements, at)?.input;
    const up: ServiceLink | null = input ? linkServing(elements, at.id, input) : null;
    const next: BimElement | undefined = up ? elements[up.source.elementId] : undefined;
    at = next?.kind === "part" ? next : null;
  }
}

function checkMembers(reader: TrackedReader, ctx: SourceContext, positions: readonly number[], members: readonly MemberCandidate[], role: ServiceRole): void {
  const elements = reader.model.elements;
  for (const m of members) {
    if (m.part.id === ctx.part.id) refuse("invalid_value", `${nameOf(elements, m.part)} can't be fed from itself`, [m.part.id]);
    const why = ctx.adapter.refusal(elements, ctx.part, positions, m, role);
    if (why) refuse("profile_incompatible", why, [m.part.id, ctx.part.id]);
    if (role === "feeder") refuseLoop(elements, ctx.adapter, ctx.part, m.part);
  }
}

/** The positions to use: as given (checked), else the lowest free ones that fit the members. */
function choosePositions(reader: TrackedReader, ctx: SourceContext, given: readonly number[] | undefined, members: readonly MemberCandidate[], role: ServiceRole, linkId: string): number[] {
  const elements = reader.model.elements;
  const taken = occupiedPositions(elements, ctx.part.id, linkId);
  for (const link of taken.values()) reader.get(link.id);
  if (ctx.info.spaces === "none") {
    if (given && given.length > 0) refuse("invalid_value", ctx.adapter.positionsRefusal(elements, ctx.part, given) ?? `${ctx.info.name} has no numbered positions`, [ctx.part.id]);
    return [];
  }
  if (given && given.length > 0) {
    if (new Set(given).size !== given.length) refuse("invalid_value", `Circuit ${given.join(",")} lists a position twice`, [ctx.part.id]);
    const clash = given.find((p) => taken.has(p));
    if (clash !== undefined) {
      const other = taken.get(clash);
      refuse("in_use", `Circuit ${clash} on ${ctx.info.name} is already used by ${other ? serviceLinkName(elements, other) : "another circuit"}`, [ctx.part.id, ...(other ? [other.id] : [])]);
    }
    const why = ctx.adapter.positionsRefusal(elements, ctx.part, given);
    if (why) refuse("invalid_value", why, [ctx.part.id]);
    return [...given].sort((a, b) => a - b);
  }
  const needs = members.map((m) => ctx.adapter.positionsNeeded(elements, m, role)).filter((n): n is number => n !== null);
  const poles = needs[0] ?? 1;
  if (needs.some((n) => n !== poles)) refuse("invalid_value", "These members need different numbers of poles, so they can't share one circuit", members.map((m) => m.part.id));
  const spaces = ctx.info.spaces;
  const groups = positionGroups(ctx.adapter, spaces, new Set(taken.keys()), poles, (g) => ctx.adapter.positionsRefusal(elements, ctx.part, g) === null);
  if (groups.length === 0) {
    // Nothing would fit even on an empty board (a 3-pole load on a single-phase panel): say why, not "no space left".
    if (positionGroups(ctx.adapter, spaces, new Set(), poles, (g) => ctx.adapter.positionsRefusal(elements, ctx.part, g) === null).length === 0) {
      for (const m of members) {
        const why = ctx.adapter.refusal(elements, ctx.part, [], m, role);
        if (why) refuse("profile_incompatible", why, [m.part.id, ctx.part.id]);
      }
      refuse("profile_incompatible", `${ctx.info.name} has no ${poles}-pole breaker positions`, [ctx.part.id, ...members.map((m) => m.part.id)]);
    }
    refuse("in_use", `${ctx.info.name} has no free ${poles}-pole space left${spaces !== null ? ` in its ${spaces} circuits` : ""}`, [ctx.part.id]);
  }
  // Balancing is a preference, not a rule: the loads it reads are not part of what the edit depends on.
  const picked = ctx.adapter.rankPositions?.(elements, ctx.part, groups, members, role, linkId) ?? groups[0];
  return [...(picked ?? groups[0] ?? [])];
}

function withServed(part: PartInstance, connector: string, linkId: ElementId | null): PartInstance {
  const served = { ...(part.served ?? {}) };
  if (linkId === null) delete served[connector];
  else served[connector] = linkId;
  const { served: _old, ...rest } = part;
  return Object.keys(served).length > 0 ? { ...rest, served } : rest;
}

function withFeeds(part: PartInstance, linkId: ElementId, on: boolean): PartInstance {
  const feeds = (part.feeds ?? []).filter((id) => id !== linkId);
  if (on) feeds.push(linkId);
  const { feeds: _old, ...rest } = part;
  return feeds.length > 0 ? { ...rest, feeds } : rest;
}

type ElectricalEdit = z.infer<typeof electricalEditSchema>;

/** `base` with `edit` applied: a value sets a field, null clears it, absent keeps it. Undefined when nothing is left. */
function mergeElectrical(base: ElectricalLinkDesign | undefined, edit: ElectricalEdit): ElectricalLinkDesign | undefined {
  const pick = <K extends keyof ElectricalEdit & keyof ElectricalLinkDesign>(k: K): ElectricalLinkDesign[K] | undefined => {
    const v = edit[k];
    if (v === null) return undefined;
    return (v ?? base?.[k]) as ElectricalLinkDesign[K] | undefined;
  };
  const ratingA = pick("ratingA");
  const frameA = pick("frameA");
  const loadClass = pick("loadClass");
  const conductors = pick("conductors");
  const lengthFt = pick("lengthFt");
  const feederType = pick("feederType");
  const out: ElectricalLinkDesign = {
    ...(ratingA !== undefined ? { ratingA } : {}),
    ...(frameA !== undefined ? { frameA } : {}),
    ...(loadClass !== undefined ? { loadClass } : {}),
    ...(conductors !== undefined ? { conductors } : {}),
    ...(lengthFt !== undefined ? { lengthFt } : {}),
    ...(feederType !== undefined ? { feederType } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function linkIntent(link: ServiceLink): () => IntentPredicate[] {
  return () => [{ kind: "field_equals", elementId: link.id, field: "service", value: serviceFingerprint(link) }];
}

function createLink(model: ModelState, command: Extract<ServiceLinkCommand, { type: "create_service_link" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const linkId = asElementId(command.linkId);
  if (reader.find(linkId)) refuse("already_exists", `${command.linkId} already exists; choose a new id`, [linkId]);
  const ctx = sourceContext(reader, command.sourceId);
  const members = resolveMembers(reader, ctx.adapter, command.members, command.linkId);
  const role = roleOf(model.elements, ctx.adapter, members, "branch");
  const positions = choosePositions(reader, ctx, command.positions, members, role, command.linkId);
  checkMembers(reader, ctx, positions, members, role);
  const defaults = ctx.adapter.defaultDesign?.(model.elements, members, role, positions) ?? {};
  const electrical = ctx.adapter.trade === "electrical" ? mergeElectrical(defaults.electrical, command.electrical ?? {}) : undefined;
  const link: ServiceLink = {
    id: linkId,
    kind: "service_link",
    version: 0,
    authoredRev: {},
    partition: GLOBAL_PARTITION,
    trade: ctx.adapter.trade,
    role,
    source: { elementId: ctx.part.id, port: ctx.info.port, positions },
    members: members.map((m): ServiceEnd => ({ elementId: m.part.id, connector: m.connector })),
    description: command.description ?? "",
    ...(electrical ? { electrical } : {}),
  };
  const working = draftElements(model.elements);
  working[linkId] = link;
  working[ctx.part.id] = withFeeds(ctx.part, linkId, true);
  for (const m of members) {
    const current = working[m.part.id];
    if (current?.kind === "part") working[m.part.id] = withServed(current, m.connector, linkId);
  }
  return finish(reader, working, [linkId, ctx.part.id, ...members.map((m) => m.part.id)], [{ elementId: linkId, field: "service", value: serviceFingerprint(link) }], linkIntent(link));
}

function editLink(model: ModelState, command: Extract<ServiceLinkCommand, { type: "edit_service_link" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const link = requireLink(reader, command.linkId);
  const moving = command.sourceId !== undefined && command.sourceId !== link.source.elementId;
  if (command.sourceId === undefined && command.positions === undefined && command.description === undefined && command.electrical === undefined) {
    refuse("invalid_value", "Nothing to change: give a new source, positions, description or design value");
  }
  const ctx = sourceContext(reader, command.sourceId ?? link.source.elementId);
  if (ctx.adapter.trade !== link.trade) refuse("invalid_value", `${ctx.info.name} is ${ctx.adapter.trade}; this link is ${link.trade}`, [ctx.part.id]);
  const members = link.members.map((m) => ({ part: requirePart(reader, m.elementId, "A circuit member"), connector: m.connector }));
  const repositions = moving || command.positions !== undefined;
  if (repositions) {
    const locked = lockedRefusal(model.elements, link, { ...(command.sourceId ? { sourceId: command.sourceId } : {}), ...(command.positions ? { positions: command.positions } : {}) });
    if (locked) refuse("invalid_value", locked, [link.id]);
  }
  const positions = repositions ? choosePositions(reader, ctx, command.positions, members, link.role, link.id) : [...link.source.positions];
  if (repositions) checkMembers(reader, ctx, positions, members, link.role);
  const electrical = command.electrical ? mergeElectrical(link.electrical, command.electrical) : link.electrical;
  const { electrical: _old, ...rest } = link;
  const next: ServiceLink = {
    ...rest,
    source: { elementId: ctx.part.id, port: ctx.info.port, positions },
    ...(command.description !== undefined ? { description: command.description } : {}),
    ...(electrical ? { electrical } : {}),
  };
  const working = draftElements(model.elements);
  working[link.id] = next;
  const touched: ElementId[] = [link.id];
  if (moving) {
    const old = reader.get(link.source.elementId);
    if (old.kind === "part") {
      working[old.id] = withFeeds(old, link.id, false);
      touched.push(old.id);
    }
    working[ctx.part.id] = withFeeds(ctx.part, link.id, true);
    touched.push(ctx.part.id);
  }
  return finish(reader, working, touched, [{ elementId: link.id, field: "service", value: serviceFingerprint(next) }], linkIntent(next));
}

function addMembers(model: ModelState, command: Extract<ServiceLinkCommand, { type: "add_link_members" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const link = requireLink(reader, command.linkId);
  const ctx = sourceContext(reader, link.source.elementId);
  const incoming = resolveMembers(reader, ctx.adapter, command.members, link.id).filter((m) => !link.members.some((x) => x.elementId === m.part.id && x.connector === m.connector));
  if (incoming.length === 0) refuse("invalid_value", `Everything listed is already on ${serviceLinkName(model.elements, link)}`, [link.id]);
  const existing = link.members.map((m) => ({ part: requirePart(reader, m.elementId, "A circuit member"), connector: m.connector }));
  const role = roleOf(model.elements, ctx.adapter, [...existing, ...incoming], link.role);
  if (role !== link.role) refuse("invalid_value", `${serviceLinkName(model.elements, link)} is a ${link.role}; it can't take these`, [link.id]);
  checkMembers(reader, ctx, link.source.positions, incoming, role);
  const next: ServiceLink = { ...link, members: [...link.members, ...incoming.map((m): ServiceEnd => ({ elementId: m.part.id, connector: m.connector }))] };
  const working = draftElements(model.elements);
  working[link.id] = next;
  for (const m of incoming) {
    const current = working[m.part.id];
    if (current?.kind === "part") working[m.part.id] = withServed(current, m.connector, link.id);
  }
  return finish(reader, working, [link.id, ...incoming.map((m) => m.part.id)], [{ elementId: link.id, field: "service", value: serviceFingerprint(next) }], linkIntent(next));
}

function removeMembers(model: ModelState, command: Extract<ServiceLinkCommand, { type: "remove_link_members" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const link = requireLink(reader, command.linkId);
  const ids = new Set(command.elementIds);
  const leaving = link.members.filter((m) => ids.has(m.elementId));
  const missing = [...ids].filter((id) => !link.members.some((m) => m.elementId === id));
  if (missing.length > 0) refuse("invalid_value", `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on ${serviceLinkName(model.elements, link)}`, missing.map(asElementId));
  const next: ServiceLink = { ...link, members: link.members.filter((m) => !ids.has(m.elementId)) };
  const working = draftElements(model.elements);
  working[link.id] = next;
  for (const m of leaving) {
    reader.get(m.elementId);
    const part = working[m.elementId];
    if (part?.kind === "part") working[m.elementId] = withServed(part, m.connector, null);
  }
  return finish(reader, working, [link.id, ...new Set(leaving.map((m) => m.elementId))], [{ elementId: link.id, field: "service", value: serviceFingerprint(next) }], linkIntent(next));
}

function repositionLinks(model: ModelState, command: Extract<ServiceLinkCommand, { type: "reposition_service_links" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const ctx = sourceContext(reader, command.sourceId);
  const elements = model.elements;
  const moving = new Map<string, readonly number[]>();
  for (const move of command.moves) {
    if (moving.has(move.linkId)) refuse("invalid_value", `${move.linkId} is listed twice`, [asElementId(move.linkId)]);
    moving.set(move.linkId, [...move.positions].sort((a, b) => a - b));
  }
  const final = new Map<number, string>();
  for (const [p, link] of occupiedPositions(elements, ctx.part.id)) {
    reader.get(link.id);
    if (!moving.has(link.id)) final.set(p, link.id);
  }
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  const authored: { elementId: ElementId; field: string; value: string }[] = [];
  for (const [linkId, positions] of moving) {
    const link = requireLink(reader, linkId);
    const locked = lockedRefusal(elements, link, { positions });
    if (locked) refuse("invalid_value", locked, [link.id]);
    if (link.source.elementId !== ctx.part.id) refuse("invalid_value", `${serviceLinkName(elements, link)} isn't on ${ctx.info.name}`, [link.id]);
    if (positions.length !== link.source.positions.length) refuse("invalid_value", `${serviceLinkName(elements, link)} takes ${link.source.positions.length} position${link.source.positions.length === 1 ? "" : "s"}, not ${positions.length}`, [link.id]);
    const why = ctx.adapter.positionsRefusal(elements, ctx.part, positions);
    if (why) refuse("invalid_value", why, [ctx.part.id, link.id]);
    for (const p of positions) {
      const other = final.get(p);
      if (other !== undefined) {
        const o = elements[other];
        refuse("in_use", `Circuit ${p} on ${ctx.info.name} would hold both ${serviceLinkName(elements, link)} and ${o?.kind === "service_link" ? serviceLinkName(elements, o) : other}`, [link.id, asElementId(other)]);
      }
      final.set(p, link.id);
    }
    const members = link.members.map((m) => ({ part: requirePart(reader, m.elementId, "A circuit member"), connector: m.connector }));
    checkMembers(reader, ctx, positions, members, link.role);
    const next: ServiceLink = { ...link, source: { ...link.source, positions } };
    working[link.id] = next;
    touched.push(link.id);
    authored.push({ elementId: link.id, field: "service", value: serviceFingerprint(next) });
  }
  const intents = (): IntentPredicate[] => authored.map((a) => ({ kind: "field_equals", elementId: a.elementId, field: a.field, value: a.value }));
  return finish(reader, working, touched, authored, intents);
}

export function executeServiceLinkCommand(model: ModelState, command: ServiceLinkCommand): ExecuteResult {
  return guard(() => {
    switch (command.type) {
      case "reposition_service_links":
        return repositionLinks(model, command);
      case "create_service_link":
        return createLink(model, command);
      case "edit_service_link":
        return editLink(model, command);
      case "add_link_members":
        return addMembers(model, command);
      case "remove_link_members":
        return removeMembers(model, command);
    }
  });
}
