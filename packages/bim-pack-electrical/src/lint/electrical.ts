import { NEC_IGNITABLE_MATERIAL } from "@permitzip/bim-calc";
import { faultCurrentAt } from "../calc/fault-current";
import { fedFromTextMismatch, fedFromTextUnlinked } from "../connections/fed-from";
import { distributionOf } from "../connections/systems";
import { electricalDiagramGraph } from "../diagrams/electrical-graph";
import { containsPoint, evaluateDiagram, linkServing, pinnedUse, spaceLabel, spaceOutlines, spacesOnLevel, type BimElement, type PartInstance, type Space } from "@permitzip/bim-kernel";
import { clip, feet, type RuleContext, type RuleDef } from "@permitzip/bim-lint";

/**
 * Electrical distribution: equipment nothing feeds, a one-line drawing a
 * utility above a panel that isn't fed (bug log #28), and a typed "Fed
 * from" that disagrees with the live feeder or names a source when nothing
 * feeds it (#29). Written against what the
 * model and the drawing say, so they go quiet once those are fixed.
 */

/** Kinds that start a service: nothing feeds them by design. */
const SERVICE_KINDS = new Set(["switchboard", "meter", "generator"]);

function atOf(ctx: RuleContext, id: string) {
  const b = ctx.body(id);
  const el = ctx.model.elements[id];
  return { level: el ? ctx.levelNameOf(el) : "", x_ft: b ? feet((b.box.min.x + b.box.max.x) / 2) : 0, y_ft: b ? feet((b.box.min.y + b.box.max.y) / 2) : 0, z_ft: b ? feet(b.box.min.z) : 0 };
}

