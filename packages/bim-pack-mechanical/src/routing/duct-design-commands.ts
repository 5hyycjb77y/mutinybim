import {
  asElementId,
  draftElements,
  finish,
  insulationIssue,
  insulationLabel,
  refuse,
  runLabel,
  sameInsulation,
  sameSize,
  TrackedReader,
  type AuthoredWrite,
  type BimElement,
  type DuctDesignCommand,
  type DuctInsulation,
  type ElementId,
  type ExecuteResult,
  type ModelState,
  type RunFitting,
  type RunSegment,
} from "@permitzip/bim-kernel";

/**
 * Insulation edits on routed duct and pipe.
 *
 * `set_run_insulation` puts a wrap or liner on (or takes it off) one piece,
 * a run (the piece and every segment and elbow joined to it at the same size,
 * stopping at transitions, branches and parts, as resize does), or every duct
 * or pipe of the system. Pipe takes a wrap only. Fittings take the insulation
 * of the segments they join.
 *
 * `set_pipe_insulation` gives each listed pipe its own insulation in one edit
 * (one undo): what a pipe insulation schedule by size calls for, where one
 * thickness for the whole system would be wrong.
 *
 * The two commands' shapes are the kernel's (routing/duct-insulation.ts: a
 * stored command parses in every host); running them is this add-on's.
 */

/** How an insulation choice is recorded as an authored value (conflicts compare it). */
export function insulationValue(insulation: DuctInsulation | null | undefined): string {
  return insulation ? `${insulation.kind}:${Math.round(insulation.thicknessMm * 1000) / 1000}${insulation.material ? `:${insulation.material}` : ""}${insulation.rValue !== undefined ? `:R${insulation.rValue}` : ""}${insulation.surface === "spray_coated" ? ":spray_coated" : ""}` : "none";
}

type RunPiece = RunSegment | RunFitting;

function isRunPiece(el: BimElement | undefined): el is RunPiece {
  return el?.kind === "run_segment" || el?.kind === "run_fitting";
}

/** The pieces a scope covers, starting from `start`. */
function piecesFor(model: ModelState, reader: TrackedReader, start: RunPiece, scope: Extract<DuctDesignCommand, { type: "set_run_insulation" }>["scope"]): RunPiece[] {
  const elements = model.elements;
  if (scope === "system") {
    const out: RunPiece[] = [];
    for (const id in elements) {
      const el = elements[id];
      if (isRunPiece(el) && el.systemId === start.systemId && el.domain === start.domain) out.push(reader.get(el.id) as RunPiece);
    }
    return out;
  }
  const linkedFittings = (seg: RunSegment): RunPiece[] => {
    const out: RunPiece[] = [];
    for (const link of [seg.links.start, seg.links.end]) {
      const other = link ? reader.find(link.elementId) : undefined;
      if (other?.kind === "run_fitting") out.push(other);
    }
    return out;
  };
  if (scope === "piece") return start.kind === "run_segment" ? [start, ...linkedFittings(start)] : [start];
  // A run: same-size segments joined through elbows, caps and offsets; the fittings on its edges come along.
  const seed = start.kind === "run_segment" ? start : start.ports.map((p) => (p.link ? reader.find(p.link.elementId) : undefined)).find((el): el is RunSegment => el?.kind === "run_segment");
  if (!seed) return [start];
  const out = new Map<ElementId, RunPiece>();
  const stack: ElementId[] = [seed.id];
  const passes = (f: RunFitting) => f.fittingType === "elbow" || f.fittingType === "cap" || f.fittingType === "offset";
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || out.has(id)) continue;
    const el = reader.find(id);
    if (el?.kind === "run_segment") {
      if (!sameSize(el.size, seed.size)) continue;
      out.set(el.id, el);
      for (const link of [el.links.start, el.links.end]) {
        const other = link ? reader.find(link.elementId) : undefined;
        if (other?.kind === "run_segment") stack.push(other.id);
        else if (other?.kind === "run_fitting") {
          out.set(other.id, other);
          if (passes(other)) for (const p of other.ports) if (p.link) stack.push(p.link.elementId);
        }
      }
    }
  }
  if (start.kind === "run_fitting") out.set(start.id, start);
  return [...out.values()];
}

