import { partConnectorWarnings } from "../part-model/connector-placement";
import { resolveConnectors, type PartTypeDefinition, type ResolvedConnector } from "../parts";
import type { PackSet } from "../packs/set";
import { dist3, dot3, worldConnector } from "../routing/geometry";
import { levelElevationOf } from "../routing/levels-across";
import { runLabel } from "../routing/run-label";
import { connectorDomainOf, sizeWidth } from "../routing/rules";
import type { PortRef, RunFitting, RunPoint, RunSegment, RunSize } from "../routing/types";
import { partLabelOf } from "../routing/validate";
import { isKnownSystemKind, serviceLabel } from "../services/registry";
import { elementsOfKind } from "../store";
import type { BimElement, ElementId, PartInstance } from "../types";
import { articleFor, connectorEndTypeTable, endTypeWords, type ConnectorEndTypeTable } from "./end-types";

/**
 * Connector integrity: how the ends of parts, fittings and runs meet.
 *
 * - **touching, not joined**: two open ends of one domain sit together and
 *   face each other, but nothing links them;
 * - **shape** and **size**: a joined pair of parts whose openings differ
 *   (round meets rectangular; a size step with no transition);
 * - **end type**: the two ends' end types don't join, or join only with a
 *   fitting that isn't there (the add-ons' end-type table decides);
 * - **service**: a joined pair of parts carrying different systems.
 *
 * Where a run meets a part or another run, size, system and domain are
 * already checked by routing validation; only the end type is judged here.
 *
 * Every finding is advice ("should fix"): the lint rules report them and
 * nothing refuses an edit for one. Pure: the same elements give the same
 * findings, worded the same from either side of a pair.
 */

type Elements = Readonly<Record<string, BimElement>>;

export type ConnectorIntegrityCheck = "touching_not_joined" | "shape_mismatch" | "size_mismatch" | "end_type_mismatch" | "service_mismatch";

export interface ConnectorIntegrityIssue {
  readonly check: ConnectorIntegrityCheck;
  /** What a person sees, naming both ends. */
  readonly message: string;
  /** What to do about it. */
  readonly nextStep: string;
  /** The two elements, in the pair's canonical order. */
  readonly elementIds: readonly [ElementId, ElementId];
  readonly ports: readonly [PortRef, PortRef];
  /** Where the ends meet, model coordinates (height above the first end's level). */
  readonly at: RunPoint;
}

/** An opening's cross-section, for comparing two ends. */
export type PortProfile =
  | { readonly shape: "round"; readonly diameter: number }
  | { readonly shape: "rect" | "oval"; readonly width: number; readonly height: number };

/** One end of a part, fitting or run, as the integrity checks read it. */
export interface IntegrityPort {
  readonly ref: PortRef;
  /** Height above its own level (as stored). */
  readonly position: RunPoint;
  /** Height above the model's datum, for comparing ends on different levels. */
  readonly absolute: RunPoint;
  readonly direction: RunPoint;
  /** Null: the end has no size of its own (a part connector with no shape). */
  readonly profile: PortProfile | null;
  readonly endType?: string;
  /** Connector domain (registry id). */
  readonly domain: string;
  readonly systemKind?: string;
  readonly link?: PortRef;
  readonly owner: "part" | "run";
  /** "AHU-1's supply", "the 12×10 run": how a person names this end. */
  readonly words: string;
}

/** Two open ends this close (mm), facing each other, read as touching. */
export const TOUCHING_MM = 3;
/** Facing each other: the angle between their outward directions is at least about 150°. */
const FACING_DOT = -0.85;
/** Openings this close (mm) are the same size. */
const SIZE_TOL_MM = 1;

/** A fitting parameter that stores an end type by id. */
export const END_TYPE_PARAM = "end_type";

const portKey = (r: PortRef): string => `${r.elementId}\u0000${r.port}`;

function profileOfSize(size: RunSize): PortProfile {
  if (size.shape === "rect" || size.shape === "oval") return { shape: size.shape, width: size.width, height: size.height };
  // Every other run size is a round section: its nominal width is its diameter.
  return { shape: "round", diameter: sizeWidth(size) };
}

