import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PART_CATEGORIES,
  definitionTypes,
  localBounds,
  partDefinition,
  partDefinitionFieldsSchema,
  partGroupName,
  partMesh,
  partTypeIssues,
  resolveConnectors,
  resolveGeometry,
  type PartTypeDefinition,
} from "@permitzip/bim-kernel";
import { FirmPartRefusal } from "@permitzip/bim-editor/contracts/bim/firm-part-versions";
import { initPartGeometry } from "@permitzip/bim-editor/contracts/bim/part-geometry";
import { ADVERTISED_PART_DEFINITION } from "../parts/part-editor";
import type { Extra } from "../runtime";
import { CutSheetDraftError, draftPartFromCutSheet } from "../support/cut-sheet/draft-part";
import { extractCutSheetFacts, type CutSheetFacts, type CutSheetLine } from "../support/cut-sheet/extract";
import { pdfLines } from "../support/cut-sheet/pdf-lines";
import type { CutSheetFile, CutSheetToolsHost } from "./capabilities";

export type { CutSheetFile, CutSheetToolsHost, ReadCutSheetFile } from "./capabilities";

/**
 * Parts from manufacturer cut sheets, and the firm part library.
 *
 *   bim_draft_part_from_cut_sheet  read a PDF on the project (its text, page
 *     by page), pull out the sheet's dimensions, openings, connections and
 *     electrical data, and draft a part definition with every value cited to
 *     its page and line. Saves nothing.
 *   bim_list_firm_parts            parts every project can place.
 *   bim_save_firm_part             save a definition to the firm library
 *     (pauses for approval; the host decides, not the model server).
 *
 * The host reads the project file as the caller; the tools read its text.
 */

/** No PDF the call names that the caller may read: the message says what to do instead. */
export class CutSheetNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutSheetNotFound";
  }
}

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const ft = (mm: number) => Math.round((mm / MM_PER_FT) * 1000) / 1000;
const inch = (mm: number) => Math.round((mm / MM_PER_IN) * 100) / 100;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Facts in inches and plain words, each with where it was read. */
function readableFacts(f: CutSheetFacts) {
  const len = (x: { value: number; source: { page: number; line: string } } | null) => (x ? { in: inch(x.value), page: x.source.page, line: x.source.line } : null);
  const n = (x: { value: number; source: { page: number; line: string } } | null | undefined) => (x ? { value: x.value, page: x.source.page, line: x.source.line } : null);
  return {
    kind: f.kind?.value ?? null,
    manufacturer: f.manufacturer?.value ?? null,
    model: f.model?.value ?? null,
    length: len(f.lengthMm),
    width: len(f.widthMm),
    height: len(f.heightMm),
    diameter: len(f.diameterMm),
    face_size: len(f.faceSizeMm),
    curb_height: len(f.curbHeightMm),
    openings: f.openings.map((o) => ({
      role: o.role,
      ...(o.widthMm !== undefined && o.depthMm !== undefined ? { size_in: `${inch(o.widthMm)} x ${inch(o.depthMm)}` } : {}),
      ...(o.diameterMm !== undefined ? { size_in: `${inch(o.diameterMm)} round` } : {}),
      ...(o.fromEdge ? { centre: `${inch(o.fromEdge.mm)} in from the ${o.fromEdge.edge}` } : {}),
      page: o.source.page,
      line: o.source.line,
    })),
    pipes: f.pipes.map((p) => ({ role: p.role, size_in: inch(p.diameterMm), page: p.source.page, line: p.source.line })),
    electrical: Object.fromEntries(Object.entries(f.electrical).map(([k, v]) => [k, n(v)])),
    cooling_tons: n(f.coolingTons),
    airflow_cfm: n(f.airflowCfm),
    heating_btuh: n(f.heatingBtuh),
    storage_gallons: n(f.storageGallons),
    recovery_gph: n(f.recoveryGph),
    weight_lb: n(f.weightLb),
  };
}

