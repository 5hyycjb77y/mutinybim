import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NEC_EDITIONS, resolveNecEdition, type NecEditionYear } from "@permitzip/bim-calc";
import { dedicatedSpaceZone, workingSpaceZone } from "@permitzip/bim-pack-electrical";
import {
  CLEARANCE_FACES,
  CLEARANCE_PURPOSES,
  MAX_CURB_MM,
  localBounds,
  resolveGeometry,
  type ClearanceFace,
  type ClearanceOverride,
  type ClearanceZone,
  type Command,
  type ModelState,
  type PartHost,
} from "@permitzip/bim-kernel";
import type { ProjectAdoptionLookup } from "../calc/capabilities";
import { noAdoptedElectricalCode } from "../calc/local";
import { baseRevision, explain, failure, runEdit, target, withSession, type Extra, type ResolveBimCaller } from "../runtime";

/**
 * Spatial tools for agents: the clearance zones a part needs (service
 * access, combustibles, economizer access, NEC 110.26 working space) and the
 * slab or roof it stands on, with its curb. The same kernel commands the
 * part editor and the Properties panel send. Feet in, feet out.
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const mm = (ft: number) => Math.round(ft * MM_PER_FT * 10) / 10;

const zoneId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).describe("Zone id, lower case (service, combustible, economizer, working_space…).");

const zoneInput = z
  .object({
    id: zoneId,
    name: z.string().trim().min(1).max(60),
    purpose: z.enum(CLEARANCE_PURPOSES),
    face: z.enum(CLEARANCE_FACES).describe("Which side of the part: front is the side it faces."),
    depth_ft: z.number().positive().max(100),
    width_ft: z.number().positive().max(100).optional().describe("Along the face; default the part's own size."),
    height_ft: z.number().positive().max(100).optional().describe("Default the part's own height."),
    offset_ft: z.number().min(-100).max(100).optional().describe("Slide along the face from centred (+ toward the part's left)."),
    from_floor: z.boolean().optional().describe("Starts at the floor or roof under the part, not its base."),
  })
  .strict();

const overrideInput = z
  .object({
    off: z.boolean().optional().describe("Switch this zone off for this part only."),
    name: z.string().trim().min(1).max(60).optional(),
    purpose: z.enum(CLEARANCE_PURPOSES).optional(),
    face: z.enum(CLEARANCE_FACES).optional(),
    depth_ft: z.number().min(0).max(100).optional(),
    width_ft: z.number().min(0).max(100).optional(),
    height_ft: z.number().min(0).max(100).optional(),
    offset_ft: z.number().min(-100).max(100).optional(),
    from_floor: z.boolean().optional(),
  })
  .strict();

const workingSpaceInput = z
  .object({
    voltage_to_ground: z.number().positive().max(1000).describe("Nominal volts to ground (120/208 V: 120; 277/480 V: 277)."),
    condition: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("110.26(A)(1) condition you chose: 1 nothing opposite, 2 grounded parts opposite, 3 live parts opposite."),
    extra_depth_multiplier: z.number().min(1).max(3).optional().describe("Your choice to draw more than the table (2 = double clearance)."),
    face: z.enum(CLEARANCE_FACES).optional().describe("Working face, default front."),
    offset_ft: z.number().min(-100).max(100).optional().describe("Slide along the face; the space need not be centred."),
    nec_edition: z.enum(NEC_EDITIONS).optional().describe("Default: the project's adopted edition."),
  })
  .strict();

function zoneFromInput(z0: z.infer<typeof zoneInput>): ClearanceZone {
  return {
    id: z0.id,
    name: z0.name,
    purpose: z0.purpose,
    face: z0.face,
    depth: mm(z0.depth_ft),
    ...(z0.width_ft !== undefined ? { width: mm(z0.width_ft) } : {}),
    ...(z0.height_ft !== undefined ? { height: mm(z0.height_ft) } : {}),
    ...(z0.offset_ft !== undefined ? { offset: mm(z0.offset_ft) } : {}),
    ...(z0.from_floor !== undefined ? { fromFloor: z0.from_floor } : {}),
  };
}

function overrideFromInput(o: z.infer<typeof overrideInput>): ClearanceOverride {
  return {
    ...(o.off !== undefined ? { off: o.off } : {}),
    ...(o.name !== undefined ? { name: o.name } : {}),
    ...(o.purpose !== undefined ? { purpose: o.purpose } : {}),
    ...(o.face !== undefined ? { face: o.face } : {}),
    ...(o.depth_ft !== undefined ? { depth: mm(o.depth_ft) } : {}),
    ...(o.width_ft !== undefined ? { width: mm(o.width_ft) } : {}),
    ...(o.height_ft !== undefined ? { height: mm(o.height_ft) } : {}),
    ...(o.offset_ft !== undefined ? { offset: mm(o.offset_ft) } : {}),
    ...(o.from_floor !== undefined ? { fromFloor: o.from_floor } : {}),
  };
}

/** A part (or part type) and its type's size along each face, for a working space sized to the equipment. */
function equipmentSize(model: ModelState, elementId: string, face: ClearanceFace): { typeZones: readonly ClearanceZone[]; widthMm: number; heightMm: number } | string {
  const el = model.elements[elementId];
  const typeEl = el?.kind === "part" ? model.elements[el.typeId] : el;
  if (typeEl?.kind !== "part_type") return `${elementId} isn't a placed part or part type. bim_query_elements lists them.`;
  const b = localBounds(resolveGeometry(typeEl.definition, el?.kind === "part" ? el.values : {}));
  const along = face === "left" || face === "right" ? b.max[0] - b.min[0] : b.max[1] - b.min[1];
  return { typeZones: typeEl.definition.clearances ?? [], widthMm: along, heightMm: b.max[2] - b.min[2] };
}

