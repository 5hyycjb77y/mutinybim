import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveNecEdition } from "@permitzip/bim-calc";
import type { Registry } from "@permitzip/bim-kernel";
import { area, baseRevision, editAs, readAs, target, type Extra, type ResolveBimCaller } from "./runtime";
import type { Capability } from "./capabilities";
import { registerBimCalcTools } from "./calc/calc";
import type { ProjectCodeAdoptions } from "./calc/capabilities";
import { registerInstalledPackTools } from "./calc/pack-tools";
import { registerBimPipeSizingTools } from "./calc/pipe-sizing";
import type { BranchActions, LinkedSurfaceSources, LintToolsHost } from "./coordination/capabilities";
import { registerBimLintTools } from "./coordination/lint";
import { registerBimOrganizationTools } from "./coordination/organization";
import { registerBimSurfacesTools } from "./coordination/surfaces";
import { registerBimAnnotationTools } from "./drawings/annotation";
import type { DrawingSetToolsHost, LinkedStoreysFor, RenderToolsHost } from "./drawings/capabilities";
import { registerBimDetailingTools } from "./drawings/detailing";
import { registerBimDrawingSetTools } from "./drawings/drawing-set";
import { registerBimLevelTools } from "./drawings/levels";
import { registerBimOneLineTools } from "./drawings/one-line";
import { registerBimRenderTools } from "./drawings/render";
import { registerBim3dViewTools } from "./drawings/views-3d";
import type { CutSheetToolsHost, ScheduleToolsHost } from "./library/capabilities";
import { registerBimCutSheetTools } from "./library/cut-sheet";
import { registerBimScheduleTools } from "./library/schedules";
import type { LinkedModelToolsHost, PictureRowsReader, RouteDefaultsStore } from "./models/capabilities";
import { registerBimIntakeTools } from "./models/intake";
import { registerBimLinkedModelTools } from "./models/linked-models";
import type { FirmPartsSource } from "./parts/capabilities";
import { registerBimDescribeCommandsTool } from "./parts/describe-commands";
import { registerBimPartTools, type PartToolHelpers } from "./parts/parts";
import { withElementIdAlias } from "./parts/vocabulary";
import { withBimToolAnnotations } from "./support/tool-annotations";
import { registerBimCoordinateTools } from "./routing/coordinates";
import { registerBimFittingTools } from "./routing/fittings";
import { registerBimModelEditTools } from "./routing/model-edits";
import { registerBimRoutingTools } from "./routing/routing";
import { registerBimElectricalTools } from "./trades/electrical";
import { registerBimPlumbingTools } from "./trades/plumbing";
import { registerBimPlumbingDesignTools } from "./trades/plumbing-design";
import { registerBimSpatialTools } from "./trades/spatial";
import { registerBimViewTools } from "./views/views";
import type { ViewToolsHost } from "./views/capabilities";

/**
 * Every add-on tool family on one server, in one order, over one host: the
 * caller (who, may they, the model server) and the services each family
 * declares. A host that already composes its own server (with its own
 * middleware around these registrations) may call the families directly
 * instead; the tools are the same.
 */
export interface BimToolPacksHost {
  readonly caller: ResolveBimCaller;
  /** This agent run, for idempotent part edits. */
  runId(extra: unknown): Promise<string>;
  readonly lint: LintToolsHost;
  readonly views: ViewToolsHost;
  readonly drawingSet: DrawingSetToolsHost;
  readonly render: RenderToolsHost;
  readonly codeAdoptions: ProjectCodeAdoptions;
  readonly schedules: ScheduleToolsHost;
  readonly branches: BranchActions;
  readonly linkedModels: LinkedModelToolsHost;
  readonly cutSheets: CutSheetToolsHost;
  readonly pictures: Capability<PictureRowsReader>;
  readonly linkedStoreys: LinkedStoreysFor;
  readonly linkedSurfaces: LinkedSurfaceSources;
  readonly routeDefaults: RouteDefaultsStore;
  firmParts(extra: unknown): Promise<FirmPartsSource>;
  /** The class and parameter registry the caller reads (built-in plus the firm's), for bim_set_element's units. */
  parameterLibrary?(extra: unknown, projectId: string): Promise<Registry>;
}

function isExtra(value: unknown): value is Extra {
  return typeof value === "object" && value !== null;
}

export function registerBimToolPacks(rawServer: McpServer, host: BimToolPacksHost): void {
  // A tool that names one element takes `element_id` too; every tool says whether it changes the model (MCP annotations).
  const server = withElementIdAlias(withBimToolAnnotations(rawServer));
  const { caller } = host;
  registerBimLintTools(server, caller, host.lint);
  registerBimViewTools(server, caller, host.views);
  registerBimDrawingSetTools(server, caller, host.drawingSet);
  registerBimAnnotationTools(server, caller);
  registerBim3dViewTools(server, caller);
  registerBimDetailingTools(server, caller);
  registerBimOneLineTools(server, caller);
  registerBimCalcTools(server, caller, host.codeAdoptions);
  registerBimElectricalTools(server, caller, { projectAdoption: host.codeAdoptions.projectAdoption });
  registerBimPlumbingDesignTools(server, caller);
  registerBimScheduleTools(server, caller, host.schedules);
  registerBimRenderTools(server, caller, host.render);
  registerBimOrganizationTools(server, caller, host.branches);
  registerBimLinkedModelTools(server, host.linkedModels);
  registerBimCutSheetTools(server, host.cutSheets);
  registerBimIntakeTools(server, caller, host.pictures);
  registerBimLevelTools(server, caller, host.linkedStoreys);
  registerBimPlumbingTools(server, caller);
  registerBimSpatialTools(server, caller, { projectAdoption: host.codeAdoptions.projectAdoption });
  registerBimSurfacesTools(server, caller, host.linkedSurfaces);
  registerInstalledPackTools(server, caller);
  registerBimDescribeCommandsTool(server);
  registerBimModelEditTools(server, caller);
  const helpers: PartToolHelpers = {
    target,
    area,
    baseRevision,
    read: (tool, extra, args, work) => readAs(caller, tool, extra, args, work),
    edit: (tool, extra, args, editArgs, build) => editAs(caller, tool, extra, args, editArgs, build),
    runId: (extra) => host.runId(extra),
    firmParts: (extra) => host.firmParts(extra),
    ...(host.parameterLibrary ? { parameterLibrary: host.parameterLibrary } : {}),
    async necEdition(extra, projectId) {
      const adoption = await host.codeAdoptions.projectAdoption(isExtra(extra) ? extra : {}, projectId);
      const resolved = resolveNecEdition({ projectAdoption: adoption });
      return resolved.ok ? resolved.edition : null;
    },
  };
  registerBimPartTools(server, helpers);
  registerBimRoutingTools(server, helpers, { routeDefaults: host.routeDefaults });
  registerBimFittingTools(server, helpers);
  registerBimCoordinateTools(server, helpers);
  registerBimPipeSizingTools(server, helpers, { fuelGas: host.codeAdoptions.fuelGas, plumbing: host.codeAdoptions.plumbing });
}