function profileOfConnector(c: ResolvedConnector): PortProfile | null {
  if (c.shape === "round" && c.diameter !== undefined && c.diameter > 0) return { shape: "round", diameter: c.diameter };
  if (c.shape === "rect" && c.width !== undefined && c.height !== undefined && c.width > 0 && c.height > 0) return { shape: "rect", width: c.width, height: c.height };
  return null;
}

const inches = (mm: number): string => `${Math.round((mm / 25.4) * 100) / 100}`;

/** "12 in round", "12×10 in rectangular". */
export function profileWords(p: PortProfile): string {
  if (p.shape === "round") return `${inches(p.diameter)} in round`;
  return `${inches(p.width)}×${inches(p.height)} in ${p.shape === "rect" ? "rectangular" : "oval"}`;
}

function sameProfile(a: PortProfile, b: PortProfile): boolean {
  if (a.shape === "round" && b.shape === "round") return Math.abs(a.diameter - b.diameter) <= SIZE_TOL_MM;
  if (a.shape !== "round" && b.shape !== "round" && a.shape === b.shape) {
    const close = (x: number, y: number) => Math.abs(x - y) <= SIZE_TOL_MM;
    return (close(a.width, b.width) && close(a.height, b.height)) || (close(a.width, b.height) && close(a.height, b.width));
  }
  return false;
}

function absoluteOf(elements: Elements, levelId: string, p: RunPoint): RunPoint {
  const z = levelElevationOf(elements, levelId);
  return z === 0 ? p : { x: p.x, y: p.y, z: p.z + z };
}

function fittingEndType(f: RunFitting, table: ConnectorEndTypeTable): string | undefined {
  const params = f.params;
  if (!params) return undefined;
  const own = params[END_TYPE_PARAM];
  if (typeof own === "string" && own.length > 0) return own;
  const domain = connectorDomainOf(f.domain);
  for (const param of table.storedParams) {
    const v = params[param];
    if (typeof v === "string") {
      const row = table.resolveStored(param, v, domain);
      if (row) return row.id;
    }
  }
  return undefined;
}

function systemKindOf(elements: Elements, el: RunSegment | RunFitting): string | undefined {
  const s = elements[el.systemId];
  return s?.kind === "mep_system" ? s.systemKind : undefined;
}

/** A type's connectors at its default values, resolved once per definition: most placed parts set no value their connectors read. */
const defaultConnectors = new WeakMap<PartTypeDefinition, readonly ResolvedConnector[]>();

function connectorsOf(def: PartTypeDefinition, values: PartInstance["values"]): readonly ResolvedConnector[] {
  if (Object.keys(values).length > 0) return resolveConnectors(def, values);
  let known = defaultConnectors.get(def);
  if (!known) {
    known = resolveConnectors(def);
    defaultConnectors.set(def, known);
  }
  return known;
}

function partPorts(elements: Elements, part: PartInstance): IntegrityPort[] {
  if (part.planned !== undefined) return [];
  const type = elements[part.typeId];
  if (type?.kind !== "part_type") return [];
  let connectors: readonly ResolvedConnector[];
  try {
    connectors = connectorsOf(type.definition, part.values);
  } catch (err) {
    console.error("[bim-kernel/connector-integrity] a part's connectors could not be resolved; its ends are not checked", { partId: part.id, err });
    return [];
  }
  const name = partLabelOf(elements, part);
  return connectors.map((c) => {
    const w = worldConnector(part, c);
    const link = part.links?.[c.id];
    const profile = profileOfConnector(c);
    return {
      ref: { elementId: part.id, port: c.id },
      position: w.position,
      absolute: absoluteOf(elements, part.levelId, w.position),
      direction: w.direction,
      profile,
      ...(c.endType !== undefined ? { endType: c.endType } : {}),
      domain: c.domain,
      systemKind: c.systemKind,
      ...(link ? { link } : {}),
      owner: "part" as const,
      words: `${name}'s ${c.label.toLowerCase()}`,
    };
  });
}

