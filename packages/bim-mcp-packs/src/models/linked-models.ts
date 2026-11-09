import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BimLinkedModelEditToolName } from "../support/tool-names";
import type { LinkedModelsResponse, LinkedReferenceView } from "@permitzip/bim-editor/contracts/building-model/linked-contract";
import type { LinkedModelStore, LinkedModelToolsHost } from "./capabilities";
import { failure, text, type Extra } from "../runtime";

/**
 * Linked models (the architect's model and other references shown under the
 * MutinyBIM model), with the same actions as the Building Model's Linked
 * models panel: list them, browse and add from Autodesk Docs, check for a new
 * Docs version or export again, line up with the project model, re-export our
 * Revit model, retry a failed conversion, show another version, adjust the
 * position, unlink. Every read and write goes through the host's
 * `LinkedModelStore` as the person, with the same project permission the
 * panel checks; where models are kept and the document service they come
 * from are the host's. Uploading an IFC file stays in the browser: it needs a
 * file from the person's computer.
 */

const FT_PER_M = 1000 / 304.8;
export const toFt = (m: number) => Math.round(m * FT_PER_M * 1000) / 1000;
export const toM = (ft: number) => ft / FT_PER_M;

const projectOnly = { project_id: z.string().uuid().describe("PermitZIP project id; linked models belong to the project's Building Model.") };
const referenceId = z.string().uuid().describe("A linked model's id from bim_list_linked_models.");

/**
 * Why one of `disciplines` can't be stored on a linked model, in plain words,
 * or null. Checked against what this host can register (built-in, first-party
 * and installed add-ons). Firm rows live in each model's own setup: with the
 * open model's pinned firm disciplines (`modelFirm`) a `firm:` id it doesn't
 * pin is refused; without an open model a well-formed `firm:` id passes and
 * the panel shows it in its own words until the model pins it.
 */
export async function linkedDisciplineRefusal(disciplines: readonly string[], modelFirm: ReadonlySet<string> | null = null): Promise<string | null> {
  const [{ disciplineLabel, isRegistryIdShape }, { PackSet }, host, { linkedDisciplineProblem }] = await Promise.all([
    import("@permitzip/bim-kernel"),
    import("@permitzip/bim-kernel/packs"),
    import("@permitzip/bim-editor/contracts/building-model/installed-packs"),
    import("@permitzip/bim-editor/contracts/building-model/linked-contract"),
  ]);
  host.ensureFirstPartyAddOns();
  const set = PackSet.create(host.installedPacks());
  for (const id of new Set(disciplines)) {
    if (isRegistryIdShape(id) && id.startsWith("firm:")) {
      if (modelFirm && !modelFirm.has(id)) return `${disciplineLabel(id)} (${id}) isn't one of this model's own disciplines. Pin it in Building Model › Manage › Model settings › Disciplines first, or pick another. Nothing was linked.`;
      continue;
    }
    const problem = linkedDisciplineProblem(id, set);
    if (problem) return `${problem}. Nothing was linked.`;
  }
  return null;
}

export const LINKED_MODEL_EDIT_ARGS = {
  bim_link_from_autodesk_docs: z.object({
    items: z
      .array(
        z.object({
          item_id: z.string().min(1).max(300).describe("The Docs file's item_id from bim_browse_autodesk_docs."),
          label: z.string().trim().min(1).max(200).describe("The name people see, e.g. \"Architecture (Smith Architects)\"."),
          discipline: z.string().min(1).max(96).describe("architecture, mep (existing MEP), structure, other, or a registered discipline id (fire_alarm, an add-on's vt.elevators)."),
        }),
      )
      .min(1)
      .max(25),
  }),
  bim_update_linked_model: z.object({
    action: z
      .enum(["check_for_new_version", "relink_from_docs", "line_up", "reexport_project_model", "retry_conversion", "show_version", "adjust_position"])
      .describe(
        "check_for_new_version: bring in a newer Docs version if there is one (Docs models). relink_from_docs: export it from Docs again. line_up: place it again against our Revit model as it is now (Docs models). reexport_project_model: export our own Revit model again (what a model waiting on ours needs before line_up). retry_conversion: try a failed conversion again. show_version: show another converted version. adjust_position: save a position adjustment.",
      ),
    reference_id: referenceId.optional().describe("The linked model. Every action but reexport_project_model needs it."),
    version_id: z.string().uuid().optional().describe("show_version: the version to show. retry_conversion: the failed version (default: the one shown)."),
    east_ft: z.number().finite().min(-100_000).max(100_000).optional().describe("adjust_position: east offset from where it was placed, feet."),
    north_ft: z.number().finite().min(-100_000).max(100_000).optional().describe("adjust_position: plan-north offset, feet."),
    up_ft: z.number().finite().min(-10_000).max(10_000).optional().describe("adjust_position: vertical offset, feet."),
    rotation_deg: z.number().gt(-360).lt(360).optional().describe("adjust_position: turn in degrees, counter-clockwise seen from above, about where the file's own origin sits."),
  }),
  bim_unlink_linked_model: z.object({ reference_id: referenceId }),
} as const satisfies Record<BimLinkedModelEditToolName, z.ZodTypeAny>;

