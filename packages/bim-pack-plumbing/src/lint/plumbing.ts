import {
  type BimElement,
  type LoadPointElement,
} from "@permitzip/bim-kernel";
import { greaseClassWords, greaseFixtureClassOf, greaseRouteOf, isGreaseFixtureOnItsFace, requirementRequires, sewerAuthorityOf } from "../plumbing/grease";
import { stackBendClearanceOf } from "../plumbing/stack-base";
import { stackAt, stackBaseClearanceDiameters } from "../plumbing/stacks";
import { clip, feet, feetInches, type RuleContext, type RuleDef } from "@permitzip/bim-lint";

/**
 * Plumbing checks (ROADMAP P5). The building sewer checks (manholes, pumps,
 * backwater valves) are in drainage.ts; these are the fixture and stack rules
 * engineers carry in their heads.
 *
 *   grease-fixture-bypasses-interceptor  a fixture the sewer authority sends to a grease interceptor drains to the sewer without one
 *   grease-fixture-not-routed            the same fixture, with nothing drawn or named yet
 *   grease-authority-unknown             a grease-laden fixture and no sewer authority to say where it must go
 *   stack-base-branch-too-close          a branch within N pipe diameters of a stack's base or offset bend (off unless turned on)
 *
 * The sewer authority is what the project's code study names, typed on the
 * sewer connection (plumbing/grease.ts); nothing here guesses one.
 */

type Elements = Readonly<Record<string, BimElement>>;

function loadName(lp: LoadPointElement): string {
  return lp.mark?.trim() || lp.id;
}

function partName(els: Elements, id: string | null): string {
  if (!id) return "the sewer";
  const el = els[id];
  return el?.kind === "part" ? el.mark.trim() || el.id : id;
}

function atLoad(ctx: RuleContext, lp: LoadPointElement) {
  const body = ctx.body(lp.id);
  const c = body ? { x: (body.box.min.x + body.box.max.x) / 2, y: (body.box.min.y + body.box.max.y) / 2, z: body.box.min.z } : { x: 0, y: 0, z: 0 };
  return { level: ctx.levelNameOf(lp), x_ft: feet(c.x), y_ft: feet(c.y), z_ft: feet(c.z) };
}

/** The fixture class a known authority sends to the interceptor, or null when this load isn't one. */
function requiredClass(els: Elements, lp: LoadPointElement): { cls: ReturnType<typeof greaseFixtureClassOf>; authority: string; cite: string; connectionId: string } | null {
  const a = sewerAuthorityOf(els);
  if (a.kind !== "known") return null;
  const cls = greaseFixtureClassOf(els, lp);
  if (!cls) return null;
  if (lp.service !== "grease_waste" && !requirementRequires(a.requires, cls)) return null;
  return { cls, authority: a.authority, cite: a.cite, connectionId: a.connectionId };
}

const asLoad = (el: BimElement): LoadPointElement | null => (el.kind === "load_point" ? el : null);

