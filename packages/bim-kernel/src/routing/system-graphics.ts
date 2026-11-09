import { z } from "zod";
import { finish, refuse, type AuthoredWrite, type ExecuteResult } from "../command-core";
import { TrackedReader, requireKind } from "../model";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ModelState } from "../types";
import type { Pen } from "../drawing/sheet";
import { activeServiceRegistry, serviceById, type ServiceRegistry } from "../services/registry";
import type { MepSystem } from "./types";

/**
 * How each system looks: its colour on screen (3D and the live plan), and its
 * line pattern and weight on screen and on paper. Every system kind has a
 * standard look (vent dashed, cold water dash-dot, gas long dash, sanitary
 * brown…); a system may override any of the three (a grease waste line drawn
 * heavy, two cold water systems in two blues). Plans, sections, 3D and print
 * all read `systemStyle`, so a change shows everywhere at once.
 */

/** Line patterns a system can draw with: the drafting patterns plumbers use for services. Dashes are paper mm. */
export const SYSTEM_LINE_PATTERNS = ["solid", "dashed", "dotted", "dash_dot", "dash_dot_dot", "dash_dot_dot_dot", "long_dash"] as const;
export type SystemLinePattern = (typeof SYSTEM_LINE_PATTERNS)[number];

export const SYSTEM_PATTERN_DASH: Readonly<Record<SystemLinePattern, readonly number[] | undefined>> = {
  solid: undefined,
  dashed: [4, 2],
  dotted: [0.3, 1],
  dash_dot: [6, 1.5, 1, 1.5],
  dash_dot_dot: [6, 1.5, 1, 1.5, 1, 1.5],
  dash_dot_dot_dot: [6, 1.5, 1, 1.5, 1, 1.5, 1, 1.5],
  long_dash: [10, 2],
};

export const SYSTEM_PATTERN_LABEL: Readonly<Record<SystemLinePattern, string>> = {
  solid: "Solid",
  dashed: "Dashed",
  dotted: "Dotted",
  dash_dot: "Dash dot",
  dash_dot_dot: "Dash dot dot",
  dash_dot_dot_dot: "Dash dot dot dot",
  long_dash: "Long dash",
};

export const SYSTEM_LINE_WEIGHTS = ["thin", "medium", "wide", "heavy"] as const satisfies readonly Pen[];
export type SystemLineWeight = (typeof SYSTEM_LINE_WEIGHTS)[number];

export const SYSTEM_WEIGHT_LABEL: Readonly<Record<SystemLineWeight, string>> = { thin: "Thin", medium: "Medium", wide: "Wide", heavy: "Heavy" };

/** What a system overrides; absent fields take the kind's standard look. */
export interface SystemGraphics {
  /** `#rrggbb`. */
  readonly colour?: string;
  readonly pattern?: SystemLinePattern;
  readonly weight?: SystemLineWeight;
}

export interface SystemStyle {
  readonly colour: string;
  readonly pattern: SystemLinePattern;
  readonly dash: readonly number[] | undefined;
  /** Absent: the drawing's own pens (double-line edges medium, single line wide). */
  readonly weight: SystemLineWeight | undefined;
  /** Which of the three the system set itself. */
  readonly overridden: { readonly colour: boolean; readonly pattern: boolean; readonly weight: boolean };
}

interface KindLook {
  readonly colour: string;
  readonly pattern: SystemLinePattern;
  /** Absent: the drawing's own pens. Only registry rows that ask for one (grease waste draws heavy). */
  readonly weight?: SystemLineWeight;
}

function isPattern(p: string): p is SystemLinePattern {
  return (SYSTEM_LINE_PATTERNS as readonly string[]).includes(p);
}

function isWeight(w: string): w is SystemLineWeight {
  return (SYSTEM_LINE_WEIGHTS as readonly string[]).includes(w);
}

const OTHER_LOOK: KindLook = { colour: "#2ea86b", pattern: "solid" };

/** A service row's standard look (its `graphics`); a row without one, or with a pattern this reader doesn't draw, looks like Other. */
function lookOf(kind: string, registry: ServiceRegistry): KindLook {
  const g = serviceById(kind, registry)?.graphics;
  if (!g) return OTHER_LOOK;
  const pattern = isPattern(g.pattern) ? g.pattern : "solid";
  return { colour: g.colour, pattern, ...(g.weight !== undefined && isWeight(g.weight) ? { weight: g.weight } : {}) };
}

const LOOKS_BY_REGISTRY = new WeakMap<ServiceRegistry, Map<string, KindLook>>();

/**
 * The standard look of a stored kind: its row's in the registry in force (a
 * first-party add-on's `supply_air`, a pack's `civil.storm`), else Other (a
 * newer peer's kind). Colours follow common MEP practice; the round-4 kinds'
 * looks are unchanged (r5s-system-graphics test).
 */
export function systemKindLook(kind: string): KindLook {
  const registry = activeServiceRegistry();
  let byKind = LOOKS_BY_REGISTRY.get(registry);
  if (!byKind) LOOKS_BY_REGISTRY.set(registry, (byKind = new Map()));
  let look = byKind.get(kind);
  if (!look) byKind.set(kind, (look = lookOf(kind, registry)));
  return look;
}