function setRunInsulation(model: ModelState, cmd: Extract<DuctDesignCommand, { type: "set_run_insulation" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const start = reader.get(asElementId(cmd.elementId));
  if (!isRunPiece(start)) refuse("wrong_kind", `${cmd.elementId} isn't a duct or pipe run`, [start.id]);
  const name = runLabel(model.elements, start);
  if (start.domain !== "duct" && start.domain !== "pipe") refuse("invalid_value", `The ${name} is ${start.domain}; insulation goes on duct and pipe`, [start.id]);
  const insulation = cmd.insulation ?? undefined;
  const pieces = piecesFor(model, reader, start, cmd.scope);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  const authored: AuthoredWrite[] = [];
  for (const el of pieces) {
    if (insulation && el.kind === "run_segment") {
      const why = insulationIssue(el.size, insulation);
      if (why) refuse("invalid_value", `${runLabel(model.elements, el).replace(/^./, (c) => c.toUpperCase())}: ${why}`, [el.id]);
    }
    if (sameInsulation(el.insulation, insulation)) continue;
    const { insulation: _old, ...rest } = el;
    const next: RunPiece = insulation ? { ...rest, insulation } : rest;
    working[el.id] = next;
    touched.push(el.id);
    if (el.kind === "run_segment") authored.push({ elementId: el.id, field: "insulation", value: insulationValue(insulation) });
  }
  if (touched.length === 0) refuse("invalid_value", `The ${name} already has ${insulationLabel(insulation).toLowerCase()}`, [start.id]);
  const where = cmd.scope === "system" ? systemName(model, start.systemId, start.domain) : cmd.scope === "run" ? `the run through the ${name}` : `the ${name}`;
  const what = insulation ? insulationLabel(insulation) : "no insulation";
  return finish(reader, working, touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })), {
    summary: [`${where.replace(/^./, (c) => c.toUpperCase())} now has ${what} (${touched.length} piece${touched.length === 1 ? "" : "s"})`],
  });
}

function systemName(model: ModelState, systemId: string, domain: RunPiece["domain"]): string {
  const s = model.elements[systemId];
  const what = domain === "pipe" ? "pipe" : "duct";
  return s?.kind === "mep_system" ? `every ${what} of ${s.name}` : `every ${what} of the system`;
}

/** Each listed pipe its own insulation; the fittings at its ends take the thicker of the pipes they join. */
function setPipeInsulation(model: ModelState, cmd: Extract<DuctDesignCommand, { type: "set_pipe_insulation" }>): ExecuteResult {
  const reader = new TrackedReader(model);
  const system = reader.get(asElementId(cmd.systemId));
  if (system.kind !== "mep_system" || system.domain !== "pipe") refuse("element_not_found", `There is no pipe system ${cmd.systemId}`, [system.id]);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  const authored: AuthoredWrite[] = [];
  const seen = new Set<string>();
  const forFitting = new Map<ElementId, DuctInsulation | null>();
  const thicker = (a: DuctInsulation | null | undefined, b: DuctInsulation | null) => (!a ? b : !b ? a : b.thicknessMm > a.thicknessMm ? b : a);
  for (const p of cmd.pieces) {
    if (seen.has(p.segmentId)) refuse("invalid_value", `${p.segmentId} is listed twice`, [asElementId(p.segmentId)]);
    seen.add(p.segmentId);
    const seg = reader.get(asElementId(p.segmentId));
    if (seg.kind !== "run_segment" || seg.size.shape !== "pipe") refuse("element_not_found", `${p.segmentId} isn't a pipe`, [seg.id]);
    if (seg.systemId !== system.id) refuse("invalid_value", `${runLabel(model.elements, seg)} is on another system`, [seg.id]);
    if (p.insulation) {
      const why = insulationIssue(seg.size, p.insulation);
      if (why) refuse("invalid_value", `${runLabel(model.elements, seg).replace(/^./, (c) => c.toUpperCase())}: ${why}`, [seg.id]);
    }
    for (const link of [seg.links.start, seg.links.end]) {
      const other = link ? reader.find(link.elementId) : undefined;
      if (other?.kind === "run_fitting") forFitting.set(other.id, thicker(forFitting.get(other.id), p.insulation));
    }
    const insulation = p.insulation ?? undefined;
    if (sameInsulation(seg.insulation, insulation)) continue;
    const { insulation: _old, ...rest } = seg;
    working[seg.id] = insulation ? { ...rest, insulation } : rest;
    touched.push(seg.id);
    authored.push({ elementId: seg.id, field: "insulation", value: insulationValue(insulation) });
  }
  for (const [id, ins] of forFitting) {
    const f = reader.get(id);
    if (f.kind !== "run_fitting") continue;
    const insulation = ins ?? undefined;
    if (sameInsulation(f.insulation, insulation)) continue;
    const { insulation: _old, ...rest } = f;
    working[f.id] = insulation ? { ...rest, insulation } : rest;
    touched.push(f.id);
  }
  if (touched.length === 0) refuse("invalid_value", `Every pipe listed on ${system.name} already has that insulation`, [system.id]);
  const pipes = authored.length;
  return finish(reader, working, touched, authored, () => authored.map((a) => ({ kind: "field_equals" as const, elementId: a.elementId, field: a.field, value: a.value })), {
    summary: [cmd.label ?? `Insulation set on ${pipes} pipe${pipes === 1 ? "" : "s"} of ${system.name}`],
  });
}

export function executeDuctDesignCommand(model: ModelState, command: DuctDesignCommand): ExecuteResult {
  switch (command.type) {
    case "set_run_insulation":
      return setRunInsulation(model, command);
    case "set_pipe_insulation":
      return setPipeInsulation(model, command);
  }
}
