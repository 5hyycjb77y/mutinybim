/**
 * @jest-environment node
 *
 * Views and sheets commands: each one validated against the head, attributed
 * through planCommit, conflicting instead of last-write-wins, and undoable
 * only when nobody changed the element since.
 */
import {
  applyChangeset,
  canonicalJson,
  commandSchema,
  documentIndex,
  executeCommand,
  isKind,
  planCommit,
  toDocumentRecord,
  type BimElement,
  type Changeset,
  type CommandRequest,
  type ModelState,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

/** Commands are written as plain objects and parsed exactly as the server parses them. */
type RawCommand = { readonly type: string } & Record<string, unknown>;

const FT = 304.8;
const NOW = () => "2026-10-19T00:00:00.000Z";
const avery = { id: "avery", name: "Avery", kind: "human" as const };
const priya = { id: "priya", name: "Priya", kind: "human" as const };
let keySeq = 0;

function req(head: ModelState, command: RawCommand, actor = avery, baseRevision = head.revision): CommandRequest {
  keySeq += 1;
  return { idempotencyKey: `test-key-${keySeq}`, baseRevision, actor, command: commandSchema.parse(command) };
}

function commit(head: ModelState, command: RawCommand, actor = avery, since: readonly Changeset[] = [], baseRevision = head.revision): { model: ModelState; changeset: Changeset } {
  const d = planCommit(head, since, req(head, command, actor, baseRevision), NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return { model: d.model, changeset: d.changeset };
}

function refusal(head: ModelState, command: RawCommand): string {
  const r = executeCommand(head, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return r.error.message;
}

function el<K extends BimElement["kind"]>(model: ModelState, id: string, kind: K): Extract<BimElement, { kind: K }> {
  const found = model.elements[id];
  if (!found || !isKind(found, kind)) throw new Error(`${id} is not a ${kind}`);
  return found;
}

/** Demo model plus a level-1 plan and sheet M-101. */
function withPlanAndSheet(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", scale: 48 } }).model;
  m = commit(m, { type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Mechanical plan - level 1", fields: { drawn_by: "KG" } }).model;
  return m;
}

describe("create_view", () => {
  test("plan for a level gets its level, default cut, crop around the level and a documents partition", () => {
    const m = withPlanAndSheet();
    const v = el(m, "v-plan", "view");
    expect(v.viewType).toBe("floor_plan");
    expect(v.props).toMatchObject({ level: "L1", scale: 48, cutHeightMm: 1219.2 });
    expect(v.cropMax.x).toBeGreaterThan(v.cropMin.x);
    expect(v.partition).toEqual({ level: "L1", zone: "documents", discipline: "mechanical" });
  });

  test("section from a cut line crops along the line; refuses a missing or too-short cut", () => {
    let m = createDemoModel();
    m = commit(m, {
      type: "create_view",
      viewId: "v-sec",
      name: "Section A",
      viewType: "section",
      props: { level: "L1", section: { start: { x: 0, y: 4 * FT }, end: { x: 40 * FT, y: 4 * FT }, direction: 1, depthMm: 10 * FT } },
    }).model;
    const sec = el(m, "v-sec", "view");
    expect(sec.cropMin.x).toBe(0);
    expect(sec.cropMax.x).toBeCloseTo(40 * FT, 3);
    expect(refusal(m, { type: "create_view", viewId: "v-sec2", name: "Section B", viewType: "section" })).toMatch(/cut line/);
    expect(
      refusal(m, { type: "create_view", viewId: "v-sec3", name: "Section C", viewType: "section", props: { section: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, direction: 1, depthMm: 1000 } } }),
    ).toMatch(/too short/);
  });

  test("plan without a level, duplicate name, and reused id are refused in plain words", () => {
    const m = withPlanAndSheet();
    expect(refusal(m, { type: "create_view", viewId: "v-x", name: "No level", viewType: "floor_plan" })).toMatch(/needs a level/);
    expect(refusal(m, { type: "create_view", viewId: "v-y", name: "level 1 mechanical", viewType: "three_d" })).toMatch(/already exists/);
    expect(refusal(m, { type: "create_view", viewId: "v-plan", name: "Another", viewType: "three_d" })).toMatch(/already used/);
  });

  test("3D and detail views need no level", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d" }).model;
    m = commit(m, { type: "create_view", viewId: "v-det", name: "Typical hanger", viewType: "detail" }).model;
    expect(el(m, "v-det", "view").props?.scale).toBe(8);
    expect(documentIndex(m).views.map((v) => v.id).sort()).toEqual(["v-3d", "v-det"]);
  });
});

describe("rename / duplicate / set_view_properties", () => {
  test("rename and duplicate (with detail linework copied under new ids)", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-det", name: "Hanger", viewType: "detail" }).model;
    m = commit(m, { type: "add_drawing_item", itemId: "d-1", ownerId: "v-det", shape: "line", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] }).model;
    m = commit(m, { type: "rename_view", viewId: "v-det", name: "Typical hanger" }).model;
    m = commit(m, { type: "duplicate_view", viewId: "v-det", newViewId: "v-det2" }).model;
    expect(el(m, "v-det2", "view").name).toBe("Typical hanger Copy");
    const copied = documentIndex(m).itemsByOwner.get("v-det2") ?? [];
    expect(copied).toHaveLength(1);
    expect(copied[0]?.id).toBe("v-det2~d-1");
  });

  test("a 3D view saves its projection (copies and undo records keep it); other views refuse it", () => {
    let m = createDemoModel();
    m = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d" }).model;
    expect(el(m, "v-3d", "view").props?.projection).toBeUndefined();
    const { model, changeset } = commit(m, { type: "set_view_properties", viewId: "v-3d", props: { projection: "orthographic" } });
    m = model;
    expect(el(m, "v-3d", "view").props?.projection).toBe("orthographic");
    expect(JSON.stringify(changeset)).toContain("doc.props.projection");
    m = commit(m, { type: "duplicate_view", viewId: "v-3d", newViewId: "v-3d-copy" }).model;
    expect(el(m, "v-3d-copy", "view").props?.projection).toBe("orthographic");
    const record = toDocumentRecord(el(m, "v-3d", "view"));
    expect(record?.kind === "view" ? record.props?.projection : null).toBe("orthographic");
    m = commit(m, { type: "set_view_properties", viewId: "v-3d", props: { projection: "perspective" } }).model;
    expect(el(m, "v-3d", "view").props?.projection).toBe("perspective");
    m = commit(m, { type: "create_view", viewId: "v-plan", name: "Plan", viewType: "floor_plan", props: { level: "L1" } }).model;
    expect(refusal(m, { type: "set_view_properties", viewId: "v-plan", props: { projection: "perspective" } })).toMatch(/Only 3D views/);
    expect(() => commandSchema.parse({ type: "set_view_properties", viewId: "v-3d", props: { projection: "fisheye" } })).toThrow();
  });

  test("properties: scale, cut height, discipline, hidden categories, linked-model display, detail level, crop", () => {
    let m = withPlanAndSheet();
    m = commit(m, {
      type: "set_view_properties",
      viewId: "v-plan",
      props: { scale: 96, cutHeightMm: 1500, discipline: "mechanical", hiddenCategories: ["rooms"], references: { arch: { visible: true, halftone: true } }, detailLevel: "fine" },
      crop: { min: { x: 0, y: 0 }, max: { x: 30 * FT, y: 20 * FT } },
    }).model;
    const v = el(m, "v-plan", "view");
    expect(v.props).toMatchObject({ scale: 96, cutHeightMm: 1500, discipline: "mechanical", hiddenCategories: ["rooms"], detailLevel: "fine" });
    expect(v.cropMax).toEqual({ x: 30 * FT, y: 20 * FT });
    m = commit(m, { type: "set_view_properties", viewId: "v-plan", props: { discipline: null } }).model;
    expect(el(m, "v-plan", "view").props?.discipline).toBeUndefined();
  });

  test("two people setting the same property conflict instead of the last one winning", () => {
    const head = withPlanAndSheet();
    const mine = commit(head, { type: "set_view_properties", viewId: "v-plan", props: { scale: 96 } }, avery);
    const d = planCommit(mine.model, [mine.changeset], req(mine.model, { type: "set_view_properties", viewId: "v-plan", props: { scale: 24 } }, priya, head.revision), NOW);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.code).toBe("conflict");
  });
});