const HEX = /^#[0-9a-f]{6}$/;

/** The look a system draws with: its own overrides over its kind's standard. */
export function systemStyle(system: Pick<MepSystem, "systemKind" | "graphics">): SystemStyle {
  const look = systemKindLook(system.systemKind);
  const g = system.graphics;
  const ownColour = g?.colour !== undefined && HEX.test(g.colour);
  const pattern = g?.pattern ?? look.pattern;
  return {
    colour: ownColour && g?.colour ? g.colour : look.colour,
    pattern,
    dash: SYSTEM_PATTERN_DASH[pattern],
    weight: g?.weight ?? look.weight,
    overridden: { colour: ownColour, pattern: g?.pattern !== undefined, weight: g?.weight !== undefined },
  };
}

/** The style of the system an element belongs to, or null when it has none (a part, a duct segment). */
export function styleOfSystemId(elements: Readonly<Record<string, BimElement>>, systemId: string): SystemStyle | null {
  const s = elements[systemId];
  return s?.kind === "mep_system" ? systemStyle(s) : null;
}

/** `#rrggbb` as the 0xRRGGBB number a renderer takes. */
export function colourNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

const hexSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HEX, "a colour is #rrggbb");

export const systemGraphicsCommandSchemas = [
  z.object({
    type: z.literal("set_system_graphics"),
    systemId: z.string().min(1).max(200),
    /** Null: back to the kind's standard colour. */
    colour: hexSchema.nullable().optional(),
    pattern: z.enum(SYSTEM_LINE_PATTERNS).nullable().optional(),
    weight: z.enum(SYSTEM_LINE_WEIGHTS).nullable().optional(),
  }),
] as const;

export type SystemGraphicsCommand = z.infer<(typeof systemGraphicsCommandSchemas)[number]>;

const GRAPHICS_COMMAND_TYPES: ReadonlySet<string> = new Set(systemGraphicsCommandSchemas.map((s) => s.shape.type.value));

export function isSystemGraphicsCommand(command: { readonly type: string }): command is SystemGraphicsCommand {
  return GRAPHICS_COMMAND_TYPES.has(command.type);
}

function pick<T>(next: T | null | undefined, prior: T | undefined): T | undefined {
  return next === undefined ? prior : (next ?? undefined);
}

export function executeSystemGraphicsCommand(model: ModelState, cmd: SystemGraphicsCommand): ExecuteResult {
  const reader = new TrackedReader(model);
  const system = requireKind(reader.get(asElementId(cmd.systemId)), "mep_system");
  if (cmd.colour === undefined && cmd.pattern === undefined && cmd.weight === undefined) refuse("invalid_value", `Say what to change on ${system.name}: its colour, line pattern or line weight`, [system.id]);
  const given = typeof cmd.colour === "string" ? cmd.colour.trim().toLowerCase() : cmd.colour;
  if (typeof given === "string" && !HEX.test(given)) refuse("invalid_value", `${cmd.colour} isn't a colour; give it as #rrggbb (#1f6fd1)`, [system.id]);
  if (cmd.pattern && !SYSTEM_LINE_PATTERNS.includes(cmd.pattern)) refuse("invalid_value", `${cmd.pattern} isn't a line pattern; use ${SYSTEM_LINE_PATTERNS.join(", ")}`, [system.id]);
  if (cmd.weight && !SYSTEM_LINE_WEIGHTS.includes(cmd.weight)) refuse("invalid_value", `${cmd.weight} isn't a line weight; use ${SYSTEM_LINE_WEIGHTS.join(", ")}`, [system.id]);
  const prior = system.graphics ?? {};
  const colour = pick(given, prior.colour);
  const pattern = pick(cmd.pattern, prior.pattern);
  const weight = pick(cmd.weight, prior.weight);
  const graphics: SystemGraphics = { ...(colour ? { colour } : {}), ...(pattern ? { pattern } : {}), ...(weight ? { weight } : {}) };
  const { graphics: _old, ...base } = system;
  const next: MepSystem = { ...base, ...(Object.keys(graphics).length > 0 ? { graphics } : {}) };
  const working = draftElements(model.elements);
  working[system.id] = next;
  const style = systemStyle(next);
  const said: string[] = [];
  if (cmd.colour !== undefined) said.push(cmd.colour === null ? "its standard colour" : `colour ${style.colour}`);
  if (cmd.pattern !== undefined) said.push(`${SYSTEM_PATTERN_LABEL[style.pattern].toLowerCase()} lines${cmd.pattern === null ? " (standard)" : ""}`);
  if (cmd.weight !== undefined) said.push(cmd.weight === null ? "standard line weight" : `${SYSTEM_WEIGHT_LABEL[cmd.weight].toLowerCase()} lines`);
  const authored: AuthoredWrite[] = [{ elementId: system.id, field: "graphics", value: `${style.colour}|${style.pattern}|${style.weight ?? ""}` }];
  return finish(reader, working, [system.id], authored, () => [], { summary: [`${system.name} now draws with ${said.join(", ")} in 3D, plans and print`] });
}