/** Every end of `el` the checks read: a placed part's connectors, a run's two ends, a fitting's openings. Empty for anything else. */
export function integrityPortsOf(elements: Elements, el: BimElement | undefined, set?: PackSet): IntegrityPort[] {
  if (!el) return [];
  if (el.kind === "part") return partPorts(elements, el);
  if (el.kind === "run_segment") {
    const domain = connectorDomainOf(el.domain);
    const systemKind = systemKindOf(elements, el);
    const words = runLabel(elements, el);
    const profile = profileOfSize(el.size);
    const end = (port: "start" | "end"): IntegrityPort => {
      const at = port === "start" ? el.start : el.end;
      const away = port === "start" ? el.end : el.start;
      const len = dist3(at, away);
      const direction = len === 0 ? { x: 0, y: 0, z: 0 } : { x: (at.x - away.x) / len, y: (at.y - away.y) / len, z: (at.z - away.z) / len };
      const link = el.links[port];
      return { ref: { elementId: el.id, port }, position: at, absolute: absoluteOf(elements, el.levelId, at), direction, profile, domain, ...(systemKind !== undefined ? { systemKind } : {}), ...(link ? { link } : {}), owner: "run", words };
    };
    return [end("start"), end("end")];
  }
  if (el.kind === "run_fitting") {
    const table = connectorEndTypeTable(set);
    const endType = fittingEndType(el, table);
    const domain = connectorDomainOf(el.domain);
    const systemKind = systemKindOf(elements, el);
    const words = runLabel(elements, el);
    return el.ports.map((p) => ({
      ref: { elementId: el.id, port: p.id },
      position: p.position,
      absolute: absoluteOf(elements, el.levelId, p.position),
      direction: p.direction,
      profile: profileOfSize(p.size),
      ...(endType !== undefined ? { endType } : {}),
      domain,
      ...(systemKind !== undefined ? { systemKind } : {}),
      ...(p.link ? { link: p.link } : {}),
      owner: "run" as const,
      words,
    }));
  }
  return [];
}

/** The two ends in their canonical order (lower element, then port), so both sides word a pair the same. */
function ordered(a: IntegrityPort, b: IntegrityPort): readonly [IntegrityPort, IntegrityPort] {
  return portKey(a.ref) <= portKey(b.ref) ? [a, b] : [b, a];
}

function issue(check: ConnectorIntegrityCheck, pair: readonly [IntegrityPort, IntegrityPort], message: string, nextStep: string): ConnectorIntegrityIssue {
  const [a, b] = pair;
  return { check, message, nextStep, elementIds: [a.ref.elementId, b.ref.elementId], ports: [a.ref, b.ref], at: a.position };
}

