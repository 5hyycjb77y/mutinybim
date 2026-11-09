import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PART_VIEWS,
  connectorPlacementWarnings,
  definitionTypes,
  exampleFloorDrain,
  exampleRooftopUnit,
  localBounds,
  partDefinition,
  partDefinitionFieldsSchema,
  partGroupName,
  partMesh,
  partTypeIssues,
  partViewLinework,
  partViewSvg,
  resolveClearances,
  resolveConnectors,
  resolveDim,
  resolveGeometry,
  resolvePartModel,
  type PartTypeDefinition,
} from "@permitzip/bim-kernel";
import { initPartGeometry } from "@permitzip/bim-editor/contracts/bim/part-geometry";

/**
 * Part editor tools for agents. Building a part is whole-definition editing:
 * fetch an example, write the definition, check it here until it is clean
 * (issues, sizes, connector frames, plan / front / side previews), then save it
 * with bim_save_part_definition (approval-gated, in parts.ts). Neither
 * tool here reads or changes a model.
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;
const ft = (mm: number) => Math.round((mm / MM_PER_FT) * 1000) / 1000;
const inch = (mm: number) => Math.round((mm / MM_PER_IN) * 100) / 100;

export { connectorPlacementWarnings };

interface ToolText {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const json = (value: unknown): ToolText => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (message: string): ToolText => ({ content: [{ type: "text", text: message }], isError: true });

const EXAMPLES: Readonly<Record<string, () => PartTypeDefinition>> = {
  rooftop_unit: exampleRooftopUnit,
  floor_drain: exampleFloorDrain,
};

const FIELD_GUIDE = [
  "Lengths are millimetres in the part's own frame: x along the part's facing (front is +x), y to its left, z up from the insertion point. Angles are degrees.",
  "A dimension is a number, {param, scale?, add?} or {formula} (e.g. \"length / 4\", \"curb_height + 2in\"). Formula functions: if, min, max, abs, sqrt, round, floor, ceil, sin, cos, tan.",
  "Parameters: kind number | length | angle | text | boolean | choice | material; a parameter with a formula is computed and can't be set.",
  "model.referencePlanes: {id, name, axis x|y|z, offset}. Built in: center_lr (x=0), center_fb (y=0), base (z=0).",
  "Sketch on a plane: base-plane sketches use u=x, v=y; planes square to x use u=y, v=z (normal +x); planes square to y use u=x, v=z (normal -y).",
  "Sketch entities: line, arc (center,start,end counter-clockwise), circle (center, radius dimension), polyline, rectangle (4 corners). Constraints: coincident, horizontal, vertical, parallel, perpendicular, equal_length, equal_radius, distance, length, radius, angle, on_plane (point on a reference plane), fix.",
  "Features in order: extrude (start/end along the sketch normal) or revolve (about a sketch line, start/end angle); operation join (solid), cut (void) or intersect. The first must join.",
  "Connectors: domain duct | pipe | electrical, systemKind, position, outward direction, shape rect | round | none, sizes, flow, flowDirection in | out | bidirectional, widthAxis for rectangles.",
  "model.types is the types table (one row per size); model.planDisplay is model | symbol | both.",
  "clearances (optional): [{id, name, purpose service_access|combustible|economizer_access|working_space|keep_out, face front|back|left|right|top|bottom, depth, width?, height?, offset?, fromFloor?}] in mm; never solid, drawn dashed. For NEC 110.26 working space use bim_set_clearances working_space.",
];

/**
 * What check and save advertise for `definition`. The full schema is about
 * 8,000 tokens per tool, re-sent on every agent step; the example tool and
 * FIELD_GUIDE carry the same shape on demand, and the handlers still parse
 * with `partDefinitionFieldsSchema` and answer every misfit field by path.
 */
export const ADVERTISED_PART_DEFINITION = z
  .record(z.string(), z.unknown())
  .describe(
    "The part definition object: parameters, connectors, symbol, tag fields, source and model (reference planes, sketches, features, types table). Lengths in MILLIMETRES (formulas accept 12in or 2ft). Its exact fields are in bim_part_definition_example (a complete definition plus a field guide) and bim_read_part_definition (a saved part in this form); a field that doesn't fit is answered with its path and what is wrong.",
  );
