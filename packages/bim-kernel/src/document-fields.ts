import { canonicalJson } from "./canonical";
import type { ViewProps } from "./documents";
import type { BimElement } from "./types";
import type { AuthoredValue } from "./command-core";
import { noteFieldValue } from "./annotation/text-note-commands";

/** Field names for conflict detection, kept apart from the network's (`text`, `offset`, …). */
export const DOCUMENT_FIELDS = {
  name: "doc.name",
  title: "doc.title",
  number: "doc.number",
  crop: "doc.crop",
  center: "doc.center",
  size: "doc.size",
  scale: "doc.scale",
  northArrow: "doc.northArrow",
  points: "doc.points",
  text: "doc.text",
  dim: "doc.dim",
  tag: "doc.tag",
  callout: "doc.callout",
  figure: "doc.figure",
  detail: "doc.detail",
  deleted: "doc.deleted",
  titleBlock: "doc.titleBlock",
  titleBlockRow: "doc.titleBlockRow",
  revisions: "doc.revisions",
  prop: (key: string) => `doc.props.${key}`,
  field: (key: string) => `doc.fields.${key}`,
} as const;

export function propValue(props: ViewProps | undefined, key: string): unknown {
  return Object.entries(props ?? {}).find(([k]) => k === key)?.[1] ?? null;
}

/** Value of a document field named by `DOCUMENT_FIELDS`, for the commit's competing-edit check. */
export function documentFieldValue(el: BimElement, field: string): AuthoredValue | undefined {
  if (!field.startsWith("doc.")) return undefined;
  const key = field.slice(4);
  if (key === "deleted") return "deleted" in el && el.deleted ? "true" : "false";
  switch (el.kind) {
    case "view":
      if (key === "name") return el.name;
      if (key === "crop") return canonicalJson({ min: el.cropMin, max: el.cropMax });
      if (key.startsWith("props.")) return canonicalJson(propValue(el.props, key.slice(6)));
      return undefined;
    case "sheet":
      if (key === "number") return el.number;
      if (key === "title") return el.title;
      if (key === "titleBlock") return el.props?.titleBlock ?? "";
      if (key === "titleBlockRow") return el.props?.titleBlockRow ? `${el.props.titleBlockRow.id}@${el.props.titleBlockRow.revision}` : "";
      if (key === "revisions") return canonicalJson(el.props?.revisions ?? []);
      if (key.startsWith("fields.")) return el.props?.fields?.[key.slice(7)] ?? "";
      return undefined;
    case "viewport":
      if (key === "center") return el.center;
      if (key === "size") return el.size;
      if (key === "scale") return el.scale;
      if (key === "northArrow") return el.northArrow === undefined ? "default" : String(el.northArrow);
      return undefined;
    case "drawing_item":
      if (key === "points") return canonicalJson(el.points);
      if (key === "text") return el.text ?? "";
      if (key === "dim") return canonicalJson(el.dim ?? null);
      if (key === "tag") return canonicalJson(el.tag ?? null);
      if (key === "callout") return canonicalJson(el.callout ?? null);
      if (key === "figure") return canonicalJson(el.figure ?? null);
      if (key === "block") return canonicalJson(el.block ?? null);
      if (key === "detail") return canonicalJson({ lineStyle: el.lineStyle ?? null, closed: el.closed ?? null, ccw: el.ccw ?? null, fill: el.fill ?? null, component: el.component ?? null, batt: el.batt ?? null, category: el.category ?? null, detailGroup: el.detailGroup ?? null, ...(el.pinned ? { pinned: true } : {}) });
      return noteFieldValue(el, field);
    default:
      return undefined;
  }
}
