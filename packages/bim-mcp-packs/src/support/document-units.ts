/**
 * Views and sheets commands as agents write them, in the same names and units
 * as the standalone tools (`bim_set_view_properties`, `bim_create_view`,
 * `bim_place_viewport`), turned into the kernel's millimetre fields before the
 * command is checked. A field written in feet is converted, never read as
 * millimetres; anything else the command doesn't take is refused by name by
 * the kernel's strict schema.
 */

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function point(value: unknown, mmPer: number, name: string): { x: number; y: number } | string {
  if (isRecord(value) && typeof value.x === "number" && typeof value.y === "number") return { x: value.x * mmPer, y: value.y * mmPer };
  return `${name} takes { x, y } numbers`;
}

function length(value: unknown, mmPer: number, name: string): number | null | string {
  if (value === null) return null;
  if (typeof value === "number") return value * mmPer;
  return `${name} takes a number`;
}

/** Plan view settings a standalone tool takes at the top level; the kernel keeps them under `props`. */
const VIEW_PROP_LENGTHS: Readonly<Record<string, string>> = { cut_height_ft: "cutHeightMm", top_ft: "viewTopMm", bottom_ft: "viewBottomMm", view_depth_ft: "viewDepthMm" };
const VIEW_PROP_PLAIN = ["level", "scale"] as const;
const TAKES_TOP_LEVEL_PROPS: ReadonlySet<string> = new Set(["create_view", "set_view_properties"]);

/** One command (not a batch): feet and inches converted, top-level view settings moved into props. A string is why not. */
function oneCommand(input: Json): Json | string {
  const out: Json = { ...input };
  const type = typeof input.type === "string" ? input.type : "command";
  const take = (key: string): unknown => {
    const v = out[key];
    delete out[key];
    return v;
  };
  const both = (a: string, b: string, kernel: string) => {
    if (out[a] !== undefined && out[b] !== undefined) return `${type}: send ${a} or ${b}, not both (${kernel})`;
    return null;
  };

  if ("crop_min_ft" in out || "crop_max_ft" in out) {
    if (out.crop_min_ft === undefined || out.crop_max_ft === undefined) return `${type}: give both crop_min_ft and crop_max_ft, the crop box's opposite corners in feet`;
    if (out.crop !== undefined) return `${type}: send crop (millimetres) or crop_min_ft / crop_max_ft (feet), not both`;
    const min = point(take("crop_min_ft"), MM_PER_FT, "crop_min_ft");
    const max = point(take("crop_max_ft"), MM_PER_FT, "crop_max_ft");
    if (typeof min === "string") return `${type}: ${min}`;
    if (typeof max === "string") return `${type}: ${max}`;
    out.crop = { min, max };
  }
  for (const [from, to, mmPer] of [
    ["center_in", "center", MM_PER_IN],
    ["size_in", "size", MM_PER_IN],
  ] as const) {
    if (!(from in out)) continue;
    const clash = both(from, to, `${to} is paper millimetres`);
    if (clash) return clash;
    const p = point(take(from), mmPer, from);
    if (typeof p === "string") return `${type}: ${p}`;
    out[to] = p;
  }
  for (const [from, to, mmPer] of [
    ["far_clip_ft", "farClipMm", MM_PER_FT],
    ["annotation_crop_offset_in", "annotationCropOffsetMm", MM_PER_IN],
  ] as const) {
    if (!(from in out)) continue;
    const clash = both(from, to, `${to} is millimetres`);
    if (clash) return clash;
    const v = length(take(from), mmPer, from);
    if (typeof v === "string") return `${type}: ${v}`;
    out[to] = v;
  }
  if ("fit_crop" in out) out.fit = take("fit_crop");
  if ("keep_viewport_center" in out) out.keepViewportCenter = take("keep_viewport_center");

  if (TAKES_TOP_LEVEL_PROPS.has(type)) {
    const props: Json = isRecord(out.props) ? { ...out.props } : {};
    let moved = false;
    for (const key of VIEW_PROP_PLAIN) {
      if (!(key in out)) continue;
      if (props[key] !== undefined && props[key] !== out[key]) return `${type}: ${key} is given twice (top level and props.${key}) with different values`;
      props[key] = take(key);
      moved = true;
    }
    for (const [from, to] of Object.entries(VIEW_PROP_LENGTHS)) {
      if (!(from in out)) continue;
      if (props[to] !== undefined) return `${type}: send ${from} (feet) or props.${to} (millimetres), not both`;
      const v = length(take(from), MM_PER_FT, from);
      if (typeof v === "string") return `${type}: ${v}`;
      props[to] = v;
      moved = true;
    }
    if (moved) out.props = props;
  }
  return out;
}

export type AgentDocumentInput = { readonly ok: true; readonly command: unknown } | { readonly ok: false; readonly message: string };

/** A views/sheets command or a batch of them, in agent units, as the kernel takes it (still to be checked), or why it can't be. */
export function documentCommandFromAgent(input: unknown): AgentDocumentInput {
  if (!isRecord(input)) return { ok: true, command: input };
  if (input.type === "batch_documents" && Array.isArray(input.commands)) {
    const commands: unknown[] = [];
    for (const [i, step] of input.commands.entries()) {
      if (!isRecord(step)) {
        commands.push(step);
        continue;
      }
      const converted = oneCommand(step);
      if (typeof converted === "string") return { ok: false, message: `Step ${i + 1}: ${converted}` };
      commands.push(converted);
    }
    return { ok: true, command: { ...input, commands } };
  }
  const converted = oneCommand(input);
  return typeof converted === "string" ? { ok: false, message: converted } : { ok: true, command: converted };
}
