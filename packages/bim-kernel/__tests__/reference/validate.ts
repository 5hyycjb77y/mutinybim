// Frozen copy of the kernel before the network index (as of commit b91b54f24). Equivalence reference for
// __tests__/scale-equivalence.test.ts and scripts/bench-heavy.ts only; never imported by src.
import { distance, planWidth } from "../../src/geometry";
import { connectorPoint, segmentLength } from "./model";
import { findDisconnected } from "./topology";
import type { ElementId, ModelState, Profile } from "./types";
import type { KernelErrorCode } from "./model";

export interface ValidationIssue {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly elementIds: readonly ElementId[];
}

function sameProfile(a: Profile, b: Profile): boolean {
  if (a.shape === "rect" && b.shape === "rect") return a.width === b.width && a.height === b.height;
  if (a.shape === "round" && b.shape === "round") return a.diameter === b.diameter;
  return false;
}

/**
 * Deterministic network validation. Runs identically in the browser
 * (prediction), on the sequencer (commit) and in workers.
 */
export function validateModel(model: ModelState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { settings } = model;

  for (const c of model.connections) {
    const pa = connectorPoint(model, c.a);
    const pb = connectorPoint(model, c.b);
    if (distance(pa, pb) > settings.connectorToleranceMm) {
      issues.push({
        code: "disconnected",
        message: `Connection ${c.id} is open by ${distance(pa, pb).toFixed(1)} mm`,
        elementIds: [c.a.elementId, c.b.elementId],
      });
    }
    const ea = model.elements[c.a.elementId];
    const eb = model.elements[c.b.elementId];
    if (ea && eb && "profile" in ea && "profile" in eb && !sameProfile(ea.profile, eb.profile)) {
      issues.push({
        code: "profile_incompatible",
        message: `${ea.id} and ${eb.id} meet with different sizes and no transition`,
        elementIds: [ea.id, eb.id],
      });
    }
  }

  const tapsByHost = new Map<ElementId, { id: ElementId; s: number }[]>();
  for (const el of Object.values(model.elements)) {
    if (el.kind === "duct_segment") {
      const len = segmentLength(el);
      if (len < settings.minStraightMm) {
        issues.push({
          code: "min_straight_length",
          message: `${el.id} would be ${len.toFixed(1)} mm, shorter than the ${settings.minStraightMm} mm minimum straight length`,
          elementIds: [el.id],
        });
      }
      const tol = settings.connectorToleranceMm / 10;
      const orthogonal = Math.abs(el.start.x - el.end.x) < tol || Math.abs(el.start.y - el.end.y) < tol;
      if (!orthogonal) {
        issues.push({
          code: "unsupported_geometry",
          message: `${el.id} is not orthogonal; v1 supports orthogonal routing only`,
          elementIds: [el.id],
        });
      }
    }
    if (el.kind === "tap") {
      const host = model.elements[el.hostId];
      if (!host || host.kind !== "duct_segment") {
        issues.push({ code: "disconnected", message: `${el.id} has no host`, elementIds: [el.id] });
        continue;
      }
      const len = segmentLength(host);
      if (el.s < settings.tapEndClearanceMm || el.s > len - settings.tapEndClearanceMm) {
        issues.push({
          code: "outside_host",
          message: `${el.id} is within ${settings.tapEndClearanceMm} mm of the end of ${host.id}`,
          elementIds: [el.id, host.id],
        });
      }
      if (planWidth(el.profile) >= planWidth(host.profile)) {
        issues.push({
          code: "profile_incompatible",
          message: `${el.id} branch is as wide as its host ${host.id}`,
          elementIds: [el.id, host.id],
        });
      }
      const list = tapsByHost.get(host.id) ?? [];
      list.push({ id: el.id, s: el.s });
      tapsByHost.set(host.id, list);
    }
  }

  for (const [hostId, taps] of tapsByHost) {
    const sorted = [...taps].sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev && cur && cur.s - prev.s < settings.minTapSpacingMm) {
        issues.push({
          code: "tap_spacing",
          message: `${prev.id} and ${cur.id} are closer than ${settings.minTapSpacingMm} mm on ${hostId}`,
          elementIds: [prev.id, cur.id],
        });
      }
    }
  }

  const disconnected = findDisconnected(model);
  if (disconnected.length > 0) {
    issues.push({
      code: "disconnected",
      message: `${disconnected.length} element(s) are not connected to any equipment`,
      elementIds: disconnected,
    });
  }

  return issues;
}
