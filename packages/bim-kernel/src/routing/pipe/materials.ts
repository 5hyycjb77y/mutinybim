import { refuse, registerEditHook } from "../../command-core";
import { decidingUndo, elementCoreWritable } from "../../elements/feature";
import { rawRegistryWords } from "../../ids";
import type { BimElement, ElementId } from "../../types";
import type { RunSize } from "../types";
import { pipeMaterialRow } from "./material-rows";
import { PIPE_JOINT_END_TYPE_PARAM, pipeJointWriteRefusal, pipeSpecWriteRefusal } from "./specs";

export * from "./material-rows";

function pipeSizes(el: BimElement | undefined): Extract<RunSize, { shape: "pipe" }>[] {
  if (!el) return [];
  if (el.kind === "run_segment") return el.size.shape === "pipe" ? [el.size] : [];
  if (el.kind === "run_fitting") return el.ports.flatMap((p) => (p.size.shape === "pipe" ? [p.size] : []));
  return [];
}

/**
 * Writers: a `materialId` a record didn't carry before must be a row of the
 * pack set in force, the peers must read it, and `material` is set to the
 * row's fallback so the kernel's tables and older readers agree with it.
 */
function checkMaterials(base: Readonly<Record<string, BimElement>>, working: Record<string, BimElement>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    const sizes = pipeSizes(next);
    if (!next || !sizes.some((s) => s.materialId !== undefined)) continue;
    const before = new Set(pipeSizes(base[id]).flatMap((s) => (s.materialId !== undefined ? [s.materialId] : [])));
    let rewrite = false;
    for (const size of sizes) {
      if (size.materialId === undefined || before.has(size.materialId)) continue;
      const row = pipeMaterialRow(size.materialId);
      if (!row) refuse("invalid_value", `${rawRegistryWords(size.materialId)} (${size.materialId}) isn't a pipe material this model knows. Add the pack that defines it to the model, or choose one of the built-in materials`, [next.id]);
      if (!elementCoreWritable()) refuse("invalid_value", `${row.label} pipe can't be saved yet: the model server this model is open on is an older version that doesn't store pack pipe materials. Try again once the server is updated`, [next.id]);
      if (size.material !== row.fallback) rewrite = true;
    }
    if (!rewrite) continue;
    const fix = (s: RunSize): RunSize => (s.shape === "pipe" && s.materialId !== undefined && !before.has(s.materialId) ? { ...s, material: pipeMaterialRow(s.materialId)?.fallback ?? s.material } : s);
    if (next.kind === "run_segment") working[id] = { ...next, size: fix(next.size) };
    else if (next.kind === "run_fitting") working[id] = { ...next, ports: next.ports.map((p) => ({ ...p, size: fix(p.size) })) };
  }
}

/** Writers: a pipe fitting newly keeping its joint by end type id needs every peer to read that form (`PIPES_ADDON_PRODUCTS_FEATURE`). */
function checkJoints(base: Readonly<Record<string, BimElement>>, working: Record<string, BimElement>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "run_fitting" || next.domain !== "pipe") continue;
    const endType = next.params?.[PIPE_JOINT_END_TYPE_PARAM];
    if (typeof endType !== "string") continue;
    const prior = base[id];
    const was = prior?.kind === "run_fitting" ? prior.params?.[PIPE_JOINT_END_TYPE_PARAM] : undefined;
    const why = pipeJointWriteRefusal(next.label, endType, typeof was === "string" ? was : undefined);
    if (why) refuse("invalid_value", why, [next.id]);
  }
}

/** Writers: a pipe size newly naming an add-on's spec needs every peer to read it (`PIPES_OPEN_SPECS_FEATURE`). A spec the record already carried round-trips. */
function checkSpecs(base: Readonly<Record<string, BimElement>>, working: Record<string, BimElement>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const sizes = pipeSizes(working[id]);
    if (!sizes.some((s) => s.spec !== undefined)) continue;
    const before = new Set(pipeSizes(base[id]).flatMap((s) => (s.spec !== undefined ? [s.spec] : [])));
    for (const size of sizes) {
      if (size.spec === undefined || before.has(size.spec)) continue;
      const why = pipeSpecWriteRefusal(size.spec, undefined);
      if (why) refuse("invalid_value", why, [id]);
    }
  }
}

registerEditHook("pipe-materials", (base, working, touchedIds) => {
  checkMaterials(base.elements, working, touchedIds);
  checkJoints(base.elements, working, touchedIds);
  checkSpecs(base.elements, working, touchedIds);
});
