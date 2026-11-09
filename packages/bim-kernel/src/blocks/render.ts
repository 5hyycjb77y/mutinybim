import { documentIndex } from "../commands/views";
import type { DrawingItem } from "../documents";
import { fieldProviderRegistry } from "../fields/providers";
import { isResolvableFieldPath, resolveField, type FieldOptions } from "../fields/resolver";
import { fillTemplate, parseFieldTemplate, type TemplatePart } from "../fields/template";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";
import { recognizes } from "../registry/recognition";
import type { FieldValue, ObjectClass, Registry } from "../registry/types";
import type { BimElement, ElementId, ModelState, PartInstance } from "../types";
import { renderCalcBlock, type CalcBlockContext } from "./calc-block";
import { BLOCK_DEPENDENCY_POINT } from "./dependency-point";
import { renderTableBlock } from "./table-block";
import type { BlockFreshness, BlockSnapshot, FieldBlockSpec, RenderedBlock } from "./types";

/**
 * Field-bound text blocks (ROADMAP F5): a paragraph whose `{field}` tokens
 * read the model, rendered the same way on screen, in the PDF and for the
 * agent. Every line is a field template (`fields/template.ts`); newlines are
 * kept. A token that reads nothing prints "—" and is listed in `unresolved`,
 * so the editor can say which; `{path|text}` prints `text` instead.
 *
 * Paths resolve from the block's subject (a panel, a device, a circuit). The
 * `service.` hop climbs to the top of the subject's supply chain, the
 * service entrance; with no subject it is the project's main service. After
 * the shared resolver (fields/resolver.ts), a path falls back to the field
 * registry's readers, so a field a provider registers later on the subject's
 * class (allocated vs actual totals) prints with no change here.
 *
 * `dependsOn` lists every element whose change can change the text: the
 * subject, the service and the distribution below each one read (feeders,
 * circuits, what is on them, their types and catalog rows). It is a walk of
 * the subtree the block reads, never a scan of the model.
 */

export const UNRESOLVED_TOKEN_TEXT = "—";
export const SERVICE_HOP = "service";
/** Lines a block may hold; each line is one template (at most 400 characters, the template limit). */
export const BLOCK_MAX_LINES = 40;

/** The live load summary the "Insert › Load summary block" command places (Electrical Demo 1, 8:20). */
export const LOAD_SUMMARY_TEMPLATE = [
  "Total connected {service.connected_kva} kVA = {service.connected_a} A at {service.voltage_system}",
  "Demand {service.demand_kva} kVA = {service.demand_a} A ({service.rules})",
  "Service {service.name}: {service.bus} bus, {service.mains_text}",
].join("\n");
export const LOAD_SUMMARY_TITLE = "ELECTRICAL LOAD SUMMARY";

type Elements = Readonly<Record<string, BimElement>>;

export interface BlockRenderOptions extends Pick<FieldOptions, "rules"> {
  /** The field registry to fall back to (a firm library layered on the kernel's). Absent: the kernel registry. */
  readonly registry?: Registry;
  /** The firm's and project's tables and limits a calculation block reads (the host's library). Absent: no tables, add-on default limits. */
  readonly calc?: CalcBlockContext;
}

/** Why a template can't be used, in words, or null when every line parses. */
export function fieldBlockTemplateProblem(template: string): string | null {
  const lines = template.split(/\r?\n/);
  if (lines.length > BLOCK_MAX_LINES) return `A block has at most ${BLOCK_MAX_LINES} lines; this one has ${lines.length}.`;
  if (template.trim() === "") return "A block needs some text.";
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFieldTemplate(lines[i] as string);
    if (!parsed.ok) return `Line ${i + 1}: ${parsed.error}.`;
  }
  return null;
}

// ------------------------------------------------------------------ subjects

function partOf(elements: Elements, id: string | undefined): PartInstance | null {
  const el = id ? elements[id] : undefined;
  return el?.kind === "part" ? el : null;
}

/**
 * A hop a token path may start with (v1): `{service.name}` climbs from the
 * block's subject to another element before reading. The pack that owns the
 * chain says where the hop lands; with no subject, its project-wide answer.
 */
export interface BlockHopDef {
  /** The word a token starts with ("service"); stored in templates, so bare. */
  readonly id: string;
  target(model: Pick<ModelState, "elements">, subjectId: ElementId | undefined, opts: Pick<FieldOptions, "rules">): ElementId | null;
}

/** Block hops, by the word a token path starts with. */
export const BLOCK_HOP_POINT = defineExtensionPoint<BlockHopDef>({ id: "kernel.block_hop", version: 1, label: "Block hops", idOf: (h) => h.id, namespaced: false });

export { BLOCK_DEPENDENCY_POINT, type BlockDependencyDef } from "./dependency-point";

function blockHop(id: string): BlockHopDef | null {
  const set = activePackSet();
  return set.memo("kernel.block_hop#table", () => new Map(set.items(BLOCK_HOP_POINT).map((h) => [h.id, h] as const))).get(id) ?? null;
}

/** The top of a subject's supply chain (the service entrance), or the project's main service with no subject: the `service` hop of the set in force, null when no pack in it has one. */
export function serviceOf(model: Pick<ModelState, "elements">, subjectId: ElementId | undefined, opts: Pick<FieldOptions, "rules"> = {}): ElementId | null {
  return blockHop(SERVICE_HOP)?.target(model, subjectId, opts) ?? null;
}

// ------------------------------------------------------------------ registry fallback

const classCache = new WeakMap<Registry, readonly ObjectClass[]>();