export function registerBimPartEditorTools(server: McpServer): void {
  server.registerTool(
    "bim_part_definition_example",
    {
      title: "Part definition example",
      description:
        "A complete, valid part definition to start from (rooftop_unit: box on a hollow curb with a cut-in panel, two duct and one power connector, three sizes; floor_drain: revolved body and outlet with a strainer symbol), plus a short guide to every field. Use it as the template for bim_check_part_definition and bim_save_part_definition.",
      inputSchema: { example: z.enum(["rooftop_unit", "floor_drain"]) },
    },
    async (args) => {
      const def = EXAMPLES[args.example]?.();
      if (!def) return failure(`No example ${args.example}`);
      const { part_name, definition } = splitName(def);
      return json({ part_name, definition, guide: FIELD_GUIDE });
    },
  );

  server.registerTool(
    "bim_check_part_definition",
    {
      title: "Check a part definition",
      description:
        "Dry run of a part definition: every problem in plain words (formulas, sketches that don't close or can't be solved, features without depth, connectors, each size in the types table), then for each size its type id, overall size, connector positions and sizes (warnings for one below the base, inside the body or facing into it), and plan / front / side previews as SVG. Saves nothing. Fix and re-check until status is ok, then save with bim_save_part_definition.",
      inputSchema: {
        part_name: z.string().trim().min(1).max(200),
        definition: ADVERTISED_PART_DEFINITION,
        preview_type: z.string().max(200).optional().describe("Which size to draw previews for (default: the first)."),
        previews: z.boolean().optional().describe("Include SVG previews (default true)."),
      },
    },
    async (args) => {
      const fields = partDefinitionFieldsSchema.safeParse(args.definition);
      if (!fields.success) {
        return json({
          status: "has_issues",
          issues: fields.error.issues.map((i) => `definition.${i.path.join(".")}: ${i.message}`),
          next: "Fix these fields (bim_part_definition_example shows every field) and check again.",
        });
      }
      try {
        const def = partDefinition(args.part_name, fields.data);
        const issues = partTypeIssues(def);
        if (issues.length > 0) return json({ status: "has_issues", issues: issues.map((i) => `${i.field}: ${i.message}`), next: "Fix these and check again." });
        await initPartGeometry();
        const types = definitionTypes(def);
        const notes = def.model ? resolvePartModel(def.model, (d) => resolveDim(def, {}, d)).notes : [];
        const drawProblems: string[] = [];
        const warnings: string[] = [];
        const summary = types.map(({ typeId, definition }) => {
          const prims = resolveGeometry(definition);
          const b = localBounds(prims);
          const drawn = definition.model ? sizeMesh(definition) : { triangles: 0, problem: null };
          if (drawn.problem) drawProblems.push(`${definition.typeName}: ${drawn.problem}`);
          warnings.push(...connectorPlacementWarnings(definition.typeName, b, resolveConnectors(definition), prims.map((p) => localBounds([p]))));
          return {
            type_id: typeId,
            size: definition.typeName,
            overall_ft: { length: ft(b.max[0] - b.min[0]), width: ft(b.max[1] - b.min[1]), height: ft(b.max[2] - b.min[2]) },
            triangles: drawn.triangles,
            ...(drawn.problem ? { draws_nothing: drawn.problem } : {}),
            connectors: resolveConnectors(definition).map((c) => ({
              id: c.id,
              label: c.label,
              domain: c.domain,
              system: c.systemKind,
              position_ft: c.position.map(ft),
              direction: c.direction,
              ...(c.width !== undefined && c.height !== undefined ? { size_in: `${inch(c.width)} x ${inch(c.height)}` } : {}),
              ...(c.diameter !== undefined ? { size_in: `${inch(c.diameter)} round` } : {}),
              ...(c.flow !== undefined ? { flow: c.flow } : {}),
              ...(c.voltage !== undefined ? { voltage: c.voltage, poles: c.poles } : {}),
            })),
            ...(definition.clearances?.length
              ? {
                  clearances: resolveClearances(definition.clearances, undefined, b, (d) => resolveDim(definition, {}, d)).map((z) => ({
                    id: z.id,
                    name: z.name,
                    face: z.face,
                    depth_ft: ft(z.face === "front" || z.face === "back" ? z.max[0] - z.min[0] : z.face === "left" || z.face === "right" ? z.max[1] - z.min[1] : z.max[2] - z.min[2]),
                  })),
                }
              : {}),
          };
        });
        const pick = types.find((t) => t.definition.typeName === args.preview_type) ?? types[0];
        const previews =
          args.previews === false || !pick?.definition.model ? undefined : Object.fromEntries(PART_VIEWS.map((view) => [view, partViewSvg(partViewLinework(pick.definition, view))]));
        if (def.model?.planDisplay === "symbol" && def.symbol.length === 0) drawProblems.push("Plan display is symbol, but the part has no symbol lines, so plans show nothing. Add symbol lines or set planDisplay to model or both.");
        if (drawProblems.length > 0) {
          return json({ status: "has_issues", issues: drawProblems, ...(warnings.length ? { warnings } : {}), types: summary, next: "A size that draws nothing is left out of every view and print. Fix these and check again." });
        }
        return json({ status: "ok", part_name: partGroupName(def), notes, ...(warnings.length ? { warnings } : {}), types: summary, ...(previews ? { previews_for: pick?.definition.typeName, previews } : {}), next: "Save with bim_save_part_definition (same part_name and definition)." });
      } catch (err) {
        console.error("[mcp:bim_check_part_definition] failed", err);
        return failure(`The part couldn't be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

/** One size's solid: its triangle count, or why it draws nothing (a size whose body fails is dropped from every view). */
function sizeMesh(definition: PartTypeDefinition): { triangles: number; problem: string | null } {
  try {
    const triangles = partMesh(definition).triangleCount;
    return { triangles, problem: triangles > 0 ? null : "its body has no solid (0 triangles)" };
  } catch (err) {
    console.error("[mcp:bim_check_part_definition] a size's body failed to build", { size: definition.typeName, err });
    return { triangles: 0, problem: `its body can't be built: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function splitName(def: PartTypeDefinition): { part_name: string; definition: z.infer<typeof partDefinitionFieldsSchema> } {
  const parsed = partDefinitionFieldsSchema.parse(def);
  return { part_name: partGroupName(def), definition: parsed };
}