export type LinkedModelUpdateArgs = z.infer<typeof LINKED_MODEL_EDIT_ARGS.bim_update_linked_model>;

export const QUEUED_TAIL = "The linked-models worker picks it up within a minute; bim_list_linked_models shows its progress.";

/** The listing an agent plans from: positions in feet, newest version first, plain-word statuses. */
export function agentLinkedModels(response: LinkedModelsResponse) {
  return {
    can_edit: response.canEdit,
    project_revit_model: response.revitModel?.name ?? null,
    linked_models: response.references.map(referenceFacts),
    autodesk_export: response.autodeskExport
      ? {
          status: response.autodeskExport.status,
          error: response.autodeskExport.error,
          notice: response.autodeskExport.notice,
          started_at: response.autodeskExport.createdAt,
          links_not_brought_in: response.autodeskExport.missingLinks.map((m) => ({ title: m.title, reason: m.reason })),
          found_no_revit_links: response.autodeskExport.foundNoRevitLinks,
        }
      : null,
    docs_imports: response.docsImports.map((d) => ({ item_id: d.itemId, file_name: d.fileName, label: d.label, status: d.status, error: d.error, adds_to: d.referenceId })),
    note: "Positions are offsets from where each model was placed automatically. Upload an IFC file from the Linked models panel (it needs a file from the person's computer).",
  };
}

function referenceFacts(ref: LinkedReferenceView) {
  const current = ref.versions.find((v) => v.id === ref.currentVersionId) ?? null;
  return {
    id: ref.id,
    label: ref.label,
    discipline: ref.discipline,
    disciplines: ref.disciplines ?? [ref.discipline],
    contributor: ref.contributor ?? null,
    source: ref.source,
    is_project_model: ref.isProjectModel,
    docs_file: ref.docsItem ? { file_name: ref.docsItem.fileName, docs_version: ref.docsItem.versionNumber } : null,
    shown_version: current
      ? {
          id: current.id,
          number: current.number,
          status: current.status,
          error: current.error,
          file_name: current.originalFileName,
          supplied_by: current.suppliedBy.organization ? `${current.suppliedBy.organization} (via ${current.suppliedBy.name})` : current.suppliedBy.name,
          placement: current.placementBasis,
          alignment: current.alignment,
          alignment_note: current.alignmentNote,
          fix: current.alignmentRemedy === "reexport_host" ? "reexport_project_model, then line_up" : current.alignmentRemedy === "line_up" ? "line_up" : null,
        }
      : null,
    versions: ref.versions.map((v) => ({ id: v.id, number: v.number, status: v.status, error: v.error, file_name: v.originalFileName, created_at: v.createdAt })),
    adjustment: { east_ft: toFt(ref.adjustment.x), north_ft: toFt(ref.adjustment.y), up_ft: toFt(ref.adjustment.z), rotation_deg: ref.adjustment.rotationDeg, saved_at: ref.adjustedAt },
  };
}

/** A refusal the person can act on comes back as the answer; anything else is a fault and is logged. */
function answer(store: LinkedModelStore, tool: string, err: unknown) {
  const refused = store.refusalMessage(err);
  if (refused !== null) return text({ status: "refused", message: refused });
  console.error(`[mcp:${tool}] failed`, err);
  return failure(err instanceof Error ? err.message : `Unexpected error in ${tool}`);
}

