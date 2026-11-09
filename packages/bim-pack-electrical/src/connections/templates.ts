import { pushTo, type BimElement, type ElementId, type ModelState, type PartInstance, type Room, type Vec2, executeCommand, type Command, catalogKey, type ServiceLinkCommand, linkServing, serviceLinkName, type ServiceBatchCommand } from "@permitzip/bim-kernel";
import { electricalFieldsOf } from "../catalog/connection-fields";
import { electricalAdapter } from "./adapter";
import type { CircuitTemplateEntry, TemplateRule } from "../catalog/circuit-templates";
import { connectionTypeOfPart, distributionOf, electricalConnectorIds, electricalConnectorOf, electricalName } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Room-convention circuiting for dwelling units (US 8,738,332 design rules,
 * internal design note): a circuit's members are the devices inside the
 * rooms the engineer picked, sorted by the engineer's own template ("bedroom
 * on circuit 1, living room on 2"). Each unit's panel is the one the engineer
 * names; nothing here chooses a panel, measures routes or groups devices by
 * how close they are to each other.
 */

/** One unit: its panel and its rooms, both chosen by the engineer. */
export interface TemplateUnit {
  readonly panelId: string;
  readonly roomIds: readonly string[];
  /** For messages: "Unit 101". Default: the panel's name. */
  readonly label?: string;
}

export interface PlannedCircuit {
  readonly linkId: string;
  readonly ruleIndex: number;
  readonly rule: TemplateRule;
  readonly rooms: readonly string[];
  readonly description: string;
  readonly memberIds: readonly string[];
  /** The slots it takes once made ("L101-1"), or why it can't be made. */
  readonly name: string | null;
  readonly positions: readonly number[] | null;
  readonly refusal: string | null;
}

export interface PlannedUnit {
  readonly panelId: string;
  readonly panelName: string;
  readonly label: string;
  readonly circuits: readonly PlannedCircuit[];
  /** Rooms no rule matched, and devices left alone (already on a circuit, not the rule's kind). */
  readonly unmatchedRooms: readonly string[];
  readonly skipped: readonly { readonly elementId: string; readonly name: string; readonly reason: string }[];
}

export interface TemplatePlan {
  readonly template: string;
  readonly units: readonly PlannedUnit[];
  /** Every circuit that can be made, as one edit; null when none can. */
  readonly command: ServiceBatchCommand | null;
  readonly made: number;
  readonly refused: number;
  readonly message: string;
}

function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const words = (text: string) => catalogKey(text).split(/[^A-Z0-9]+/).filter(Boolean);

/** Whether a rule's room words all appear, as whole words, in a room's name ("bedroom" matches "Master Bedroom", "Bedroom 2"). */
export function ruleMatchesRoom(rule: TemplateRule, roomName: string): boolean {
  const have = words(roomName);
  const want = words(rule.room);
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, k) => have[i + k] === w)) return true;
  return false;
}

/** The first rule that matches a room, top to bottom. */
export function ruleForRoom(template: CircuitTemplateEntry, roomName: string): number | null {
  const i = template.rules.findIndex((r) => ruleMatchesRoom(r, roomName));
  return i >= 0 ? i : null;
}

function typeWords(elements: Elements, part: PartInstance): string {
  const t = elements[part.typeId];
  return t?.kind === "part_type" ? `${t.definition.familyName} ${t.definition.typeName}` : "";
}

function deviceKind(elements: Elements, part: PartInstance): "receptacles" | "lighting" | "other" {
  const t = elements[part.typeId];
  const ct = connectionTypeOfPart(elements, part);
  const cls = ct ? electricalFieldsOf(ct).loadClass : null;
  if (cls) return cls === "lighting" ? "lighting" : cls === "receptacle" ? "receptacles" : "other";
  if (t?.kind === "part_type" && t.definition.category === "lighting_fixture") return "lighting";
  return /receptacle|outlet/i.test(typeWords(elements, part)) ? "receptacles" : "other";
}

function onLevel(room: Room, part: PartInstance): boolean {
  const level = room.partition?.level;
  return level === undefined || level === "*" || level === part.levelId || level === part.partition?.level;
}

function linkIdFor(panelId: string, template: string, unit: TemplateUnit, key: string): string {
  const first = [...unit.roomIds].sort()[0] ?? "";
  return `ckt:${panelId}:${catalogKey(template).replace(/[^A-Z0-9]+/g, "-")}:${first}:${key}`.slice(0, 200);
}

