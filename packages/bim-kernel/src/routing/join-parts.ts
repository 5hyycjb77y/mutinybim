import { z } from "zod";
import { finish, refuse, type ExecuteResult, type IntentPredicate } from "../command-core";
import { jointIntegrityIssues, integrityPortsOf } from "../connections/integrity";
import { peerReads } from "../elements/feature";
import { loadPointLabel } from "../load-points/model";
import type { LoadPointElement } from "../load-points/types";
import { TrackedReader } from "../model";
import { runEndOf } from "../requirements/anchor";
import { draftElements } from "../store";
import { asElementId, type BimElement, type ModelState, type PartInstance } from "../types";
import { dot3, len3, sub3, withLink } from "./geometry";
import { heightFrameOf, portInfoIn } from "./levels-across";
import type { PortRef } from "./types";
import { partLabelOf } from "./validate";

/**
 * Joining parts end to end, with no run between them (round 9 J9): two part
 * connectors (fabrication fittings joined fitting to fitting, a coil onto a
 * unit), or a part connector and a load point (the load point's requirement is
 * then served at that connector, as it is when a run reaches it).
 *
 * Refused only when the join can't exist: one side isn't there or isn't
 * placed, an end is already joined, the two ends don't meet or don't face each
 * other. A size, shape, end-type or system mismatch is joined and reported as
 * advice (connections/integrity.ts), never refused. Undone like any edit.
 * Written only when every peer reads `JOIN_PARTS_FEATURE`.
 */

/** Peers that store part-to-part joins and load points served by a part directly. */
export const JOIN_PARTS_FEATURE = "parts:direct_joins";

/** The port a load point is joined on (it has one). */
export const LOAD_POINT_PORT = "load";

const end = z.object({ elementId: z.string().min(1).max(200), port: z.string().min(1).max(40) });
export const joinPartsCommandSchema = z.object({ type: z.literal("join_parts"), a: end, b: end });
export type JoinPartsCommand = z.infer<typeof joinPartsCommandSchema>;

const NO_INTENTS = (): IntentPredicate[] => [];

function nameOf(elements: Readonly<Record<string, BimElement>>, el: PartInstance | LoadPointElement): string {
  return el.kind === "part" ? partLabelOf(elements, el) : loadPointLabel(elements, el);
}

/** The connector as a person names it ("A's out"); refuses when the part can't take a join there. */
function requirePart(el: PartInstance, port: string, elements: Readonly<Record<string, BimElement>>): string {
  const name = partLabelOf(elements, el);
  if (el.planned !== undefined) refuse("unsupported_geometry", `${name} isn't placed yet, so nothing can be joined to it; place it first (Not placed yet › Place)`, [el.id]);
  const end = integrityPortsOf(elements, el).find((p) => p.ref.port === port);
  if (!end) refuse("element_not_found", `${name} has no connector ${port}`, [el.id]);
  if (el.links?.[port]) refuse("already_exists", `${end.words} is already joined; disconnect it first`, [el.id]);
  return end.words;
}

function requireLoadPoint(lp: LoadPointElement, elements: Readonly<Record<string, BimElement>>): void {
  const name = loadPointLabel(elements, lp);
  if (runEndOf(lp)) refuse("already_exists", `${name} is already on a run end, which serves it; disconnect it from the run first`, [lp.id]);
  if (lp.joinedTo) refuse("already_exists", `${name} is already joined to ${lp.joinedTo.elementId}; disconnect it first`, [lp.id]);
}

/** How a person names this end; refuses when it can't take a join. */
function joinableEnd(el: PartInstance | LoadPointElement, port: string, elements: Readonly<Record<string, BimElement>>): string {
  if (el.kind === "part") return requirePart(el, port, elements);
  requireLoadPoint(el, elements);
  return nameOf(elements, el);
}

export function joinParts(model: ModelState, cmd: Pick<JoinPartsCommand, "a" | "b">): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const a = reader.get(asElementId(cmd.a.elementId));
  const b = reader.get(asElementId(cmd.b.elementId));
  if (a.id === b.id) refuse("invalid_value", "Pick two different things to join");
  if ((a.kind !== "part" && a.kind !== "load_point") || (b.kind !== "part" && b.kind !== "load_point")) {
    refuse("wrong_kind", "Only parts' connectors and load points join end to end; runs connect with Connect runs", [a.id, b.id]);
  }
  if (a.kind === "load_point" && b.kind === "load_point") refuse("wrong_kind", "Two load points can't be joined: a part or a run serves a load point", [a.id, b.id]);
  if (!peerReads(JOIN_PARTS_FEATURE)) {
    refuse("invalid_value", "Parts can't be joined end to end yet: the model server this model is open on is an older version that doesn't store direct joins. Route a run between them, or try again once the server is updated. Nothing changed", [a.id, b.id]);
  }
  const ra: PortRef = { elementId: a.id, port: a.kind === "load_point" ? LOAD_POINT_PORT : cmd.a.port };
  const rb: PortRef = { elementId: b.id, port: b.kind === "load_point" ? LOAD_POINT_PORT : cmd.b.port };
  const wa = joinableEnd(a, ra.port, working);
  const wb = joinableEnd(b, rb.port, working);

  if (a.kind === "part" && b.kind === "part") {
    const ia = portInfoIn(working, ra, heightFrameOf(a));
    const ib = portInfoIn(working, rb, heightFrameOf(a));
    if (!ia || !ib) refuse("element_not_found", "One of those connectors doesn't exist", [a.id, b.id]);
    const gap = len3(sub3(ia.position, ib.position));
    if (gap > model.settings.connectorToleranceMm) refuse("disconnected", `${wa} and ${wb} are ${Math.round(gap)} mm apart; move one onto the other, or route a run between them`, [a.id, b.id]);
    if (dot3(ia.direction, ib.direction) > -0.999) refuse("unsupported_geometry", `${wa} and ${wb} don't face each other; turn one, or route between them with an elbow`, [a.id, b.id]);
  }

  const na = withLink(a, ra.port, rb);
  const nb = withLink(b, rb.port, ra);
  if (!na || !nb) refuse("wrong_kind", "Only parts' connectors and load points join end to end", [a.id, b.id]);
  working[na.id] = na;
  working[nb.id] = nb;

  const summary = [`Joined ${nameOf(working, a)} and ${nameOf(working, b)} end to end`];
  if (a.kind === "part" && b.kind === "part") {
    const pa = integrityPortsOf(working, na).find((p) => p.ref.port === ra.port);
    const pb = integrityPortsOf(working, nb).find((p) => p.ref.port === rb.port);
    if (pa && pb) for (const found of jointIntegrityIssues(pa, pb)) summary.push(`Check: ${found.message}. ${found.nextStep}`);
  }
  return finish(reader, working, [na.id, nb.id], [], NO_INTENTS, { summary });
}
