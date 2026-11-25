import {
  asRevision,
  DEFAULT_SETTINGS,
  executeCommand,
  withUpgradePolicy,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  formatStandardNoteSet,
  listStandardNoteSets,
  STANDARD_NOTE_SETS,
} from "../src/standard-notes";
import { documents } from "../src/kit-documents";
import { searchReference } from "../src/reference";
import { measure } from "@permitzip/bim-units";

describe("standard general-notes & spec library", () => {
  it("lists discipline note sets and formats numbered blocks with exclusions and extras", () => {
    expect(STANDARD_NOTE_SETS.length).toBeGreaterThanOrEqual(7);
    const elec = listStandardNoteSets("electrical");
    expect(elec.map((s) => s.id)).toEqual(["electrical-general", "electrical-demolition"]);

    const formatted = formatStandardNoteSet("electrical-general", {
      title: "PROJECT ELECTRICAL NOTES",
      excludeNumbers: [1],
      extraNotes: ["COORDINATE WITH OWNER IT VENDOR."],
    });
    expect(formatted).toContain("PROJECT ELECTRICAL NOTES (NFPA 70 (NEC 2023) / IECC)");
    expect(formatted).not.toContain("ALL ELECTRICAL WORK SHALL COMPLY");
    expect(formatted).toContain("COORDINATE WITH OWNER IT VENDOR.");
  });

  it("places a standard note block via documents.placeStandardNotes and is discoverable via reference", () => {
    const hits = searchReference("general notes");
    expect(hits.some((h) => h.kind === "function" && h.name === "documents.placeStandardNotes")).toBe(true);

    let m: ModelState = {
      modelId: "m-notes",
      revision: asRevision(0),
      elements: {},
      connections: [],
      settings: DEFAULT_SETTINGS,
    };
    const r0 = executeCommand(m, { type: "create_sheet", sheetId: "sh-e101", number: "E101", name: "Power" });
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    m = { ...r0.model, revision: asRevision(1) };

    const edits: unknown[] = [];
    const ctx = {
      id: (p: string) => `${p}-1`,
      edit: (cmd: unknown) => {
        edits.push(cmd);
        const r = withUpgradePolicy(() => true, () => executeCommand(m, cmd as Parameters<typeof executeCommand>[1]));
        if (!r.ok) throw new Error(r.error.message);
        m = { ...r.model, revision: asRevision(Number(m.revision) + 1) };
      },
    } as unknown as Parameters<typeof documents.placeStandardNotes>[0];

    const id = documents.placeStandardNotes(
      ctx,
      "sh-e101",
      "electrical-general",
      { x: measure("length", 500, "mm"), y: measure("length", 400, "mm") },
      { width: measure("length", 180, "mm") },
    );
    expect(id).toBe("notes-electrical-general-1");
    expect(edits).toHaveLength(1);
    const placed = m.elements[id];
    expect(placed?.kind).toBe("drawing_item");
    if (placed?.kind === "drawing_item") {
      expect(placed.shape).toBe("text");
      expect(placed.note?.paragraphs[0]?.runs[0]?.text).toContain("ELECTRICAL GENERAL NOTES");
    }
  });
});