/** Two ends that are linked to each other: end type always; shape, size and service when both are parts (routing validation checks every pair with a run in it). */
export function jointIntegrityIssues(x: IntegrityPort, y: IntegrityPort, set?: PackSet): ConnectorIntegrityIssue[] {
  const pair = ordered(x, y);
  const [a, b] = pair;
  const out: ConnectorIntegrityIssue[] = [];
  const table = connectorEndTypeTable(set);
  const join = table.join(a.endType, b.endType);
  if (join.kind === "mismatch" || join.kind === "via") {
    const ra = a.endType !== undefined ? table.row(a.endType) : undefined;
    const rb = b.endType !== undefined ? table.row(b.endType) : undefined;
    const wa = ra ? endTypeWords(ra) : (a.endType ?? "");
    const wb = rb ? endTypeWords(rb) : (b.endType ?? "");
    const lead = `${a.words} has ${articleFor(wa)} ${wa} end where it meets ${b.words}, ${articleFor(wb)} ${wb} end`;
    out.push(
      join.kind === "via"
        ? issue("end_type_mismatch", pair, `${lead}; they join only with ${articleFor(join.fitting)} ${join.fitting}`, `Add ${articleFor(join.fitting)} ${join.fitting} between them, or change one end type`)
        : issue("end_type_mismatch", pair, `${lead}; those ends don't join`, "Change one end type in its part type, or put a fitting made for both between them"),
    );
  }
  if (a.owner !== "part" || b.owner !== "part") return out;
  if (a.domain !== b.domain) {
    out.push(issue("service_mismatch", pair, `${a.words} takes ${a.domain} but is joined to ${b.words}, which takes ${b.domain}`, "Join it to an opening of its own kind, or change the connector's domain"));
    return out;
  }
  if (a.systemKind !== undefined && b.systemKind !== undefined && a.systemKind !== b.systemKind) {
    out.push(
      issue(
        "service_mismatch",
        pair,
        `${a.words} carries ${serviceLabel(a.systemKind).toLowerCase()} but is joined to ${b.words}, which carries ${serviceLabel(b.systemKind).toLowerCase()}`,
        "Join it to a part on the same system, or change one connector's system",
      ),
    );
  }
  if (a.profile && b.profile && !sameProfile(a.profile, b.profile)) {
    const shapeDiffers = (a.profile.shape === "round") !== (b.profile.shape === "round") || a.profile.shape !== b.profile.shape;
    out.push(
      shapeDiffers
        ? issue("shape_mismatch", pair, `${a.words} (${profileWords(a.profile)}) meets ${b.words} (${profileWords(b.profile)})`, "Put a transition between them, or change one connector's shape")
        : issue("size_mismatch", pair, `${a.words} (${profileWords(a.profile)}) meets ${b.words} (${profileWords(b.profile)}) with no transition`, "Put a transition between them, or resize one"),
    );
  }
  return out;
}

/** Two open ends of one domain that sit together and face each other: touching but not joined. */
export function touchingIssue(x: IntegrityPort, y: IntegrityPort): ConnectorIntegrityIssue | null {
  if (x.ref.elementId === y.ref.elementId || x.link || y.link || x.domain !== y.domain) return null;
  if (dist3(x.absolute, y.absolute) > TOUCHING_MM) return null;
  if (dot3(x.direction, y.direction) > FACING_DOT) return null;
  const pair = ordered(x, y);
  return issue("touching_not_joined", pair, `${pair[0].words} and ${pair[1].words} touch but aren't joined`, "Connect them (drag one end onto the other), or move one away");
}

/** The other end a link names, or null when it is gone. */
function linkedPort(elements: Elements, ref: PortRef, set: PackSet | undefined): IntegrityPort | null {
  return integrityPortsOf(elements, elements[ref.elementId], set).find((p) => p.ref.port === ref.port) ?? null;
}

/**
 * Integrity findings that name `el`'s ends. `near(at, radius)` lists ids of
 * elements whose bodies may hold an end within `radius` mm of `at` (absolute
 * coordinates): a spatial index on an edit, a scan in a test.
 */
export function elementIntegrityIssues(elements: Elements, el: BimElement, near: (at: RunPoint, radius: number) => Iterable<string>, set?: PackSet): ConnectorIntegrityIssue[] {
  const out: ConnectorIntegrityIssue[] = [];
  for (const port of integrityPortsOf(elements, el, set)) {
    if (port.link) {
      const other = linkedPort(elements, port.link, set);
      if (other && other.link?.elementId === el.id && other.link.port === port.ref.port) out.push(...jointIntegrityIssues(port, other, set));
      continue;
    }
    for (const id of near(port.absolute, TOUCHING_MM)) {
      if (id === el.id) continue;
      for (const other of integrityPortsOf(elements, elements[id], set)) {
        const found = touchingIssue(port, other);
        if (found) out.push(found);
      }
    }
  }
  return out;
}