function recognizedClasses(registry: Registry, el: BimElement, elements: Elements): ObjectClass[] {
  let classes = classCache.get(registry);
  if (!classes) {
    classes = registry.listClasses({ includeAbstract: true });
    classCache.set(registry, classes);
  }
  return classes.filter((c) => recognizes(c, el, elements));
}

function registryText(v: FieldValue): string {
  if (v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v.trim();
  return String(v.length);
}

function registryField(registry: Registry, elements: Elements, id: ElementId, path: string): string {
  const el = elements[id];
  if (!el) return "";
  for (const cls of recognizedClasses(registry, el, elements)) {
    const def = registry.field(cls.id, path);
    if (!def?.read) continue;
    try {
      const text = registryText(def.read(el, { elements }));
      if (text) return text;
    } catch (err) {
      console.error("[blocks] a registry field reader failed; the token reads empty", { elementId: id, path, err });
    }
  }
  return "";
}

// ------------------------------------------------------------------ render

function fallbackPaths(parts: readonly TemplatePart[], out: Set<string>): Set<string> {
  for (const p of parts) {
    if (p.kind === "field" && p.fallback !== undefined) out.add(p.path);
    else if (p.kind === "group") fallbackPaths(p.parts, out);
  }
  return out;
}

/**
 * Render a block against a model, deterministically: the same elements give
 * the same text, unresolved list and dependencies, in the same order.
 */
export function renderFieldBlock(model: Pick<ModelState, "elements">, spec: FieldBlockSpec, opts: BlockRenderOptions = {}): RenderedBlock {
  if (spec.calc) return renderCalcBlock(model, spec.calc, spec.subjectId, opts.calc);
  if (spec.table) return renderTableBlock(model, spec.table);
  const elements = model.elements;
  const registry = opts.registry ?? fieldProviderRegistry();
  const fieldOpts: FieldOptions = opts.rules === undefined ? {} : { rules: opts.rules };
  const deps = new Set<ElementId>();
  const unresolved: string[] = [];
  const hopTargets = new Map<string, ElementId | null>();
  const readFrom = new Set<ElementId>();
  if (spec.subjectId !== undefined) {
    deps.add(spec.subjectId);
    if (elements[spec.subjectId]) readFrom.add(spec.subjectId);
  }

  const value = (path: string): string => {
    let id: ElementId | null = spec.subjectId ?? null;
    let rest = path;
    const dot = path.indexOf(".");
    const hop = blockHop(dot < 0 ? path : path.slice(0, dot));
    if (hop) {
      if (!hopTargets.has(hop.id)) hopTargets.set(hop.id, hop.target(model, spec.subjectId, fieldOpts));
      id = hopTargets.get(hop.id) ?? null;
      rest = dot < 0 ? "name" : path.slice(dot + 1);
    }
    if (!id || !elements[id]) return "";
    readFrom.add(id);
    const resolved = resolveField(elements, id, rest, fieldOpts).text;
    if (resolved) return resolved;
    return isResolvableFieldPath(rest) && rest.includes(".") ? "" : registryField(registry, elements, id, rest);
  };

  const lines = spec.template.split(/\r?\n/).map((line) => {
    const parsed = parseFieldTemplate(line);
    // A line that doesn't parse prints as written, so a typo shows on the sheet rather than vanishing.
    if (!parsed.ok) return line;
    const withFallback = fallbackPaths(parsed.parts, new Set());
    const filled = fillTemplate(parsed.parts, (p) => {
      const v = value(p);
      if (v || withFallback.has(p)) return v;
      if (!unresolved.includes(p)) unresolved.push(p);
      return UNRESOLVED_TOKEN_TEXT;
    });
    return filled.text.replace(/[ \t]{2,64}/g, " ").trimEnd();
  });

  const dependencyRows = activePackSet().items(BLOCK_DEPENDENCY_POINT);
  for (const id of readFrom) {
    deps.add(id);
    if (!dependencyRows.some((d) => d.collect(elements, id, deps))) {
      const part = partOf(elements, id);
      if (part) deps.add(part.typeId);
    }
  }
  for (const target of hopTargets.values()) if (target) deps.add(target);
  return { text: lines.join("\n"), unresolved, dependsOn: [...deps].sort() };
}

/** Whether a committed change can change a rendered block (incremental re-render). */
export function blockAffectedBy(rendered: Pick<RenderedBlock, "dependsOn">, changedIds: Iterable<string>): boolean {
  const deps = new Set<string>(rendered.dependsOn);
  for (const id of changedIds) if (deps.has(id)) return true;
  return false;
}

export { blockHashInput } from "./hash";

/** The live field blocks drawn on a sheet, in item order. */
export function sheetFieldBlocks(model: Pick<ModelState, "elements" | "connections">, sheetId: ElementId): DrawingItem[] {
  return (documentIndex(model).itemsByOwner.get(sheetId) ?? []).filter((it) => it.shape === "field_block" && it.block !== undefined && !it.deleted).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A block's state against its latest issue snapshot: live (never issued),
 * frozen and current (the live value hashes the same), or changed since.
 */
export function blockFreshness(liveHash: string, snapshot: Pick<BlockSnapshot, "valueHash"> | null, issueLabel: string): BlockFreshness {
  if (!snapshot) return { state: "live" };
  return snapshot.valueHash === liveHash ? { state: "frozen_current", issueLabel } : { state: "changed_since", issueLabel };
}

/** "Changed since SD issue" / "Frozen at SD issue" / "Live": the badge text. */
export function blockFreshnessLabel(f: BlockFreshness): string {
  switch (f.state) {
    case "live":
      return "Live";
    case "frozen_current":
      return `Matches ${f.issueLabel} issue`;
    case "changed_since":
      return `Changed since ${f.issueLabel} issue`;
  }
}