describe("sheets and viewports", () => {
  test("create_sheet refuses a duplicate number; set_sheet_properties edits title block fields", () => {
    let m = withPlanAndSheet();
    expect(refusal(m, { type: "create_sheet", sheetId: "s-2", number: "m-101", name: "Dup" })).toMatch(/M-101 already exists/);
    m = commit(m, { type: "set_sheet_properties", sheetId: "s-m101", name: "Mechanical plan", fields: { checked_by: "CA", drawn_by: "" } }).model;
    const s = el(m, "s-m101", "sheet");
    expect(s.title).toBe("Mechanical plan");
    expect(s.props?.fields).toEqual({ checked_by: "CA" });
  });

  test("place a viewport at the view's scale; it sizes to the crop; move, resize and rescale it", () => {
    let m = withPlanAndSheet();
    const v = el(m, "v-plan", "view");
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    let vp = el(m, "vp-1", "viewport");
    expect(vp.scale).toBe(48);
    expect(vp.size.x).toBeCloseTo((v.cropMax.x - v.cropMin.x) / 48, 2);
    expect(el(m, "s-m101", "sheet").viewIds).toEqual(["v-plan"]);
    m = commit(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 320, y: 260 } }).model;
    m = commit(m, { type: "resize_viewport", viewportId: "vp-1", size: { x: 200, y: 150 } }).model;
    m = commit(m, { type: "set_viewport_scale", viewportId: "vp-1", scale: 96 }).model;
    vp = el(m, "vp-1", "viewport");
    expect(vp.center).toEqual({ x: 320, y: 260 });
    expect(vp.size).toEqual({ x: 100, y: 75 });
    expect(refusal(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 5000, y: 10 } })).toMatch(/off sheet M-101/);
  });

  test("a view goes on one sheet only", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "create_sheet", sheetId: "s-m102", number: "M-102", name: "Second" }).model;
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    expect(refusal(m, { type: "place_viewport", viewportId: "vp-2", sheetId: "s-m102", viewId: "v-plan", center: { x: 300, y: 250 } })).toMatch(/already on sheet M-101/);
  });

  test("remove_viewport takes the view off the sheet and lets it be placed again", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    m = commit(m, { type: "remove_viewport", viewportId: "vp-1" }).model;
    expect(el(m, "s-m101", "sheet").viewIds).toEqual([]);
    m = commit(m, { type: "place_viewport", viewportId: "vp-2", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    expect(documentIndex(m).viewportByView.get("v-plan")?.id).toBe("vp-2");
  });
});