/**
 * What applying a template to these units would make: per unit, one circuit
 * per rule (rules naming the same circuit number share it), with the devices
 * of the rule's kind inside the rooms it matched. The preview runs the edit
 * against the model, so the slots shown are the slots it will take.
 */
export function planCircuitTemplate(model: ModelState, template: CircuitTemplateEntry, units: readonly TemplateUnit[]): TemplatePlan {
  const elements = model.elements;
  const parts = Object.values(elements).filter((e): e is PartInstance => e.kind === "part" && electricalConnectorIds(elements, e).length > 0 && !distributionOf(elements, e));
  const plannedUnits: PlannedUnit[] = [];
  const steps: ServiceLinkCommand[] = [];
  const stepOf = new Map<string, number>();
  for (const unit of units) {
    const panel = elements[unit.panelId];
    const info = panel?.kind === "part" ? distributionOf(elements, panel) : null;
    const label = unit.label ?? info?.name ?? unit.panelId;
    if (!info || panel?.kind !== "part") {
      plannedUnits.push({ panelId: unit.panelId, panelName: unit.panelId, label, circuits: [], unmatchedRooms: [], skipped: [{ elementId: unit.panelId, name: unit.panelId, reason: `${unit.panelId} is not a panel; pick the unit's panel` }] });
      continue;
    }
    const groups = new Map<string, { ruleIndex: number; rule: TemplateRule; rooms: string[]; members: PartInstance[] }>();
    const unmatched: string[] = [];
    const skipped: { elementId: string; name: string; reason: string }[] = [];
    for (const roomId of unit.roomIds) {
      const room = elements[roomId];
      if (room?.kind !== "room") {
        skipped.push({ elementId: roomId, name: roomId, reason: "not a room" });
        continue;
      }
      const roomName = room.name || room.number;
      const ruleIndex = ruleForRoom(template, roomName);
      if (ruleIndex === null) {
        unmatched.push(roomName);
        continue;
      }
      const rule = template.rules[ruleIndex] as TemplateRule;
      const key = rule.circuit !== undefined ? `c${rule.circuit}` : `r${ruleIndex}`;
      const group = groups.get(key) ?? { ruleIndex, rule, rooms: [], members: [] };
      group.rooms.push(roomName);
      for (const part of parts) {
        if (!onLevel(room, part) || !pointInPolygon(part.position, room.outline)) continue;
        const kind = deviceKind(elements, part);
        if (rule.devices !== "all" && kind !== rule.devices) continue;
        const connector = electricalConnectorIds(elements, part)[0] as string;
        const on = linkServing(elements, part.id, connector);
        if (on) {
          skipped.push({ elementId: part.id, name: electricalName(elements, part), reason: `already on ${serviceLinkName(elements, on)}` });
          continue;
        }
        if (!group.members.includes(part)) group.members.push(part);
      }
      groups.set(key, group);
    }
    const circuits: PlannedCircuit[] = [];
    const ordered = [...groups.entries()].sort((a, b) => a[1].ruleIndex - b[1].ruleIndex);
    for (const [key, g] of ordered) {
      const linkId = linkIdFor(unit.panelId, template.name, unit, key);
      const description = (g.rule.description ?? `${[...new Set(g.rooms)].join(", ")} ${g.rule.devices === "lighting" ? "lighting" : g.rule.devices === "receptacles" ? "receptacles" : ""}`.trim()).slice(0, 120);
      const base = { linkId, ruleIndex: g.ruleIndex, rule: g.rule, rooms: g.rooms, description, memberIds: g.members.map((m) => m.id) };
      if (g.members.length === 0) {
        circuits.push({ ...base, name: null, positions: null, refusal: `No ${g.rule.devices === "all" ? "devices" : g.rule.devices} on no circuit in ${g.rooms.join(", ")}` });
        continue;
      }
      const poles = new Set(g.members.map((m) => electricalConnectorOf(elements, m, electricalConnectorIds(elements, m)[0] as string)?.poles ?? 0));
      if (poles.size !== 1) {
        circuits.push({ ...base, name: null, positions: null, refusal: `${g.rooms.join(", ")} has loads needing different breakers (1-, 2- and 3-pole, or one has no voltage); give them their own rule` });
        continue;
      }
      const need = [...poles][0] ?? 1;
      const why = g.members.map((m) => electricalAdapter.refusal(elements, panel, [], { part: m, connector: electricalConnectorIds(elements, m)[0] as string }, "branch")).find((r) => r !== null);
      if (why) {
        circuits.push({ ...base, name: null, positions: null, refusal: why });
        continue;
      }
      const positions = g.rule.circuit !== undefined ? Array.from({ length: need }, (_, i) => (g.rule.circuit as number) + 2 * i) : undefined;
      stepOf.set(linkId, steps.length);
      steps.push({
        type: "create_service_link",
        linkId,
        sourceId: unit.panelId,
        ...(positions ? { positions } : {}),
        members: g.members.map((m) => ({ elementId: m.id })),
        description,
        ...(g.rule.breakerA !== undefined ? { electrical: { ratingA: g.rule.breakerA } } : {}),
      });
      circuits.push({ ...base, name: null, positions: positions ?? null, refusal: null });
    }
    plannedUnits.push({ panelId: unit.panelId, panelName: info.name, label, circuits, unmatchedRooms: unmatched, skipped });
  }
  // Run the steps one at a time against the model: what refuses is reported on its circuit and left out.
  let current = model;
  const accepted: ServiceLinkCommand[] = [];
  const outcome = new Map<string, { name: string | null; positions: readonly number[] | null; refusal: string | null }>();
  for (const step of steps) {
    const r = executeCommand(current, step as Command);
    if (!r.ok) {
      outcome.set(step.type === "create_service_link" ? step.linkId : "", { name: null, positions: null, refusal: r.error.message });
      continue;
    }
    current = r.model;
    accepted.push(step);
    if (step.type === "create_service_link") {
      const made = current.elements[step.linkId];
      if (made?.kind === "service_link") outcome.set(step.linkId, { name: serviceLinkName(current.elements, made), positions: made.source.positions, refusal: null });
    }
  }
  const units2 = plannedUnits.map((u) => ({ ...u, circuits: u.circuits.map((c) => (stepOf.has(c.linkId) ? { ...c, ...(outcome.get(c.linkId) ?? {}) } : c)) }));
  const made = accepted.length;
  const refused = units2.reduce((a, u) => a + u.circuits.filter((c) => c.refusal !== null).length, 0);
  const command: ServiceBatchCommand | null = made > 0 ? { type: "batch_service_links", label: `Apply room template ${template.name} to ${units.length} unit${units.length === 1 ? "" : "s"}`.slice(0, 160), commands: accepted } : null;
  const message = made === 0 ? `Nothing to make: ${refused > 0 ? "every circuit was refused (see why on each)" : "no rule matched a room with devices on no circuit"}.` : `${made} circuit${made === 1 ? "" : "s"} on ${units.length} unit${units.length === 1 ? "" : "s"}${refused > 0 ? `; ${refused} can't be made (see why)` : ""}.`;
  return { template: template.name, units: units2, command, made, refused, message };
}

