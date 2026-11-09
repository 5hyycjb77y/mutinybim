import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { schemaOnce, schemaOnce2, schemaOnce3 } from "../support/edit-schemas";
import { resolveNecEdition, type NecEditionYear } from "@permitzip/bim-calc";
import { readEquipmentList, serviceSize, type LoadClass, acceptProposalCommand, buildProposal, type ProposeArgs, type ReceptacleProposal, ELECTRICAL_TOOL_ARGS, ELECTRICAL_TOOL_GROUPS, EQUIPMENT_LIST_ARGS, PROPOSE_ARGS } from "@permitzip/bim-pack-electrical";
import { traceRoomsCommand, type ModelState } from "@permitzip/bim-kernel";
import { tradeBaseRevision as baseRevision, explain, failure, runEdit, tradeTarget as target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import type { ProjectAdoptionLookup } from "../calc/capabilities";
import { noAdoptedElectricalCode } from "../calc/local";
import { resolveLevelRef } from "@permitzip/bim-mcp";
import { registerBimServiceLayoutTool } from "./service-layout";
import { registerPackTools, type HostedPackTool } from "../calc/pack-tools";

/**
 * Placement proposers and early service sizing for agents (WS-G). The
 * person picks the rooms and the device type; the proposal is code spacing
 * only, and accepting it places devices and nothing else: no circuit, no
 * equipment choice (a product design rule).
 * The Electrical tab's Propose receptacles panel sends the same command.
 */

const FT = 304.8;
const ft = (mm: number) => (Number.isFinite(mm) ? Math.round((mm / FT) * 100) / 100 : null);

/** The proposer's arguments (declared by the Electrical add-on). */
export { PROPOSE_ARGS };


const badArgs = (tool: string, issues: readonly z.core.$ZodIssue[]) => `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;

async function edition(extra: Extra, projectId: string, nec: NecEditionYear | undefined, projectAdoption: ProjectAdoptionLookup) {
  const adoption = nec ? null : await projectAdoption(extra, projectId);
  return resolveNecEdition({ necEdition: nec, projectAdoption: adoption });
}

/** The NEC edition when the mode is a code mode (dwelling, 210.52); density is a firm preset and needs none. */
async function editionFor(extra: Extra, projectId: string, args: Pick<ProposeArgs, "mode" | "nec_edition">, projectAdoption: ProjectAdoptionLookup) {
  return args.mode === "density" ? null : edition(extra, projectId, args.nec_edition, projectAdoption);
}

/** The proposal for these arguments (the add-on's). */
export { buildProposal };

function proposalOut(p: ReceptacleProposal) {
  return {
    code: p.code,
    summary: p.summary,
    passes: p.passes,
    rooms: p.rooms.map((r) => ({
      room: r.label,
      room_id: r.roomId,
      treated_as: r.rule,
      because: r.ruleBasis,
      devices: r.devices.map((d) => ({ key: d.key, kind: d.kind, type: d.typeId, at_ft: { x: ft(d.position.x), y: ft(d.position.y) }, height_in: Math.round(d.heightMm / 25.4), why: d.reason, cite: d.cite })),
      coverage: r.runs.map((c) => ({ kind: c.kind, length_ft: ft(c.lengthMm), worst_ft: ft(c.worstMm), limit_ft: ft(c.limitMm), passes: c.passes })),
      ...(r.notes.length > 0 ? { notes: r.notes } : {}),
    })),
  };
}

/** "line 2", "lines 2–41", "lines 2–5, 8". */
function lineRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return `${sorted.length === 1 ? "line" : "lines"} ${parts.join(", ")}`;
}

const ptFt = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const mm = (p: { x: number; y: number }) => ({ x: Math.round(p.x * FT), y: Math.round(p.y * FT) });

export const TRACE_ARGS = {
  level: z.string().trim().min(1).max(200).describe("Level id or name."),
  rooms: z.array(z.object({ number: z.string().trim().max(40), name: z.string().trim().min(1).max(120), outline_ft: z.array(ptFt).min(3).max(200) }).strict()).min(1).max(200),
  openings: z.array(z.object({ kind: z.enum(["door", "window"]), at_ft: ptFt.describe("Centre, on a room edge."), width_ft: z.number().positive().max(60), mark: z.string().max(40).optional() }).strict()).max(500).optional(),
  casework: z.array(z.object({ type_name: z.string().trim().min(1).max(120).describe('"Base cabinet with countertop", "Kitchen island countertop", "Kitchen sink", "Range", "Lavatory", "Washer".'), at_ft: ptFt, size_ft: ptFt, rotation_deg: z.number().finite().min(-360).max(360).optional() }).strict()).max(500).optional(),
  wall_thickness_in: z.number().positive().max(48).default(5),
};

/** A stable id prefix from what is traced, so a retried trace is the same edit. */
function tracePrefix(value: unknown): string {
  let h = 5381;
  for (const ch of JSON.stringify(value)) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  return `tr-${h.toString(36)}`;
}

export function registerBimElectricalProposeTools(server: McpServer, caller: ResolveBimCaller, options: { projectAdoption?: ProjectAdoptionLookup } = {}) {
  const projectAdoption = options.projectAdoption ?? noAdoptedElectricalCode;
  registerBimServiceLayoutTool(server, caller);

  const propose: HostedPackTool = (copy) =>
    server.registerTool("bim_propose_receptacles", { ...copy, inputSchema: { ...target, ...PROPOSE_ARGS } }, async (raw, extra) => {
      const parsed = schemaOnce2(target, PROPOSE_ARGS).safeParse(raw);
      if (!parsed.success) return failure(badArgs("bim_propose_receptacles", parsed.error.issues));
      const args = parsed.data;
      try {
        const who = await caller(extra, args.project_id, false);
        const nec = await editionFor(extra, args.project_id, args, projectAdoption);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const built = buildProposal(model, args, nec);
          if (typeof built === "string") return failure(built);
          return text({ revision: model.revision, ...proposalOut(built.proposal) });
        });
      } catch (err) {
        return explain(err, "bim_propose_receptacles");
      }
    });

  const acceptArgs = ELECTRICAL_TOOL_ARGS.bim_accept_receptacles;
  const accept: HostedPackTool = (copy) =>
    server.registerTool("bim_accept_receptacles", { ...copy, inputSchema: { ...target, ...baseRevision, ...acceptArgs } }, async (raw, extra: Extra) => {
      const parsed = schemaOnce3(target, baseRevision, acceptArgs).safeParse(raw);
      if (!parsed.success) return failure(badArgs("bim_accept_receptacles", parsed.error.issues));
      const args = parsed.data;
      let model: ModelState;
      let nec: ReturnType<typeof resolveNecEdition> | null;
      try {
        const who = await caller(extra, args.project_id, false);
        nec = await editionFor(extra, args.project_id, args, projectAdoption);
        model = await withSession(who, args.model_id, undefined, async (s) => s.model());
      } catch (err) {
        return explain(err, "bim_accept_receptacles");
      }
      const built = buildProposal(model, args, nec);
      if (typeof built === "string") return failure(built);
      const command = acceptProposalCommand(model, built.proposal, args.keep ?? null);
      if (typeof command === "string") return failure(command);
      return runEdit(caller, "bim_accept_receptacles", extra, { project_id: args.project_id, model_id: args.model_id, base_revision: args.base_revision ?? model.revision }, command);
    });

  server.registerTool(
    "bim_trace_rooms",
    {
      title: "Trace rooms from the architect's plan",
      description: "Adds rooms (outline in feet) with a wall on each edge, doors, windows and counters or fixtures, as one edit, so proposers can measure them. Trace only what the plan shows. Pauses for approval.",
      inputSchema: { ...target, ...baseRevision, ...TRACE_ARGS },
    },
    async (raw, extra: Extra) => {
      const parsed = schemaOnce3(target, baseRevision, TRACE_ARGS).safeParse(raw);
      if (!parsed.success) return failure(badArgs("bim_trace_rooms", parsed.error.issues));
      const args = parsed.data;
      let model: ModelState;
      try {
        const who = await caller(extra, args.project_id, false);
        model = await withSession(who, args.model_id, undefined, async (s) => s.model());
      } catch (err) {
        return explain(err, "bim_trace_rooms");
      }
      const level = resolveLevelRef(model, args.level);
      if (!level.ok) return failure(level.message);
      const command = traceRoomsCommand(
        level.id,
        tracePrefix({ rooms: args.rooms, openings: args.openings ?? [], casework: args.casework ?? [] }),
        args.rooms.map((r) => ({ number: r.number, name: r.name, outline: r.outline_ft.map(mm) })),
        (args.openings ?? []).map((o) => ({ kind: o.kind, at: mm(o.at_ft), widthMm: Math.round(o.width_ft * FT), ...(o.mark ? { mark: o.mark } : {}) })),
        (args.casework ?? []).map((c) => ({ typeName: c.type_name, at: mm(c.at_ft), size: mm(c.size_ft), ...(c.rotation_deg !== undefined ? { rotationDeg: c.rotation_deg } : {}) })),
        Math.round(args.wall_thickness_in * 25.4),
      );
      if (typeof command === "string") return failure(command);
      return runEdit(caller, "bim_trace_rooms", extra, { project_id: args.project_id, model_id: args.model_id, base_revision: args.base_revision ?? model.revision }, command);
    },
  );

  const equipmentList: HostedPackTool = (copy) =>
    server.registerTool("bim_service_from_equipment_list", { ...copy, inputSchema: EQUIPMENT_LIST_ARGS }, async (raw, extra) => {
      const parsed = schemaOnce(EQUIPMENT_LIST_ARGS).safeParse(raw);
      if (!parsed.success) return failure(badArgs("bim_service_from_equipment_list", parsed.error.issues));
      const args = parsed.data;
      try {
        await caller(extra, args.project_id, false);
        const nec = await edition(extra, args.project_id, args.nec_edition, projectAdoption);
        if (!nec.ok) return failure(`${nec.reason} Give nec_edition.`);
        const { rows, headerLine } = readEquipmentList(nec.edition, args.text, { voltageV: args.voltage_v, phases: args.phases });
        if (rows.length === 0) return failure("No equipment rows found in that text.");
        const dataLines = rows.map((r) => r.line);
        const stray = (args.classes ?? []).filter((c) => !dataLines.includes(c.line));
        if (stray.length > 0) {
          const named = stray.map((c) => (c.line === headerLine ? `line ${c.line} (the header row)` : `line ${c.line}`)).join(", ");
          return failure(`classes names ${named}, which has no equipment row. Lines count the pasted text's non-blank lines from 1, header included${headerLine ? ` (the header is line ${headerLine})` : ""}; equipment rows are on ${lineRanges(dataLines)}. Send classes by those line numbers.`);
        }
        const confirmed = new Map<number, LoadClass>((args.classes ?? []).map((c) => [c.line, c.class]));
        const usable = rows.filter((r) => r.va !== null && r.va > 0);
        const out = usable.length > 0 ? serviceSize(nec.edition, { voltage_v: args.voltage_v, phases: args.phases, occupancy: args.occupancy, spare_pct: args.spare_pct, items: usable.map((r) => ({ label: [r.tag, r.description].filter(Boolean).join(" "), class: confirmed.get(r.line) ?? r.suggestedClass, va: r.va ?? 0, quantity: r.quantity })) }) : null;
        return text({
          header_line: headerLine,
          lines_note: `line is the row's line in the pasted text (non-blank lines from 1, header included); equipment rows are on ${lineRanges(dataLines)}.`,
          rows: rows.map((r) => {
            const set = confirmed.get(r.line);
            return { line: r.line, tag: r.tag, description: r.description, qty: r.quantity, va: r.va, va_from: r.vaBasis, class: set ?? r.suggestedClass, class_confirmed: set !== undefined, class_why: set !== undefined ? "set by you" : r.classBasis, ...(set !== undefined && set !== r.suggestedClass ? { suggested_class: r.suggestedClass } : {}), ...(r.problem ? { problem: r.problem } : {}) };
          }),
          ...(out
            ? {
                service: out.detail.label,
                service_a: out.detail.serviceA,
                required_a: Math.round(out.detail.requiredA * 10) / 10,
                trail: out.steps.map((st) => ({ step: st.label, detail: st.detail, cite: st.cite.map((c) => c.text) })),
                issues: out.issues.map((i) => i.message),
              }
            : {}),
        });
      } catch (err) {
        return explain(err, "bim_service_from_equipment_list");
      }
    });

  // Each needs the project's adopted NEC edition; accepting builds its command from the open model: hosted here.
  // bim_trace_rooms stays a host tool: rooms, walls and openings are architecture the kernel owns, not electrical.
  registerPackTools(server, caller, "electrical", {
    only: ELECTRICAL_TOOL_GROUPS.propose,
    hosted: { bim_propose_receptacles: propose, bim_accept_receptacles: accept, bim_service_from_equipment_list: equipmentList },
  });
}