describe("delete_view dependency policy", () => {
  test("a placed view is refused by default, naming the sheet; remove_from_sheet removes both", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    const r = executeCommand(m, commandSchema.parse({ type: "delete_view", viewId: "v-plan" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("in_use");
      expect(r.error.message).toMatch(/placed on sheet M-101/);
    }
    m = commit(m, { type: "delete_view", viewId: "v-plan", placed: "remove_from_sheet" }).model;
    expect(el(m, "v-plan", "view").deleted).toBe(true);
    expect(el(m, "vp-1", "viewport").deleted).toBe(true);
    expect(el(m, "s-m101", "sheet").viewIds).toEqual([]);
    expect(documentIndex(m).views).toHaveLength(0);
  });

  test("delete_sheet removes its viewports and notes, freeing the views", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    m = commit(m, { type: "add_drawing_item", itemId: "n-1", ownerId: "s-m101", shape: "text", points: [{ x: 40, y: 500 }], text: "SEE NOTE 3" }).model;
    m = commit(m, { type: "delete_sheet", sheetId: "s-m101" }).model;
    expect(documentIndex(m).viewportByView.size).toBe(0);
    expect(documentIndex(m).itemsByOwner.get("s-m101")).toBeUndefined();
    expect(refusal(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 1, y: 1 } })).toMatch(/no longer exists/);
  });
});

describe("drawing items", () => {
  test("sheet notes, lines, rectangles and clouds; detail linework, text and dimensions", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "create_view", viewId: "v-det", name: "Hanger", viewType: "detail" }).model;
    for (const [i, shape] of (["line", "rect", "cloud"] as const).entries()) {
      m = commit(m, { type: "add_drawing_item", itemId: `s-${i}`, ownerId: "s-m101", shape, points: [{ x: 50, y: 50 }, { x: 90, y: 80 }] }).model;
    }
    m = commit(m, { type: "add_drawing_item", itemId: "s-note", ownerId: "s-m101", shape: "text", points: [{ x: 50, y: 100 }], text: "VERIFY IN FIELD" }).model;
    m = commit(m, { type: "add_drawing_item", itemId: "d-dim", ownerId: "v-det", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 2 * FT, y: 0 }] }).model;
    expect(documentIndex(m).itemsByOwner.get("s-m101")).toHaveLength(4);
    // Plans carry their own annotation (drafting suite); 3D views still don't.
    m = commit(m, { type: "add_drawing_item", itemId: "p-line", ownerId: "v-plan", shape: "line", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }).model;
    expect(documentIndex(m).itemsByOwner.get("v-plan")).toHaveLength(1);
    m = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d" }).model;
    expect(refusal(m, { type: "add_drawing_item", itemId: "bad", ownerId: "v-3d", shape: "line", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })).toMatch(/a sheet, a detail view, a plan or a section/);
    expect(refusal(m, { type: "add_drawing_item", itemId: "bad2", ownerId: "s-m101", shape: "text", points: [{ x: 0, y: 0 }] })).toMatch(/needs text/);
    m = commit(m, { type: "update_drawing_item", itemId: "s-note", text: "VERIFY ALL DIMENSIONS IN FIELD" }).model;
    m = commit(m, { type: "delete_drawing_item", itemId: "s-0" }).model;
    expect(documentIndex(m).itemsByOwner.get("s-m101")).toHaveLength(3);
  });
});

