import { mkdirSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BimToolPack } from "@permitzip/bim-mcp";
import type { ResolveBimCaller } from "./runtime";
import { noAdoptedCodes } from "./calc/local";
import { localLintTools, noBranchActions, noLinkedSurfaces } from "./coordination/local";
import { localDrawingSetToolsHost, localLinkedStoreys, localRenderToolsHost } from "./drawings/local";
import { localCutSheetToolsHost, localScheduleToolsHost } from "./library/local";
import { localLinkedModelTools, memoryRouteDefaults, noPictureReader } from "./models/local";
import { memoryFirmParts } from "./parts/local";
import { localViewToolsHost } from "./views/local";
import { registerBimToolPacks, type BimToolPacksHost } from "./compose";

/**
 * Every add-on pack on one person's own computer: printed sheets, issued sets
 * and saved pictures are files under `dir`; schedules, firm parts, lint
 * settings and route defaults live in memory; what needs a hosted MutinyBIM
 * (Autodesk linking, branches, reading pictures with AI, a project's adopted
 * codes) answers in plain words that it isn't available here.
 */
export function localToolPacksHost(local: { readonly caller: ResolveBimCaller; readonly runId: string; readonly person: string }, dir: string): BimToolPacksHost {
  mkdirSync(dir, { recursive: true });
  const firmParts = memoryFirmParts();
  return {
    caller: local.caller,
    runId: async () => local.runId,
    lint: localLintTools(),
    views: localViewToolsHost(dir),
    drawingSet: localDrawingSetToolsHost(dir),
    render: localRenderToolsHost(dir),
    codeAdoptions: noAdoptedCodes,
    schedules: localScheduleToolsHost(),
    branches: noBranchActions,
    linkedModels: localLinkedModelTools,
    cutSheets: localCutSheetToolsHost(dir),
    pictures: noPictureReader,
    linkedStoreys: localLinkedStoreys(),
    linkedSurfaces: noLinkedSurfaces,
    routeDefaults: memoryRouteDefaults().store,
    firmParts: async () => firmParts,
  };
}

/** The tool names a registration makes, without serving anything. */
function namesOf(register: (server: McpServer) => void): string[] {
  const names: string[] = [];
  const recorder = { registerTool: (name: string) => (names.push(name), recorder) };
  register(recorder as unknown as McpServer);
  return names;
}

/** All the add-on families as one tool pack for the tool server, registered after the core. */
export function localToolPacks(local: { readonly caller: ResolveBimCaller; readonly runId: string; readonly person: string }, dir: string): BimToolPack {
  const host = localToolPacksHost(local, dir);
  return {
    id: "mutinybim-packs",
    purpose: "every MutinyBIM tool family beyond the core: parts, routing and fittings, electrical and plumbing, views, sheets and drafting, schedules, coordination",
    tools: namesOf((server) => registerBimToolPacks(server, host)),
    register: (server) => registerBimToolPacks(server, host),
  };
}