/** Every integrity finding in a model, each pair once (a spatial hash of open ends; linked pairs from their lower end). */
export function modelIntegrityIssues(elements: Elements, set?: PackSet): ConnectorIntegrityIssue[] {
  const out: ConnectorIntegrityIssue[] = [];
  const cell = TOUCHING_MM * 4;
  const open = new Map<string, IntegrityPort[]>();
  const cellOf = (p: RunPoint) => [Math.floor(p.x / cell), Math.floor(p.y / cell), Math.floor(p.z / cell)] as const;
  const all: IntegrityPort[] = [];
  const byElement = new Map<string, readonly IntegrityPort[]>();
  // Only parts, runs and fittings have ends: read them through the kernel's kind index, not a pass over every record.
  for (const el of elementsOfKind(elements, "part", "run_segment", "run_fitting")) {
    const ports = integrityPortsOf(elements, el, set);
    if (ports.length === 0) continue;
    byElement.set(el.id, ports);
    for (const port of ports) {
      all.push(port);
      if (port.link) continue;
      const [cx, cy, cz] = cellOf(port.absolute);
      const key = `${cx},${cy},${cz}`;
      const list = open.get(key);
      if (list) list.push(port);
      else open.set(key, [port]);
    }
  }
  for (const port of all) {
    if (port.link) {
      if (portKey(port.ref) > portKey(port.link)) continue;
      const target = port.link;
      const other = byElement.get(target.elementId)?.find((p) => p.ref.port === target.port) ?? null;
      if (other && other.link?.elementId === port.ref.elementId && other.link.port === port.ref.port) out.push(...jointIntegrityIssues(port, other, set));
      continue;
    }
    const [cx, cy, cz] = cellOf(port.absolute);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const other of open.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (portKey(other.ref) <= portKey(port.ref)) continue;
            const found = touchingIssue(port, other);
            if (found) out.push(found);
          }
        }
  }
  return out;
}

// ── Part-type report ─────────────────────────────────────────────────────────

export type PartImportCheck = "missing_size" | "wrong_facing" | "no_service" | "no_end_type" | "unknown_end_type" | "end_type_wrong_domain" | "converted_without_size";

export interface PartImportProblem {
  readonly connectorId: string;
  /** The connector as the person sees it in the part editor ("Supply", "Opening 2"). */
  readonly connectorLabel: string;
  readonly check: PartImportCheck;
  readonly message: string;
  readonly nextStep: string;
}

/** Bad connectors on one part type, listed before it is saved. Saving is still allowed: the report goes with the type and its placed parts show the issues. */
export interface PartImportReport {
  readonly familyName: string;
  readonly typeName: string;
  readonly connectorCount: number;
  readonly problems: readonly PartImportProblem[];
}

/** Problems a converter found that the saved definition can no longer show (an opening the source said was round, with no size). */
export interface ConverterConnectorNote {
  readonly connectorId: string;
  readonly connectorLabel: string;
  readonly message: string;
}

const isPlaceholderService = (kind: string): boolean => kind === "other" || kind.length === 0;