export function registerBimSpatialTools(server: McpServer, caller: ResolveBimCaller, options: { projectAdoption?: ProjectAdoptionLookup } = {}): void {
  const projectAdoption = options.projectAdoption ?? noAdoptedElectricalCode;

  server.registerTool(
    "bim_set_clearances",
    {
      title: "Set clearance zones on a part",
      description:
        "Space a part needs kept clear: service access, combustibles, economizer access, NEC 110.26 working space. Zones draw dashed, are never solid, move with the part; lint's clearance-intrusion reports anything inside one. scope type: zones replace the type's (every placed part follows). scope instance: overrides by zone id for this part (null clears; a full zone adds one). working_space computes depth/width/height from Table 110.26(A)(1) for the voltage and condition you choose.",
      inputSchema: {
        ...target,
        ...baseRevision,
        element_id: z.string().min(1).max(200).describe("Placed part id, or (scope type) a part type id."),
        scope: z.enum(["instance", "type"]),
        zones: z.array(zoneInput).max(12).optional().describe("scope type: all of the type's zones ([] removes them)."),
        overrides: z.record(zoneId, overrideInput.nullable()).optional().describe("scope instance: changes by zone id."),
        working_space: workingSpaceInput.optional().describe("Add or replace the zone 'working_space' from NEC 110.26."),
        dedicated_space: z
          .object({ suspended_ceiling_ft: z.number().min(0).max(100).optional(), structure_ft: z.number().min(0).max(100).optional() })
          .strict()
          .optional()
          .describe("Add or replace 'dedicated_space': above the panel, 6 ft or to structure, no ducts or pipes (NEC 110.26(E)). Heights above its floor, as the engineer states them."),
      },
    },
    async (args, extra) => {
      let command: Command;
      try {
        let typeZones: ClearanceZone[] | null = args.zones ? args.zones.map(zoneFromInput) : null;
        const overrides: Record<string, ClearanceOverride | null> = Object.fromEntries(Object.entries(args.overrides ?? {}).map(([k, v]) => [k, v === null ? null : overrideFromInput(v)]));
        if (args.working_space) {
          const ws = args.working_space;
          const face = ws.face ?? "front";
          const who = await caller(extra, args.project_id, false);
          const size = await withSession(who, args.model_id, undefined, async (s) => equipmentSize(s.model(), args.element_id, face));
          if (typeof size === "string") return failure(`Not saved: ${size}`);
          const edition = await editionFor(extra, args.project_id, ws.nec_edition, projectAdoption);
          if (!edition.ok) return failure(`Not saved: ${edition.reason}`);
          const made = workingSpaceZone(edition.edition, { voltageToGround: ws.voltage_to_ground, condition: ws.condition, equipmentWidthMm: size.widthMm, equipmentHeightMm: size.heightMm, ...(ws.extra_depth_multiplier ? { depthMultiplier: ws.extra_depth_multiplier } : {}) }, { face, ...(ws.offset_ft ? { offsetMm: mm(ws.offset_ft) } : {}) });
          if (!made.zone) return failure(`Not saved: ${made.reason}`);
          if (args.scope === "type") typeZones = [...(typeZones ?? size.typeZones).filter((z0) => z0.id !== made.zone.id), made.zone];
          else {
            const { space, zone } = made;
            overrides[zone.id] = { name: zone.name, purpose: zone.purpose, face: zone.face, depth: space.depthMm, width: space.widthMm, height: space.heightMm, ...(ws.offset_ft ? { offset: mm(ws.offset_ft) } : {}), fromFloor: true, ...(zone.basis ? { basis: zone.basis } : {}) };
          }
        }
        if (args.dedicated_space) {
          const ds = args.dedicated_space;
          if (args.scope === "type" && (ds.suspended_ceiling_ft !== undefined || ds.structure_ft !== undefined)) return failure("Not saved: the ceiling heights belong to one placed part (scope instance); the type gets the zone alone.");
          // The clause is the same in NEC 2020 and 2023: with no edition on record the zone is still made, cited without a year.
          const edition = await editionFor(extra, args.project_id, undefined, projectAdoption);
          const zone = dedicatedSpaceZone(edition.ok ? edition.edition : null);
          if (args.scope === "type") {
            const who = await caller(extra, args.project_id, false);
            const size = await withSession(who, args.model_id, undefined, async (s) => equipmentSize(s.model(), args.element_id, "top"));
            if (typeof size === "string") return failure(`Not saved: ${size}`);
            typeZones = [...(typeZones ?? size.typeZones).filter((z0) => z0.id !== zone.id), zone];
          } else {
            const { name, purpose, face, depth, excludes, toStructure, endsAtSuspendedCeiling, cite } = zone;
            overrides[zone.id] = { name, purpose, face, depth, excludes, toStructure, endsAtSuspendedCeiling, cite, ...(ds.structure_ft !== undefined ? { structureMm: mm(ds.structure_ft) } : {}), ...(ds.suspended_ceiling_ft !== undefined ? { suspendedCeilingMm: mm(ds.suspended_ceiling_ft) } : {}) };
          }
        }
        if (args.scope === "type") {
          if (args.overrides) return failure("Not saved: overrides by zone id are for one placed part (scope instance); for the type, send zones.");
          if (!typeZones) return failure("Not saved: send zones (all of the type's zones) or working_space.");
          command = { type: "set_part_clearances", id: args.element_id, scope: "type", zones: typeZones };
        } else {
          if (args.zones) return failure("Not saved: whole zones belong to the part type (scope type); for this part, send overrides by zone id.");
          if (Object.keys(overrides).length === 0) return failure("Not saved: give overrides or working_space.");
          command = { type: "set_part_clearances", id: args.element_id, scope: "instance", overrides };
        }
      } catch (err) {
        return explain(err, "bim_set_clearances");
      }
      return runEdit(caller, "bim_set_clearances", extra, args, command);
    },
  );

  server.registerTool(
    "bim_set_part_host",
    {
      title: "Stand parts on a slab or roof",
      description:
        "Say what parts stand on: one of our slabs (slab_id) or a linked model's slab/roof (linked: model id, name, top elevation, GlobalId if known; the lint block's near.host names the surface and its top), and the curb or rail height. By default each part moves onto it (base = top + curb) and connected runs follow as in a move (refused, naming the run, if one can't). remove_host takes it off. Lint's floating-equipment checks parts against their host; deleting our slab leaves them flagged 'nothing under it'.",
      inputSchema: {
        ...target,
        ...baseRevision,
        part_ids: z.array(z.string().min(1).max(200)).min(1).max(200),
        slab_id: z.string().min(1).max(200).optional().describe("One of our slabs."),
        linked: z
          .object({
            linked_model_id: z.string().min(1).max(200),
            global_id: z.string().min(1).max(64).optional(),
            name: z.string().trim().min(1).max(120),
            surface: z.enum(["slab", "roof"]),
            top_ft: z.number().min(-3000).max(3000).describe("Top of that surface under the part, model elevation in feet."),
          })
          .strict()
          .optional(),
        remove_host: z.boolean().optional().describe("Take the host (and curb) off."),
        curb_in: z.number().min(0).max(MAX_CURB_MM / MM_PER_IN).optional().describe("Curb or rail height, inches (0 removes it)."),
        seat: z.boolean().optional().describe("Move each part onto the host plus curb (default true)."),
      },
    },
    async (args, extra) => {
      const given = [args.slab_id !== undefined, args.linked !== undefined, args.remove_host === true].filter(Boolean).length;
      if (given !== 1) return failure("Not saved: give exactly one of slab_id, linked or remove_host.");
      const host: PartHost | null = args.slab_id
        ? { kind: "slab", elementId: args.slab_id }
        : args.linked
          ? { kind: "linked", referenceId: args.linked.linked_model_id, ...(args.linked.global_id ? { globalId: args.linked.global_id } : {}), name: args.linked.name, surface: args.linked.surface, topMm: mm(args.linked.top_ft) }
          : null;
      const command: Command = {
        type: "set_part_host",
        ids: args.part_ids,
        host,
        ...(host === null ? { curbMm: null } : args.curb_in !== undefined ? { curbMm: args.curb_in === 0 ? null : Math.round(args.curb_in * MM_PER_IN * 10) / 10 } : {}),
        ...(args.seat !== undefined ? { seat: args.seat } : {}),
      };
      return runEdit(caller, "bim_set_part_host", extra, args, command);
    },
  );
}

async function editionFor(extra: Extra, projectId: string, nec: NecEditionYear | undefined, projectAdoption: ProjectAdoptionLookup) {
  const adoption = nec ? null : await projectAdoption(extra, projectId);
  return resolveNecEdition({ necEdition: nec, projectAdoption: adoption });
}