const distributionRules: readonly RuleDef[] = [
  {
    id: "not-fed",
    version: 1,
    pack: "electrical",
    severity: "warning",
    title: "Distribution equipment with no supply",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      const info = distributionOf(ctx.model.elements, el);
      if (!info || SERVICE_KINDS.has(info.kind) || info.input === null) return;
      if (linkServing(ctx.model.elements, el.id, info.input)) return;
      ctx.emit({ rule: "not-fed", severity: "warning", elementIds: [el.id], at: atOf(ctx, el.id), message: clip(`${info.name} is not fed from anything`), fix: { tool: "bim_feed_panel", hint: `feed ${info.name} from the panel or board that serves it` } });
    },
  },
  {
    id: "fed-from-text-mismatch",
    version: 2,
    pack: "electrical",
    severity: "warning",
    title: "A typed Fed from that disagrees with the live feeder, or names a source when nothing feeds it",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part") return;
      const info = distributionOf(ctx.model.elements, el);
      const name = info?.name ?? el.mark;
      const unlinked = info && !SERVICE_KINDS.has(info.kind) ? fedFromTextUnlinked(ctx.model.elements, el.id) : null;
      if (unlinked) {
        ctx.emit({ rule: "fed-from-text-mismatch", severity: "warning", elementIds: [el.id], at: atOf(ctx, el.id), message: clip(`${name}'s typed Fed from says ${unlinked.typed} but nothing feeds it`), fix: { tool: "bim_feed_panel", hint: clip(`feed ${name} from ${unlinked.typed}, or clear the typed Fed from`, 120) } });
        return;
      }
      // The same test the printed schedule uses to flag the typed text, so lint and the sheet agree.
      const mismatch = fedFromTextMismatch(ctx.model.elements, el.id);
      if (!mismatch) return;
      ctx.emit({ rule: "fed-from-text-mismatch", severity: "warning", elementIds: [el.id], at: atOf(ctx, el.id), message: clip(`${name}'s typed Fed from says ${mismatch.typed} but it is fed from ${mismatch.linkedSourceName}`), fix: { tool: "bim_set_parameters", hint: "clear the typed Fed from; the live feeder prints" } });
    },
  },
  {
    id: "phantom-utility",
    version: 1,
    pack: "electrical",
    severity: "error",
    title: "A one-line draws a utility above equipment that isn't fed",
    scope: "document",
    kinds: ["view"],
    run: (ctx, el) => {
      if (el.kind !== "view" || el.deleted) return;
      const def = el.props?.diagram;
      if (!def || def.kind !== "one_line") return;
      let drawn = 0;
      let expected = 0;
      const unfed: string[] = [];
      try {
        const evaluation = evaluateDiagram(ctx.model.elements, el);
        if (!evaluation) return;
        const textOf = (i: (typeof evaluation.items)[number]) => i.text ?? (i.note?.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n");
        drawn = evaluation.items.filter((i) => i.shape === "text" && /^UTILITY( \(|\n|$)/.test(textOf(i).trim())).length;
        const graph = electricalDiagramGraph(ctx.model.elements, def.hints);
        const notFed = new Set(graph.warnings.filter((w) => w.kind === "not_fed").map((w) => w.elementId as string));
        for (const r of graph.roots) {
          if (r.kind === "utility" || r.kind === "generator") continue;
          if (r.elementId && notFed.has(r.elementId)) unfed.push(r.elementId);
          else if (def.hints?.utility !== false) expected += 1;
        }
      } catch (err) {
        console.error("[bim-lint] a one-line could not be evaluated", { viewId: el.id, err });
        return;
      }
      if (drawn <= expected || unfed.length === 0) return;
      ctx.emit({
        rule: "phantom-utility",
        severity: "error",
        elementIds: [el.id, ...unfed.slice(0, 4)],
        at: { level: "", x_ft: 0, y_ft: 0, z_ft: 0 },
        message: clip(`One-line ${el.name} draws a utility above ${unfed.map((id) => ctx.name(id)).slice(0, 3).join(", ")}, which nothing feeds`),
        fix: { tool: "bim_feed_panel", hint: "feed it, or turn the utility hint off for this diagram" },
      });
    },
  },
];

/** Overcurrent devices for 240.24(D): equipment with breakers or fuses. */
const OCPD_KINDS = new Set(["panelboard", "switchboard", "disconnect"]);

function wordsIn(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** Why a space keeps easily ignitable material (its use, or failing that its name), or null. */
function ignitableReason(space: Space): string | null {
  const use = pinnedUse(space);
  const useId = space.use?.useId;
  if (useId && (NEC_IGNITABLE_MATERIAL.useIds as readonly string[]).includes(useId)) return `its use is ${use?.name ?? useId}`;
  const hit = (text: string) => NEC_IGNITABLE_MATERIAL.words.find((w) => wordsIn(text).includes(` ${w} `));
  if (use?.name && hit(use.name)) return `its use is ${use.name}`;
  if (!space.use && hit(space.name)) return `its name is ${space.name} (no use set)`;
  return null;
}

function ocpdOf(ctx: RuleContext, el: BimElement): { readonly part: PartInstance; readonly name: string } | null {
  if (el.kind !== "part" || el.planned !== undefined) return null;
  const info = distributionOf(ctx.model.elements, el);
  return info && OCPD_KINDS.has(info.kind) ? { part: el, name: info.name } : null;
}

function segmentMeetsBox(a: { x: number; y: number }, b: { x: number; y: number }, box: { x0: number; y0: number; x1: number; y1: number }): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clipT = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clipT(-dx, a.x - box.x0) && clipT(dx, box.x1 - a.x) && clipT(-dy, a.y - box.y0) && clipT(dy, box.y1 - a.y);
}

/** Inside the space, or within the vicinity distance of its outline (plan). */
function nearSpace(ctx: RuleContext, part: PartInstance, space: Space): "in" | "next to" | null {
  const body = ctx.body(part.id);
  const center = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2 } : part.position;
  const outlines = spaceOutlines(ctx.model.elements, space);
  if (outlines.some((o) => containsPoint(o, center))) return "in";
  const r = NEC_IGNITABLE_MATERIAL.vicinityMm;
  const box = body ? { x0: body.box.min.x - r, y0: body.box.min.y - r, x1: body.box.max.x + r, y1: body.box.max.y + r } : { x0: center.x - r, y0: center.y - r, x1: center.x + r, y1: center.y + r };
  for (const o of outlines) {
    for (let i = 0; i < o.length; i++) {
      const a = o[i];
      const b = o[(i + 1) % o.length];
      if (a && b && segmentMeetsBox(a, b, box)) return "next to";
    }
  }
  return null;
}

