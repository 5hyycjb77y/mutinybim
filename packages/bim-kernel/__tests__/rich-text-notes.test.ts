/**
 * @jest-environment node
 *
 * Rich text notes: the commands (create, edit with an expected version,
 * resize, move, delete), their limits and refusals, undo that refuses to
 * overwrite someone else's edit, and the layout engine that the screen and
 * the PDF both draw from (wrapping, lists, bold widths, alignment, speed).
 */
import {
  NOTE_FONT_FACES,
  NOTE_LIST_INDENT_EM,
  advance,
  buildSheetSceneFor,
  buildViewScene,
  canonicalJson,
  commandSchema,
  documentIndex,
  draftContentFingerprint,
  emForCapHeight,
  executeCommand,
  isKind,
  layoutNote,
  listMarkers,
  noteContentFingerprint,
  noteText,
  planCommit,
  sceneToSvg,
  textWidth,
  type BimElement,
  type CommandRequest,
  type DrawingItem,
  type ModelState,
  type NoteParagraph,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

type RawCommand = { readonly type: string } & Record<string, unknown>;

const NOW = () => "2026-10-19T00:00:00.000Z";
const avery = { id: "avery", name: "Avery", kind: "human" as const };
const casey = { id: "casey", name: "Casey", kind: "human" as const };
let keySeq = 0;

function req(head: ModelState, command: RawCommand, actor = avery): CommandRequest {
  keySeq += 1;
  return { idempotencyKey: `note-key-${keySeq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) };
}

function commit(head: ModelState, command: RawCommand, actor = avery): ModelState {
  const d = planCommit(head, [], req(head, command, actor), NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function refusal(head: ModelState, command: RawCommand): { code: string; message: string } {
  const r = executeCommand(head, commandSchema.parse(command));
  if (r.ok) throw new Error(`${command.type} was accepted`);
  return { code: r.error.code, message: r.error.message };
}

function note(model: ModelState, id: string): DrawingItem {
  const found: BimElement | undefined = model.elements[id];
  if (!found || !isKind(found, "drawing_item")) throw new Error(`${id} is not a drawing item`);
  return found;
}

const p = (text: string, extra: Partial<NoteParagraph> = {}): NoteParagraph => ({ runs: [{ text }], ...extra });

function withSheet(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Mechanical plan" });
  m = commit(m, { type: "create_view", viewId: "v-detail", name: "Typical hanger", viewType: "detail", props: { scale: 8 } });
  return m;
}

const GENERAL_NOTES = [
  { runs: [{ text: "GENERAL NOTES", bold: true, underline: true }] },
  { runs: [{ text: "Coordinate all ductwork with the structure before fabrication." }], list: { kind: "numbered", level: 0 } },
  { runs: [{ text: "Seal all " }, { text: "supply", bold: true }, { text: " joints to SMACNA class A." }], list: { kind: "numbered", level: 0 } },
];

describe("text note commands", () => {
  test("create stores structured paragraphs (no HTML), normalized, on the sheet in paper mm", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: [{ runs: [{ text: "SEAL " }, { text: "ALL", bold: false }, { text: " JOINTS", bold: true }] }] });
    const n = note(m, "n-1");
    expect(n.shape).toBe("text");
    expect(n.points).toEqual([{ x: 40, y: 50 }]);
    expect(n.note?.space).toBe("paper");
    expect(n.note?.box).toEqual({ width: 80, height: null, rotation: 0 });
    // Same-style runs merge; false flags drop.
    expect(n.note?.paragraphs).toEqual([{ runs: [{ text: "SEAL ALL" }, { text: " JOINTS", bold: true }] }]);
    expect(canonicalJson(n)).not.toMatch(/<\w+>/);
  });

  test("a detail view note is model space; other owners and empty or unprintable text are refused", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-d", ownerId: "v-detail", at: { x: 100, y: 200 }, width: 40, paragraphs: [p("1/2\" ROD")] });
    expect(note(m, "n-d").note?.space).toBe("model");
    expect(refusal(m, { type: "create_text_note", itemId: "n-x", ownerId: "s-m101", at: { x: 1, y: 1 }, width: 40, paragraphs: [p("   ")] }).message).toMatch(/needs some text/);
    expect(refusal(m, { type: "create_text_note", itemId: "n-x", ownerId: "s-m101", at: { x: 1, y: 1 }, width: 40, paragraphs: [p("DUCT ⌀12")] }).message).toMatch(/can't print "⌀"/);
    expect(refusal(m, { type: "create_text_note", itemId: "n-x", ownerId: "s-m101", at: { x: 5000, y: 1 }, width: 40, paragraphs: [p("A")] }).message).toMatch(/off the sheet/);
    expect(() => commandSchema.parse({ type: "create_text_note", itemId: "n-x", ownerId: "s-m101", at: { x: 1, y: 1 }, width: 2, paragraphs: [p("A")] })).toThrow();
    expect(() => commandSchema.parse({ type: "create_text_note", itemId: "n-x", ownerId: "s-m101", at: { x: 1, y: 1 }, width: 40, paragraphs: [{ runs: [{ text: "A", size: 99 }] }] })).toThrow();
  });

  test("edit replaces the whole content at once, attributed to the editor", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: [p("DRAFT")] });
    m = commit(m, { type: "edit_text_note", itemId: "n-1", expectedContent: noteContentFingerprint(note(m, "n-1")), paragraphs: GENERAL_NOTES }, casey);
    const n = note(m, "n-1");
    expect(noteText(n.note?.paragraphs ?? [])).toBe("GENERAL NOTES\nCoordinate all ductwork with the structure before fabrication.\nSeal all supply joints to SMACNA class A.");
    expect(n.authoredRev["doc.note"]).toBe(m.revision);
  });

  test("an edit started before someone else's saved edit is refused as a conflict, not last-write-wins", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: [p("DRAFT")] });
    const opened = noteContentFingerprint(note(m, "n-1"));
    m = commit(m, { type: "edit_text_note", itemId: "n-1", expectedContent: opened, paragraphs: [p("CASEY'S WORDS")] }, casey);
    const r = refusal(m, { type: "edit_text_note", itemId: "n-1", expectedContent: opened, paragraphs: [p("AVERY'S WORDS")] });
    expect(r.code).toBe("conflict");
    expect(r.message).toMatch(/while you were editing it/);
    expect(noteText(note(m, "n-1").note?.paragraphs ?? [])).toBe("CASEY'S WORDS");
  });

  test("your own back-to-back edits chain (each names what the last wrote), and someone else's resize meanwhile merges", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: [p("ONE")] });
    const first = note(m, "n-1");
    const sent: NoteParagraph[] = [{ runs: [{ text: "TWO", bold: false }] }];
    m = commit(m, { type: "edit_text_note", itemId: "n-1", expectedContent: noteContentFingerprint(first), paragraphs: sent });
    m = commit(m, { type: "resize_text_note", itemId: "n-1", width: 30 }, casey);
    m = commit(m, { type: "edit_text_note", itemId: "n-1", expectedContent: draftContentFingerprint(first, sent), paragraphs: [p("THREE")] });
    expect(noteText(note(m, "n-1").note?.paragraphs ?? [])).toBe("THREE");
    expect(note(m, "n-1").note?.box.width).toBe(30);
  });

  test("resize, move, rotate and leader keep the content; delete is a flag undo can reverse", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: GENERAL_NOTES });
    m = commit(m, { type: "resize_text_note", itemId: "n-1", width: 45, height: 30 });
    expect(note(m, "n-1").note?.box).toEqual({ width: 45, height: 30, rotation: 0 });
    m = commit(m, { type: "move_text_note", itemId: "n-1", at: { x: 60, y: 70 }, rotation: -270, leader: { x: 20, y: 20 } });
    const moved = note(m, "n-1");
    expect(moved.points).toEqual([{ x: 60, y: 70 }]);
    expect(moved.note?.box.rotation).toBe(90);
    expect(moved.note?.leader).toEqual({ to: { x: 20, y: 20 } });
    expect(moved.note?.paragraphs).toEqual(note(m, "n-1").note?.paragraphs);
    m = commit(m, { type: "move_text_note", itemId: "n-1", leader: null });
    expect(note(m, "n-1").note?.leader).toBeUndefined();
    m = commit(m, { type: "delete_text_note", itemId: "n-1" });
    expect(documentIndex(m).itemsByOwner.get("s-m101") ?? []).toHaveLength(0);
  });

  test("a one-line note from before rich notes upgrades on its first edit, keeping its printed position", () => {
    let m = withSheet();
    m = commit(m, { type: "add_drawing_item", itemId: "old", ownerId: "s-m101", shape: "text", points: [{ x: 30, y: 100 }], text: "VERIFY IN FIELD", textSize: 2.5 });
    const before = buildSheetSceneFor(m, "s-m101", { projectName: "t" }).textBlocks?.find((b) => b.itemId === "old");
    m = commit(m, { type: "edit_text_note", itemId: "old", expectedContent: noteContentFingerprint(note(m, "old")), paragraphs: [{ runs: [{ text: "VERIFY IN FIELD", bold: true }] }] });
    const upgraded = note(m, "old");
    expect(upgraded.text).toBeUndefined();
    expect(upgraded.note?.paragraphs[0]?.runs[0]?.bold).toBe(true);
    const after = buildSheetSceneFor(m, "s-m101", { projectName: "t" }).textBlocks?.find((b) => b.itemId === "old");
    expect(after?.origin.y).toBeCloseTo(before?.origin.y ?? NaN, 1);
    expect(after?.layout.lines[0]?.baseline).toBeCloseTo(before?.layout.lines[0]?.baseline ?? NaN, 6);
    expect(refusal(m, { type: "update_drawing_item", itemId: "old", text: "X" }).message).toMatch(/edit_text_note/);
  });

  test("undo of a note edit restores the earlier words, and refuses once someone else changed the note", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 80, paragraphs: [p("FIRST")] });
    const prior = JSON.parse(canonicalJson(note(m, "n-1"))) as unknown;
    m = commit(m, { type: "edit_text_note", itemId: "n-1", expectedContent: noteContentFingerprint(note(m, "n-1")), paragraphs: [p("SECOND")] });
    const mine = note(m, "n-1").version;
    const undone = commit(m, { type: "restore_document_elements", items: [{ elementId: "n-1", before: prior, expectedVersion: mine }] });
    expect(noteText(note(undone, "n-1").note?.paragraphs ?? [])).toBe("FIRST");
    m = commit(m, { type: "resize_text_note", itemId: "n-1", width: 50 }, casey);
    const r = refusal(m, { type: "restore_document_elements", items: [{ elementId: "n-1", before: prior, expectedVersion: mine }] });
    expect(r.code).toBe("conflict");
  });
});

describe("layout engine", () => {
  const SIZE = 2.5;
  const em = emForCapHeight(SIZE);

  test("measures with the font's own advances; bold is wider than regular", () => {
    const regular = NOTE_FONT_FACES.regular;
    const mIndex = 0x4d - 0x20; // "M" in the ASCII block that starts the table
    expect(advance("regular", "M", em)).toBeCloseTo((regular.widths[mIndex] ?? 0) / regular.unitsPerEm * em, 9);
    expect(textWidth("bold", "DUCTWORK", em)).toBeGreaterThan(textWidth("regular", "DUCTWORK", em));
  });

  test("wraps at spaces inside the box width and re-wraps narrower", () => {
    const text = "Coordinate all ductwork with the structure before fabrication begins.";
    const wide = layoutNote([p(text)], { width: 200, height: null, size: SIZE });
    const narrow = layoutNote([p(text)], { width: 40, height: null, size: SIZE });
    expect(wide.lines).toHaveLength(1);
    expect(narrow.lines.length).toBeGreaterThan(2);
    for (const line of narrow.lines) expect(line.right).toBeLessThanOrEqual(40 + 1e-6);
    // Every word survives, in order, with breaks only at spaces.
    expect(narrow.lines.map((l) => l.pieces.map((x) => x.text).join("").trimEnd()).join(" ")).toBe(text);
    expect(narrow.contentHeight).toBeGreaterThan(wide.contentHeight);
  });

  test("bold words take their bold width when wrapping", () => {
    const words = "SEAL SEAL SEAL SEAL SEAL SEAL";
    const width = textWidth("regular", words, em) + 0.01;
    expect(layoutNote([p(words)], { width, height: null, size: SIZE }).lines).toHaveLength(1);
    expect(layoutNote([{ runs: [{ text: words, bold: true }] }], { width, height: null, size: SIZE }).lines).toHaveLength(2);
  });

  test("a word wider than the box breaks between characters", () => {
    const l = layoutNote([p("SUPERCALIFRAGILISTIC")], { width: 10, height: null, size: SIZE });
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.map((x) => x.pieces.map((q) => q.text).join("")).join("")).toBe("SUPERCALIFRAGILISTIC");
  });

  test("lists: markers count per level, restart after body text, and indent the text", () => {
    const paragraphs: NoteParagraph[] = [
      p("one", { list: { kind: "numbered", level: 0 } }),
      p("two", { list: { kind: "numbered", level: 0 } }),
      p("sub", { list: { kind: "numbered", level: 1 } }),
      p("three", { list: { kind: "numbered", level: 0 } }),
      p("dot", { list: { kind: "bullet", level: 0 } }),
      p("body"),
      p("again", { list: { kind: "numbered", level: 0 } }),
      p("ten", { list: { kind: "numbered", level: 0, start: 10 } }),
    ];
    expect(listMarkers(paragraphs)).toEqual(["1.", "2.", "a.", "3.", "\u2022", null, "1.", "10."]);
    const l = layoutNote(paragraphs, { width: 80, height: null, size: SIZE });
    const first = l.lines[0];
    expect(first?.pieces[0]?.marker).toBe(true);
    expect(first?.left).toBeCloseTo(NOTE_LIST_INDENT_EM * em, 9);
    expect(l.lines[2]?.left).toBeCloseTo(2 * NOTE_LIST_INDENT_EM * em, 9);
    expect((first?.pieces[0]?.x ?? 0) + (first?.pieces[0]?.width ?? 0)).toBeLessThan(first?.left ?? 0);
    expect(l.lines[5]?.left).toBe(0);
  });

  test("center, right and justify place lines inside the box; the last justified line stays left", () => {
    const text = "aa bb cc dd ee ff gg hh ii jj kk ll mm nn";
    const width = 30;
    const right = layoutNote([p("short", { align: "right" })], { width, height: null, size: SIZE });
    expect(right.lines[0]?.right).toBeCloseTo(width, 6);
    const center = layoutNote([p("short", { align: "center" })], { width, height: null, size: SIZE });
    expect((center.lines[0]?.left ?? 0) + (center.lines[0]?.right ?? 0)).toBeCloseTo(width, 6);
    const justified = layoutNote([p(text, { align: "justify" })], { width, height: null, size: SIZE });
    const lines = justified.lines;
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) expect(line.right).toBeCloseTo(width, 6);
    expect(lines[lines.length - 1]?.right).toBeLessThan(width - 1);
  });

  test("underline spans the underlined run only; Shift+Enter breaks a line", () => {
    const l = layoutNote([{ runs: [{ text: "see " }, { text: "NOTE 4", underline: true }, { text: "\nnext line" }] }], { width: 100, height: null, size: SIZE });
    expect(l.lines).toHaveLength(2);
    const bar = l.lines[0]?.underlines[0];
    expect(bar?.x0).toBeCloseTo(textWidth("regular", "see ", em), 9);
    expect((bar?.x1 ?? 0) - (bar?.x0 ?? 0)).toBeCloseTo(textWidth("regular", "NOTE 4", em), 9);
  });

  test("a fixed-height box drops lines that don't fit and says it overflows", () => {
    const l = layoutNote(GENERAL_NOTES as NoteParagraph[], { width: 30, height: 8, size: SIZE });
    expect(l.overflow).toBe(true);
    expect(l.height).toBe(8);
    for (const line of l.lines) expect(line.top + line.height).toBeLessThanOrEqual(8 + 1e-3);
  });

  test("a 500-word note lays out in well under a frame (16 ms)", () => {
    const words = Array.from({ length: 500 }, (_, i) => ["duct", "SEAL", "coordinate", "fabrication", "1/2\"", "ALL"][i % 6]).join(" ");
    const paragraphs: NoteParagraph[] = [{ runs: [{ text: words.slice(0, 900) }, { text: words.slice(900, 1400), bold: true }, { text: words.slice(1400) }] }];
    layoutNote(paragraphs, { width: 90, height: null, size: SIZE });
    const runs = 20;
    const started = performance.now();
    for (let i = 0; i < runs; i++) layoutNote(paragraphs, { width: 90 - (i % 5), height: null, size: SIZE });
    const ms = (performance.now() - started) / runs;
    expect(ms).toBeLessThan(16);
  });
});

describe("notes in scenes", () => {
  test("sheet notes draw as laid-out text blocks, and the SVG places every glyph at the layout's x", () => {
    let m = withSheet();
    m = commit(m, { type: "create_text_note", itemId: "n-1", ownerId: "s-m101", at: { x: 40, y: 50 }, width: 45, paragraphs: GENERAL_NOTES, leader: { x: 20, y: 30 } });
    const scene = buildSheetSceneFor(m, "s-m101", { projectName: "t" });
    const block = scene.textBlocks?.find((b) => b.itemId === "n-1");
    expect(block?.origin).toEqual({ x: 40, y: 50 });
    expect(block?.layout.lines.length).toBeGreaterThan(3);
    const svg = sceneToSvg(scene);
    expect(svg).toContain('data-note-id="n-1"');
    // Spaces are no-break spaces so the browser keeps one glyph per x.
    expect(svg).toContain(">GENERAL\u00a0NOTES</text>");
    const firstText = /<text x="([^"]+)"[^>]*>([^<]*)<\/text>/.exec(svg.slice(svg.indexOf('data-note-id="n-1"')));
    expect(firstText?.[1]?.split(" ").length).toBe([...(firstText?.[2] ?? "")].length);
    expect(svg).toMatch(/font-kerning:none/);
    expect(sceneToSvg(scene, { hideNoteIds: new Set(["n-1"]) })).not.toContain('data-note-id="n-1"');
    // Leader: one shaft and two arrowhead strokes ending at the target.
    expect(scene.primitives.filter((q) => q.kind === "line" && q.b.x === 20 && q.b.y === 30)).toHaveLength(1);
  });

  test("a detail view note keeps its paper size at the view's scale and stays inside the crop", () => {
    let m = withSheet();
    m = commit(m, { type: "add_drawing_item", itemId: "l-1", ownerId: "v-detail", shape: "line", points: [{ x: 0, y: 0 }, { x: 2000, y: 1000 }] });
    m = commit(m, { type: "create_text_note", itemId: "n-d", ownerId: "v-detail", at: { x: 100, y: 900 }, width: 40, paragraphs: [p("1/2\" THREADED ROD AT 8'-0\" O.C. MAX")] });
    m = commit(m, { type: "set_view_crop", viewId: "v-detail", fit: true });
    const { scene } = buildViewScene(m, "v-detail");
    const block = scene.textBlocks?.find((b) => b.itemId === "n-d");
    expect(block?.layout.width).toBe(40);
  });
});