export function registerBimLinkedModelTools(server: McpServer, host: LinkedModelToolsHost): void {
  const { store, modelFirmDisciplines } = host;
  server.registerTool(
    "bim_list_linked_models",
    {
      title: "List linked models",
      description:
        "The models linked under this project's Building Model (the architect's model, structure, existing MEP, our own Revit model): where each came from, the version shown and every version with its status (queued, converting, ready, failed), whether it is lined up (and what fixes it when not), its position adjustment in feet, the latest export from Revit and Docs files still coming in. Read this before levels from the architect, line-up or anything that depends on a linked model.",
      inputSchema: projectOnly,
    },
    async (args, extra: Extra) => {
      try {
        const access = await store.open(extra, args.project_id, false);
        return text(agentLinkedModels(await access.list()));
      } catch (err) {
        return answer(store, "bim_list_linked_models", err);
      }
    },
  );

  server.registerTool(
    "bim_browse_autodesk_docs",
    {
      title: "Browse Autodesk Docs for a model to link",
      description:
        "List a folder of the project's Autodesk Docs project (top folders when folder_id is left out), or search below it by name. Each file says whether it can be linked and why not, and which linked model it already is. Needs model edit access and the person's Autodesk sign-in (Settings), like Link a model › From Autodesk Docs. Then bim_link_from_autodesk_docs.",
      inputSchema: {
        ...projectOnly,
        folder_id: z.string().trim().min(1).max(300).optional().describe("A folder id from a previous listing."),
        query: z.string().trim().min(1).max(100).optional().describe("Search file names below the folder (or below the top folders)."),
      },
    },
    async (args, extra: Extra) => {
      try {
        const access = await store.open(extra, args.project_id, true);
        const listing = await access.browseDocs(args.folder_id ?? null, args.query ?? null);
        return text({
          folders: listing.folders,
          files: listing.files.map((f) => ({
            item_id: f.itemId,
            name: f.name,
            kind: f.kind,
            docs_version: f.versionNumber,
            folder: f.folderPath,
            last_modified: f.lastModified,
            already_linked_as: f.linked,
            can_link: f.blockedReason === null,
            why_not: f.blockedReason,
          })),
        });
      } catch (err) {
        return answer(store, "bim_browse_autodesk_docs", err);
      }
    },
  );

  server.registerTool(
    "bim_link_from_autodesk_docs",
    {
      title: "Link models from Autodesk Docs",
      description:
        "Bring up to 25 Revit or IFC files from the project's Autodesk Docs into the Building Model as linked models, each with the name people see and its discipline. A file already linked adds a new version to that linked model. Autodesk exports and converts them in the background; bim_list_linked_models shows progress. Needs model edit access and the person's Autodesk sign-in.",
      inputSchema: { ...projectOnly, ...LINKED_MODEL_EDIT_ARGS.bim_link_from_autodesk_docs.shape },
    },
    async (args, extra: Extra) => {
      try {
        const access = await store.open(extra, args.project_id, true);
        const ids = args.items.map((i) => i.discipline);
        const refused = await linkedDisciplineRefusal(ids, ids.some((id) => id.startsWith("firm:")) ? await modelFirmDisciplines(extra, args.project_id) : null);
        if (refused) return failure(refused);
        const results = await access.linkFromDocs(args.items.map((i) => ({ itemId: i.item_id, label: i.label, discipline: i.discipline })));
        const running = results.filter((r) => r.outcome === "already_running").length;
        const queued = results.length - running;
        return text({
          status: queued > 0 ? "queued" : "unchanged",
          message: `${queued} file${queued === 1 ? "" : "s"} coming in from Autodesk Docs${running > 0 ? `; ${running} already on the way` : ""}. ${QUEUED_TAIL}`,
          results: results.map((r) => ({ item_id: r.itemId, outcome: r.outcome })),
        });
      } catch (err) {
        return answer(store, "bim_link_from_autodesk_docs", err);
      }
    },
  );

  server.registerTool(
    "bim_update_linked_model",
    {
      title: "Refresh, line up, position or switch a linked model",
      description:
        "The Linked models panel's actions on one linked model: check Docs for a newer version or export it again, line it up with the project model, export our own Revit model again, try a failed conversion again, show another converted version, or save a position adjustment (feet and degrees from where it was placed; give only what changes). What changes is seen by everyone on the project. Read bim_list_linked_models first.",
      inputSchema: { ...projectOnly, ...LINKED_MODEL_EDIT_ARGS.bim_update_linked_model.shape },
    },
    async (args, extra: Extra) => {
      try {
        const access = await store.open(extra, args.project_id, true);
        return text(await access.update(LINKED_MODEL_EDIT_ARGS.bim_update_linked_model.parse(args)));
      } catch (err) {
        return answer(store, "bim_update_linked_model", err);
      }
    },
  );

  server.registerTool(
    "bim_unlink_linked_model",
    {
      title: "Unlink a linked model",
      description:
        "Take a linked model out of the Building Model for everyone on the project. Its files and versions are kept, and a conversion still running won't bring it back; linking it again from Docs or an upload adds it anew. Views that showed it stop drawing it.",
      inputSchema: { ...projectOnly, ...LINKED_MODEL_EDIT_ARGS.bim_unlink_linked_model.shape },
    },
    async (args, extra: Extra) => {
      try {
        const access = await store.open(extra, args.project_id, true);
        const ref = await access.unlink(args.reference_id);
        return text({ status: "saved", message: `Unlinked ${ref.label}. Its files and versions are kept.` });
      } catch (err) {
        return answer(store, "bim_unlink_linked_model", err);
      }
    },
  );
}
