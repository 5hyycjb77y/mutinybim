import { defineExtensionPoint } from "@permitzip/bim-kernel/packs";

/**
 * Render styles (reserved, contract 1.9.0, `viewer.render_style` v1): how the
 * 3D view draws a model (shaded, hidden line, material colours, a
 * presentation look), registered by an add-on as `<pack>.<name>`. The shape
 * is settled now so the contract can be published; nothing reads the point
 * yet. Its reader arrives with the rendering engine after release, in a
 * viewer chunk the page loads on demand: this file is never imported by the
 * Building Model page (`ui.first_chunk.kb` holds), and it is not re-exported
 * from the package entry.
 */

export interface RenderMaterialDef {
  /** Which elements take it: a category, class or material id the registry knows. */
  readonly match: { readonly category?: string; readonly classId?: string; readonly material?: string };
  /** sRGB hex, "#rrggbb". */
  readonly color: string;
  /** 0 (clear) to 1 (opaque). Absent: 1. */
  readonly opacity?: number;
  /** 0 (matte) to 1 (mirror). Absent: the style's default. */
  readonly roughness?: number;
  readonly metalness?: number;
}

export interface RenderStyleDef {
  /** `<pack>.<name>`. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** How surfaces draw. */
  readonly shading: "shaded" | "flat" | "hidden_line" | "wireframe" | (string & {});
  /** Edges drawn over surfaces, and their colour. */
  readonly edges?: { readonly color: string; readonly widthPx?: number };
  /** First match wins; elements no row matches keep the viewer's colours. */
  readonly materials?: readonly RenderMaterialDef[];
  readonly background?: string;
}

export const RENDER_STYLE_POINT = defineExtensionPoint<RenderStyleDef>({
  id: "viewer.render_style",
  version: 1,
  label: "Render styles",
  idOf: (s) => s.id,
});

const HEX = /^#[0-9a-f]{6}$/i;

/** Problems with render-style rows, in words (pack conformance). */
export function renderStyleRowProblems(items: readonly RenderStyleDef[]): string[] {
  const out: string[] = [];
  for (const s of items) {
    if (s.label.trim().length === 0) out.push(`render style ${s.id} has no label`);
    if (s.edges && !HEX.test(s.edges.color)) out.push(`render style ${s.id}: edge colour "${s.edges.color}" isn't #rrggbb`);
    if (s.background !== undefined && !HEX.test(s.background)) out.push(`render style ${s.id}: background "${s.background}" isn't #rrggbb`);
    for (const m of s.materials ?? []) {
      if (!HEX.test(m.color)) out.push(`render style ${s.id}: colour "${m.color}" isn't #rrggbb`);
      for (const [k, v] of [["opacity", m.opacity], ["roughness", m.roughness], ["metalness", m.metalness]] as const) if (v !== undefined && !(v >= 0 && v <= 1)) out.push(`render style ${s.id}: ${k} must be between 0 and 1`);
      if (m.match.category === undefined && m.match.classId === undefined && m.match.material === undefined) out.push(`render style ${s.id}: a material row matches nothing`);
    }
  }
  return out;
}