/** A suggested unit for a set of rooms: rooms grouped by the room number before its last "-" or "." ("101-2" is unit 101), and a panel whose name ends in that unit number. The engineer confirms or changes each. */
export interface UnitSuggestion {
  readonly unit: string;
  readonly roomIds: readonly ElementId[];
  readonly panelId: string | null;
}

export function suggestUnits(elements: Elements, roomIds: readonly string[]): UnitSuggestion[] {
  const byUnit = new Map<string, ElementId[]>();
  for (const id of roomIds) {
    const room = elements[id];
    if (room?.kind !== "room") continue;
    const number = room.number.trim();
    const cut = Math.max(number.lastIndexOf("-"), number.lastIndexOf("."));
    const unit = cut > 0 ? number.slice(0, cut) : number || room.id;
    pushTo(byUnit, unit, room.id);
  }
  const panels = Object.values(elements).flatMap((e) => (e.kind === "part" ? [{ id: e.id, info: distributionOf(elements, e) }] : [])).filter((p) => p.info && p.info.kind === "panelboard");
  return [...byUnit.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([unit, ids]) => {
      const key = catalogKey(unit);
      const named = panels.filter((p) => {
        const name = catalogKey(p.info?.name ?? "");
        return name === key || new RegExp(`(^|[^A-Z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(name);
      });
      return { unit, roomIds: ids, panelId: named.length === 1 ? (named[0]?.id ?? null) : null };
    });
}