export const plumbingRules: readonly RuleDef[] = [
  {
    id: "grease-fixture-bypasses-interceptor",
    version: 1,
    pack: "systems",
    severity: "error",
    title: "A fixture the sewer authority sends to a grease interceptor drains to the sewer without one",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      const lp = asLoad(el);
      if (!lp) return;
      const els = ctx.model.elements;
      const need = requiredClass(els, lp);
      if (!need?.cls) return;
      const route = greaseRouteOf(els, lp);
      if (route.kind !== "bypasses") return;
      const where = route.belowInterceptor ? `joins below ${partName(els, route.belowInterceptor)}` : `drains to ${partName(els, route.toId)}`;
      const how = route.how === "named" ? " (its named source)" : "";
      ctx.emit({
        rule: "grease-fixture-bypasses-interceptor",
        severity: "error",
        elementIds: [lp.id, ...(route.toId ? [route.toId] : []), ...(route.belowInterceptor ? [route.belowInterceptor] : [])],
        at: atLoad(ctx, lp),
        message: clip(`${loadName(lp)} (${greaseClassWords(need.cls)}) ${where}${how} without a grease interceptor; ${need.authority} sends it through one (${need.cite})`),
        fix: { tool: "bim_edit_load_point", hint: "pipe it to the grease interceptor's inlet, or name the interceptor as its source (served_by)" },
      });
    },
  },
  {
    id: "grease-fixture-not-routed",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "A fixture the sewer authority sends to a grease interceptor, not routed to one yet",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      const lp = asLoad(el);
      if (!lp) return;
      const els = ctx.model.elements;
      const need = requiredClass(els, lp);
      if (!need?.cls) return;
      if (greaseRouteOf(els, lp).kind !== "not_routed") return;
      ctx.emit({
        rule: "grease-fixture-not-routed",
        severity: "info",
        elementIds: [lp.id],
        at: atLoad(ctx, lp),
        message: clip(`${loadName(lp)} (${greaseClassWords(need.cls)}) must drain through a grease interceptor under ${need.authority} (${need.cite}); none is piped or named yet`),
        fix: { tool: "bim_edit_load_point", hint: "name the grease interceptor as its source (served_by), or pipe it to the interceptor's inlet" },
      });
    },
  },
  {
    id: "grease-authority-unknown",
    version: 1,
    pack: "systems",
    severity: "info",
    title: "A grease-laden fixture, and no sewer authority to say whether it goes through a grease interceptor",
    scope: "element",
    kinds: ["load_point"],
    run: (ctx, el) => {
      const lp = asLoad(el);
      if (!lp) return;
      const els = ctx.model.elements;
      const a = sewerAuthorityOf(els);
      if (a.kind === "known" || !isGreaseFixtureOnItsFace(els, lp)) return;
      // A fixture already drawn or named through an interceptor needs no answer yet.
      if (greaseRouteOf(els, lp).kind === "through_interceptor") return;
      const conn = a.connectionId ? partName(els, a.connectionId) : null;
      const why =
        a.kind === "no_rule"
          ? `no grease rule is on file for ${a.authority}; type which fixtures go to the interceptor on ${conn}`
          : a.reason === "no_connection"
            ? "sewer authority unknown: place the sewer connection and set its authority from the code study"
            : a.reason === "disagree"
              ? "the sewer connections name different sewer authorities; set one from the code study"
              : `sewer authority unknown: set it on ${conn} from the code study`;
      ctx.emit({
        rule: "grease-authority-unknown",
        severity: "info",
        elementIds: [lp.id, ...(a.connectionId ? [a.connectionId] : [])],
        at: atLoad(ctx, lp),
        message: clip(`${loadName(lp)} carries grease (IPC 1003.3.1); ${why}`),
        fix: { tool: "bim_set_parameters", hint: "set sewer_authority (as the code study names the sewer owner) on the sewer connection" },
      });
    },
  },
  {
    id: "stack-base-branch-too-close",
    version: 1,
    pack: "systems",
    severity: "warning",
    title: "A branch joins too close to a stack's base or offset bend (firm rule, off unless turned on)",
    scope: "element",
    kinds: ["run_fitting"],
    available: (ctx) => (stackBaseClearanceDiameters(ctx.model.elements) === null ? "Off by default (a firm rule, not code): turn it on in Plumbing › Stacks" : null),
    run: (ctx, el) => {
      if (el.kind !== "run_fitting" || !el.host) return;
      const els = ctx.model.elements;
      const n = stackBaseClearanceDiameters(els);
      if (n === null) return;
      const c = stackBendClearanceOf(els, el, n);
      if (!c) return;
      const stack = stackAt(els, c.stackKey);
      const name = stack?.number ? `stack ${stack.number}` : "the stack";
      const on = c.onStack ? `on ${name}` : `on the pipe leaving ${name}'s ${c.bend} bend`;
      const p = el.position;
      ctx.emit({
        rule: "stack-base-branch-too-close",
        severity: "warning",
        elementIds: [el.id, c.hostId, ...(c.bendId ? [c.bendId] : [])],
        at: { level: ctx.levelNameOf(el), x_ft: feet(p.x), y_ft: feet(p.y), z_ft: feet(p.z) },
        message: clip(`A branch joins ${on} ${feetInches(c.distanceMm)} from the ${c.bend} bend; keep it ${n} pipe diameters (${feetInches(c.requiredMm)}) away (firm rule)`),
        fix: { tool: "bim_slide_branch", hint: `slide the branch at least ${feetInches(c.requiredMm)} from the bend` },
      });
    },
  },
];