describe("collaborative undo (restore_document_elements)", () => {
  function before(model: ModelState, id: string): unknown {
    const found = model.elements[id];
    return found ? (JSON.parse(canonicalJson(found)) as unknown) : null;
  }

  test("undo a move restores the earlier position when nobody changed it since", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    const prior = before(m, "vp-1");
    m = commit(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 400, y: 260 } }).model;
    const after = el(m, "vp-1", "viewport");
    m = commit(m, { type: "restore_document_elements", items: [{ elementId: "vp-1", before: prior, expectedVersion: after.version }] }).model;
    expect(el(m, "vp-1", "viewport").center).toEqual({ x: 300, y: 250 });
  });

  test("undo refuses when someone else changed the element since", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    const prior = before(m, "vp-1");
    m = commit(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 400, y: 260 } }, avery).model;
    const mineVersion = el(m, "vp-1", "viewport").version;
    m = commit(m, { type: "move_viewport", viewportId: "vp-1", center: { x: 410, y: 270 } }, priya).model;
    const r = executeCommand(m, commandSchema.parse({ type: "restore_document_elements", items: [{ elementId: "vp-1", before: prior, expectedVersion: mineVersion }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("conflict");
      expect(r.error.message).toMatch(/changed since your edit; undoing would overwrite that work/);
    }
  });

  test("undo a create removes it; undo a delete brings the view back with its viewport", () => {
    let m = withPlanAndSheet();
    m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } }).model;
    const ids = ["v-plan", "vp-1", "s-m101"];
    const priors = Object.fromEntries(ids.map((id) => [id, before(m, id)]));
    m = commit(m, { type: "delete_view", viewId: "v-plan", placed: "remove_from_sheet" }).model;
    m = commit(m, {
      type: "restore_document_elements",
      items: ids.map((id) => ({ elementId: id, before: priors[id], expectedVersion: m.elements[id]?.version ?? 0 })),
    }).model;
    expect(el(m, "v-plan", "view").deleted).toBeUndefined();
    expect(documentIndex(m).viewportByView.get("v-plan")?.id).toBe("vp-1");
    expect(el(m, "s-m101", "sheet").viewIds).toEqual(["v-plan"]);

    const created = commit(m, { type: "create_view", viewId: "v-3d", name: "3D", viewType: "three_d" }).model;
    const undone = commit(created, { type: "restore_document_elements", items: [{ elementId: "v-3d", before: null, expectedVersion: created.elements["v-3d"]?.version ?? 0 }] }).model;
    expect(el(undone, "v-3d", "view").deleted).toBe(true);
  });

  test("undo never touches network elements", () => {
    const m = createDemoModel();
    const seg = Object.values(m.elements).find((e) => e.kind === "duct_segment");
    if (!seg) throw new Error("no segment in demo");
    expect(() => commandSchema.parse({ type: "restore_document_elements", items: [{ elementId: seg.id, before: JSON.parse(canonicalJson(seg)) as unknown, expectedVersion: seg.version }] })).toThrow();
  });
});

describe("sync", () => {
  test("a committed view change applies on another client and creates no network work", () => {
    const head = withPlanAndSheet();
    const { model, changeset } = commit(head, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-m101", viewId: "v-plan", center: { x: 300, y: 250 } });
    const other = applyChangeset(head, changeset);
    expect(canonicalJson(other.elements)).toBe(canonicalJson(model.elements));
    expect(changeset.elements.map((e) => e.kind).sort()).toEqual(["sheet", "viewport"]);
  });
});