function choiceWords(labels: readonly string[]): string {
  const words = labels.map((l) => endTypeWords({ label: l }));
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/**
 * Every connector problem on a part type, before it is saved: no size, a
 * direction that points nowhere or into the part, no system, no end type
 * where the add-ons in force declare end types for its domain, or an end
 * type they don't know. `placement` is the type's placement warnings
 * (`partConnectorWarnings`), each starting with a size and the connector's label.
 */
export function partImportReport(
  def: { readonly familyName: string; readonly typeName: string; readonly connectors: readonly { readonly id: string; readonly label: string }[] },
  resolved: readonly ResolvedConnector[],
  options: { readonly placement?: readonly string[]; readonly notes?: readonly ConverterConnectorNote[]; readonly isKnownSystem?: (kind: string) => boolean; readonly set?: PackSet } = {},
): PartImportReport {
  const table = connectorEndTypeTable(options.set);
  const problems: PartImportProblem[] = [];
  const seen = new Set<string>();
  const add = (c: { readonly id: string; readonly label: string }, check: PartImportCheck, message: string, nextStep: string) => {
    const key = `${c.id}\u0000${check}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ connectorId: c.id, connectorLabel: c.label, check, message, nextStep });
  };
  for (const note of options.notes ?? []) problems.push({ connectorId: note.connectorId, connectorLabel: note.connectorLabel, check: "converted_without_size", message: note.message, nextStep: `Give ${note.connectorLabel} its size in the part editor` });
  for (const c of resolved) {
    const label = c.label;
    if (c.shape === "round" && !(c.diameter !== undefined && c.diameter > 0)) add(c, "missing_size", `${label} is round but has no diameter`, `Enter ${label}'s diameter`);
    else if (c.shape === "rect" && !(c.width !== undefined && c.height !== undefined && c.width > 0 && c.height > 0)) add(c, "missing_size", `${label} is rectangular but has no width and height`, `Enter ${label}'s width and height`);
    else if (c.shape === "none" && c.endType !== undefined) add(c, "missing_size", `${label} has an end type but no size, so nothing can check what it joins`, `Give ${label} a shape and size`);
    const [dx, dy, dz] = c.direction;
    if (Math.hypot(dx, dy, dz) < 1e-6) add(c, "wrong_facing", `${label} points nowhere (its direction is zero)`, `Set ${label}'s direction to point out of the part`);
    if (isPlaceholderService(c.systemKind) || (options.isKnownSystem && !options.isKnownSystem(c.systemKind))) {
      add(c, "no_service", isPlaceholderService(c.systemKind) ? `${label} carries no system` : `${label} carries "${c.systemKind}", which no add-on here knows`, `Choose the system ${label} carries`);
    }
    if (c.endType === undefined) {
      if (table.declaresDomain(c.domain)) {
        const choices = table.forDomain(c.domain).filter((r) => r.domains !== undefined).map((r) => r.label);
        add(c, "no_end_type", `${label} has no end type`, `Choose ${label}'s end type (${choiceWords(choices)})`);
      }
    } else {
      const row = table.row(c.endType);
      if (!row) add(c, "unknown_end_type", `${label}'s end type "${c.endType}" isn't one the add-ons here declare; it is kept, but nothing checks what it joins`, `Choose one of the end types listed for ${label}, or turn on the add-on that declares it`);
      else if (row.domains !== undefined && !row.domains.includes(c.domain)) add(c, "end_type_wrong_domain", `${label} takes ${c.domain}, but ${articleFor(endTypeWords(row))} ${endTypeWords(row)} end is made for ${row.domains.join(" or ")}`, `Choose an end type made for ${c.domain}`);
    }
  }
  for (const warning of options.placement ?? []) {
    const c = def.connectors.find((x) => warning.includes(`: ${x.label} `));
    if (c) add(c, "wrong_facing", warning.replace(/^[^:]*: /, ""), `Move ${c.label} onto a face of the part, pointing out`);
  }
  return { familyName: def.familyName, typeName: def.typeName, connectorCount: def.connectors.length, problems };
}

/** `partImportReport` for a definition as the part editor and the library hold it: its connectors at default values, its placement warnings, the registry's systems. */
export function partTypeImportReport(def: PartTypeDefinition, options: { readonly notes?: readonly ConverterConnectorNote[]; readonly set?: PackSet } = {}): PartImportReport {
  let resolved: ResolvedConnector[];
  let placement: string[];
  try {
    resolved = resolveConnectors(def);
    placement = partConnectorWarnings(def);
  } catch (err) {
    console.error("[bim-kernel/part-import-report] the part type's connectors could not be resolved", { typeName: def.typeName, err });
    return {
      familyName: def.familyName,
      typeName: def.typeName,
      connectorCount: def.connectors.length,
      problems: def.connectors.map((c) => ({ connectorId: c.id, connectorLabel: c.label, check: "missing_size" as const, message: `${c.label}'s size doesn't work out from the type's values`, nextStep: "Check the size formulas and the type's values" })),
    };
  }
  return partImportReport(def, resolved, { placement, ...(options.notes ? { notes: options.notes } : {}), isKnownSystem: (kind) => isKnownSystemKind(kind), ...(options.set ? { set: options.set } : {}) });
}