function emitIgnitable(ctx: RuleContext, ocpd: { readonly part: PartInstance; readonly name: string }, space: Space, where: "in" | "next to", why: string): void {
  const label = spaceLabel(space);
  ctx.emit({
    rule: "ocpd-ignitable-material",
    severity: where === "in" ? "error" : "warning",
    elementIds: [ocpd.part.id, space.id],
    at: atOf(ctx, ocpd.part.id),
    message: clip(`${ocpd.name} is ${where} ${label} (${why}): ${NEC_IGNITABLE_MATERIAL.clause}, not near easily ignitable material`),
    fix: { tool: "bim_move_elements", hint: clip(`move ${ocpd.name} out of ${label}, or set the space's use if it is not a clothes closet or laundry`, 120) },
  });
}

const ignitableMaterialRules: readonly RuleDef[] = [
  {
    id: "ocpd-ignitable-material",
    version: 1,
    pack: "electrical",
    severity: "error",
    title: "A panel or other overcurrent device in or next to a clothes closet or laundry (NEC 240.24(D))",
    scope: "element",
    kinds: ["part", "space"],
    run: (ctx, el) => {
      if (el.kind === "space") {
        // A space whose use or outline changed: the panels near it, read from the body grid around its outline.
        if (ctx.changed.size === 0) return;
        const why = ignitableReason(el);
        if (!why || !el.levelId) return;
        const pts = spaceOutlines(ctx.model.elements, el).flat();
        if (pts.length === 0) return;
        const r = NEC_IGNITABLE_MATERIAL.vicinityMm;
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const box = { min: { x: Math.min(...xs) - r, y: Math.min(...ys) - r, z: -1e7 }, max: { x: Math.max(...xs) + r, y: Math.max(...ys) + r, z: 1e7 } };
        for (const b of ctx.bodiesNear(box)) {
          const other = b.elementId ? ctx.model.elements[b.elementId] : undefined;
          const ocpd = other ? ocpdOf(ctx, other) : null;
          if (!ocpd || ocpd.part.levelId !== el.levelId) continue;
          const where = nearSpace(ctx, ocpd.part, el);
          if (where) emitIgnitable(ctx, ocpd, el, where, why);
        }
        return;
      }
      const ocpd = ocpdOf(ctx, el);
      if (!ocpd) return;
      for (const space of spacesOnLevel(ctx.model.elements, ocpd.part.levelId)) {
        const why = ignitableReason(space);
        if (!why) continue;
        const where = nearSpace(ctx, ocpd.part, space);
        if (where) emitIgnitable(ctx, ocpd, space, where, why);
      }
    },
  },
];

const faultCurrentRules: readonly RuleDef[] = [
  {
    id: "aic-below-available",
    version: 1,
    pack: "electrical",
    severity: "error",
    title: "A panel whose interrupting rating is below the fault current available at it (NEC 110.9)",
    scope: "element",
    kinds: ["part"],
    run: (ctx, el) => {
      if (el.kind !== "part" || el.planned !== undefined) return;
      const node = faultCurrentAt(ctx.model.elements, el.id);
      if (!node || node.passes !== false || node.availableA === null || node.ratingA === null) return;
      ctx.emit({
        rule: "aic-below-available",
        severity: "error",
        elementIds: [el.id],
        at: atOf(ctx, el.id),
        message: clip(`${node.name}: ${Math.round(node.ratingA / 100) / 10} kAIC is below the ${Math.round(node.availableA).toLocaleString("en-US")} A available (NEC 110.9): ${node.chain.join(" → ")}`),
        fix: { tool: "bim_set_parameters", hint: clip(`raise ${node.name}'s interrupting rating (aic) to at least ${Math.ceil(node.availableA / 1000)} kA, or add impedance upstream`, 120) },
      });
    },
  },
];

/** Distribution, then NEC 240.24(D), then fault current (the order the Coordination panel groups them). */
export const electricalRules: readonly RuleDef[] = [...distributionRules, ...ignitableMaterialRules, ...faultCurrentRules];

export const processRules: readonly RuleDef[] = [
  {
    id: "stale-print-before-issue",
    version: 1,
    pack: "process",
    severity: "warning",
    title: "A sheet's live schedules changed since its last print, with an issue pending",
    scope: "document",
    kinds: ["sheet"],
    available: () => "Print records live in the host app, not the model; the issue tool checks this itself",
    run: () => undefined,
  },
];