/** What every size builds to: overall size and connectors, or the problem. */
async function sizesOf(def: PartTypeDefinition) {
  await initPartGeometry();
  return definitionTypes(def).map(({ typeId, definition }) => {
    const b = localBounds(resolveGeometry(definition));
    const triangles = definition.model ? partMesh(definition).triangleCount : 0;
    return {
      type_id: typeId,
      size: definition.typeName,
      overall_ft: { length: ft(b.max[0] - b.min[0]), width: ft(b.max[1] - b.min[1]), height: ft(b.max[2] - b.min[2]) },
      triangles,
      connectors: resolveConnectors(definition).map((c) => ({
        id: c.id,
        label: c.label,
        domain: c.domain,
        system: c.systemKind,
        position_ft: c.position.map(ft),
        direction: c.direction,
        ...(c.width !== undefined && c.height !== undefined ? { size_in: `${inch(c.width)} x ${inch(c.height)}` } : {}),
        ...(c.diameter !== undefined ? { size_in: `${inch(c.diameter)} round` } : {}),
        ...(c.voltage !== undefined ? { voltage: c.voltage, poles: c.poles } : {}),
      })),
    };
  });
}

const MAX_TEXT_LINES = 250;

export function registerBimCutSheetTools(server: McpServer, host: CutSheetToolsHost): void {
  const read = host.readCutSheet;
  const firm = host.firmParts;

  server.registerTool(
    "bim_draft_part_from_cut_sheet",
    {
      title: "Draft a part from a cut sheet",
      description:
        "Draft a part (rooftop unit, air terminal, water heater) from a cut sheet PDF on the project. Returns the sheet text by page, each fact (dimensions, openings, connections, electrical, capacity, model) cited to page and line, assumptions, and a checked part definition. Saves nothing. Fix what's wrong (bim_check_part_definition), then save with bim_save_part_definition or bim_save_firm_part (both pause for approval).",
      inputSchema: {
        project_id: z.string().uuid().describe("The project the cut sheet is uploaded to."),
        file_id: z.string().uuid().optional().describe("The PDF's file id (search_content results). Give this or file_url."),
        file_url: z.string().url().max(2000).optional().describe("A storage link to the PDF on this project (a signed or download link). Other URLs are refused."),
        kind: z.enum(["rooftop_unit", "air_terminal", "water_heater"]).optional().describe("What the sheet describes, when it isn't obvious from its title."),
        part_name: z.string().trim().min(1).max(200).optional().describe('Name in the library (default: "<kind>, <manufacturer> <model>").'),
      },
    },
    async (args, extra: Extra) => {
      if (!args.file_id && !args.file_url) return failure("Give file_id (from search_content) or file_url (a storage link to the PDF on this project).");
      let lines: CutSheetLine[];
      let file: CutSheetFile;
      try {
        file = await read(extra, args.project_id, { ...(args.file_id ? { fileId: args.file_id } : {}), ...(args.file_url ? { fileUrl: args.file_url } : {}) });
        lines = (await pdfLines(file.bytes)).lines;
      } catch (err) {
        if (!(err instanceof CutSheetNotFound)) console.error("[bim_draft_part_from_cut_sheet] read failed", err);
        return failure(err instanceof Error ? err.message : String(err));
      }
      if (lines.length === 0) return failure(`${file.fileName} has no text to read (a scanned image?). Read it with the document tools or type the dimensions into a definition from bim_part_definition_example.`);
      const facts = extractCutSheetFacts(lines);
      const sheet_text = lines.slice(0, MAX_TEXT_LINES).map((l) => `p${l.page}: ${l.text}`);
      try {
        const drafted = draftPartFromCutSheet(facts, { fileName: file.fileName, ...(file.fileId ? { fileId: file.fileId } : {}), ...(args.kind ? { kind: args.kind } : {}), ...(args.part_name ? { partName: args.part_name } : {}) });
        const def = partDefinition(drafted.partName, drafted.definition);
        const issues = partTypeIssues(def).map((i) => `${i.field}: ${i.message}`);
        return json({
          status: issues.length === 0 ? "drafted" : "has_issues",
          file: { name: file.fileName, ...(file.fileId ? { file_id: file.fileId } : {}) },
          kind: drafted.kind,
          part_name: drafted.partName,
          facts: readableFacts(facts),
          assumptions: drafted.assumptions,
          ...(issues.length > 0 ? { issues } : { sizes: await sizesOf(def) }),
          definition: partDefinitionFieldsSchema.parse(def),
          sheet_text,
          ...(lines.length > MAX_TEXT_LINES ? { sheet_text_truncated: `${lines.length - MAX_TEXT_LINES} more lines not shown` } : {}),
          next:
            issues.length > 0
              ? "Fix these in the definition and check it with bim_check_part_definition."
              : "Check every number against sheet_text and the assumptions with the person. Then save with bim_save_part_definition (this project's library) or bim_save_firm_part (the firm library), same part_name and definition; both pause for approval.",
        });
      } catch (err) {
        if (err instanceof CutSheetDraftError) return json({ status: "not_drafted", file: { name: file.fileName }, reason: err.message, facts: readableFacts(facts), sheet_text, next: "Write the definition by hand from sheet_text, starting from bim_part_definition_example." });
        console.error("[bim_draft_part_from_cut_sheet] draft failed", err);
        return failure(`The part couldn't be drafted: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "bim_list_firm_parts",
    {
      title: "List firm library parts",
      description:
        "Parts in the firm library, which every project can place: name, category, every size's type id, revision and where each came from (e.g. its cut sheet). Place one with bim_place_part, type_id = a size's type id and from_firm_library = true.",
      inputSchema: {
        search: z.string().max(80).optional().describe("Words in the part's name."),
        category: z.enum(PART_CATEGORIES).optional(),
      },
    },
    async (args, extra: Extra) => {
      try {
        const parts = await (await firm(extra)).list({ ...(args.search ? { search: args.search } : {}), ...(args.category ? { category: args.category } : {}) });
        return json({ count: parts.length, parts: parts.map((p) => ({ model_id: p.modelId, part_name: p.partName, category: p.category, sizes: p.sizes.map((s) => ({ type_id: s.typeId, name: s.name })), revision: p.revision, updated_at: p.updatedAt, source: p.source })) });
      } catch (err) {
        console.error("[bim_list_firm_parts] failed", err);
        return failure(`The firm library couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerTool(
    "bim_save_firm_part",
    {
      title: "Save a part to the firm library",
      description:
        "Save a modeled part definition (from the part editor, bim_read_part_definition or bim_draft_part_from_cut_sheet) to the firm library, where every project can place it. A part with the same model id is replaced (its revision goes up; projects that already placed it keep their copy until they save it again). Refused, with the reason, if the definition doesn't check out. Pauses for approval.",
      inputSchema: {
        part_name: z.string().trim().min(1).max(200),
        definition: ADVERTISED_PART_DEFINITION,
      },
    },
    async (args, extra: Extra) => {
      const fields = partDefinitionFieldsSchema.safeParse(args.definition);
      if (!fields.success) return failure(`Those arguments don't fit bim_save_firm_part: ${fields.error.issues.map((i) => `definition.${i.path.join(".")} ${i.message}`).join("; ")}`);
      try {
        const userId = await host.signedInPerson(extra);
        const def = partDefinition(args.part_name, fields.data);
        await initPartGeometry();
        for (const { definition } of definitionTypes(def)) if (definition.model) partMesh(definition);
        const saved = await (await firm(extra)).save(def, userId);
        return json({ status: "saved", library: "firm", change: saved.status, model_id: saved.modelId, revision: saved.revision, part_name: partGroupName(def), message: `${saved.status === "added" ? "Added" : "Updated"} ${partGroupName(def)} in the firm library (revision ${saved.revision}). Place it on any project with bim_place_part and from_firm_library.` });
      } catch (err) {
        if (err instanceof FirmPartRefusal) return json({ status: "refused", message: `Not saved: ${err.message}. Nothing changed.` });
        console.error("[bim_save_firm_part] failed", err);
        return failure(`Not saved to the firm library: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
