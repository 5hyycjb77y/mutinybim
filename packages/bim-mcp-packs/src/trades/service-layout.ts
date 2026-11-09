import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ModelState } from "@permitzip/bim-kernel";
import { findServiceRoom, planServiceLayout, serviceLayoutRooms, type ServiceLayoutRequest, ELECTRICAL_TOOL_GROUPS, SERVICE_LAYOUT_ARGS } from "@permitzip/bim-pack-electrical";
import { tradeBaseRevision as baseRevision, explain, failure, runEdit, tradeTarget as target, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { resolveLevelRef } from "@permitzip/bim-mcp";
import { registerPackTools } from "../calc/pack-tools";

/**
 * A starter service layout from a service size (the Electrical tab's Service
 * layout sends the same `place_service_layout` command). Ratings, systems,
 * names and what feeds what are the person's; nothing is sized from loads.
 */

const FT = 304.8;
/** The starter layout's arguments (declared by its add-on). */
export { SERVICE_LAYOUT_ARGS };

type Args = z.infer<z.ZodObject<typeof SERVICE_LAYOUT_ARGS>>;

export function serviceLayoutRequest(model: ModelState, args: Args): ServiceLayoutRequest | string {
  const level = resolveLevelRef(model, args.level);
  if (!level.ok) return level.message;
  if (args.plan_only && (args.origin_ft || args.room)) return "A plan-only layout isn't drawn, so it takes no origin_ft or room; place each piece later from Not placed yet.";
  const room = args.room && !args.origin_ft ? findServiceRoom(model, args.room) : null;
  if (args.room && !args.origin_ft && !room) {
    const rooms = serviceLayoutRooms(model).slice(0, 8).map((r) => r.label);
    return `No room "${args.room}" in this model${rooms.length > 0 ? `; rooms: ${rooms.join(", ")}` : " (it has no rooms yet; give origin_ft)"}.`;
  }
  return {
    levelId: level.id,
    ...(args.origin_ft ? { origin: { x: Math.round(args.origin_ft.x * FT), y: Math.round(args.origin_ft.y * FT) } } : {}),
    ...(room ? { roomId: room.id } : {}),
    serviceA: args.service_a,
    system: args.system,
    meter: args.meter,
    mainDisconnect: args.main_disconnect,
    ...(args.plan_only ? { planOnly: true } : {}),
    ...(args.distribution ? { distribution: args.distribution } : {}),
    equipment: args.equipment.map((e) => ({
      kind: e.kind,
      name: e.name,
      fedFrom: e.fed_from,
      ...(e.bus_a !== undefined ? { busA: e.bus_a } : {}),
      ...(e.system ? { system: e.system } : {}),
      ...(e.mains ? { mains: e.mains } : {}),
      ...(e.kva !== undefined ? { kva: e.kva } : {}),
      ...(e.breaker_a !== undefined ? { breakerA: e.breaker_a } : {}),
    })),
  };
}

export function registerBimServiceLayoutTool(server: McpServer, caller: ResolveBimCaller) {
  const shape = { ...target, ...baseRevision, ...SERVICE_LAYOUT_ARGS };
  // Builds its command from the open model (levels, rooms): hosted here.
  registerPackTools(server, caller, "electrical", {
    only: ELECTRICAL_TOOL_GROUPS.serviceLayout,
    hosted: {
      bim_place_service_layout: (copy) =>
        server.registerTool("bim_place_service_layout", { ...copy, inputSchema: shape }, async (raw, extra: Extra) => {
      const parsed = z.object(shape).safeParse(raw);
      if (!parsed.success) return failure(`Those arguments don't fit bim_place_service_layout: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const args = parsed.data;
      let model: ModelState;
      try {
        const who = await caller(extra, args.project_id, false);
        model = await withSession(who, args.model_id, undefined, async (s) => s.model());
      } catch (err) {
        return explain(err, "bim_place_service_layout");
      }
      const request = serviceLayoutRequest(model, args);
      if (typeof request === "string") return failure(request);
      const plan = planServiceLayout(model, request);
      if (!plan.ok) return failure(plan.reason);
      return runEdit(caller, "bim_place_service_layout", extra, { project_id: args.project_id, model_id: args.model_id, base_revision: args.base_revision ?? model.revision }, plan.command);
        }),
    },
  });
}
