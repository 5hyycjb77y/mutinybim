/**
 * @jest-environment node
 *
 * Round 11 C11: an outside add-on brings a reader and a writer with no kernel
 * edit. A test survey add-on reads its own point-list format into the
 * importer's neutral products (landing in an outside author's copy); a test
 * building-automation add-on writes a deterministic point list of the placed
 * parts, by model or by level, and gets an artifact row with its digest.
 * Without the add-ons neither is offered.
 *
 * Fails on round 10's code: there was no import-source or export-target
 * point, so a format other than IFC needed a kernel and an importer edit.
 */
import {
  DEFAULT_SETTINGS,
  asElementId,
  asRevision,
  builtinPartType,
  executeCommand,
  payloadDigest,
  elementsOfKind,
  type ImportProduct,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  EXPORT_TARGET_POINT,
  IMPORT_SOURCE_POINT,
  detectImportSource,
  exportTargetDeterminismProblem,
  exportTargetRowProblems,
  exportTo,
  importSourceRowProblems,
  planImportFrom,
  type ExportTargetDef,
  type ImportSourceDef,
} from "@permitzip/bim-kernel/formats";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

const HEADER = "C11SURVEY 1";

/** `C11SURVEY 1` then one `name,x,y,z` line per surveyed point (mm). */
const SURVEY_READER: ImportSourceDef = {
  id: "c11survey.points",
  label: "Survey points",
  extensions: [".pts"],
  landsIn: ["external_author"],
  detect: (head) => head.startsWith(HEADER),
  read: (text, opts) => {
    const products: ImportProduct[] = text
      .split("\n")
      .slice(1)
      .filter((l) => l.trim().length > 0)
      .map((line, i) => {
        const [name = "", x = "0", y = "0", z = "0"] = line.split(",");
        const p = { x: Number(x), y: Number(y), z: Number(z) };
        return {
          sourceId: `pt-${i}`,
          entity: "IfcGeographicElement",
          predefinedType: null,
          objectType: "survey point",
          name,
          longName: null,
          tag: null,
          storeyId: null,
          typeId: null,
          typeName: null,
          hostId: null,
          groupIds: [],
          geometry: { extrusions: [], bounds: { min: p, max: p }, unread: null },
          properties: {},
          overall: { width: null, height: null },
          material: null,
          ports: [],
        };
      });
    return { id: opts.sourceId, label: opts.label, disciplines: opts.disciplines, storeys: [], groups: [], products, unreadable: [] };
  },
};

const POINT_LIST: ExportTargetDef = {
  id: "c11bas.point_list",
  label: "Building automation point list",
  extension: ".csv",
  mediaType: "text/csv",
  scopes: ["model", "level"],
  write: (input) => {
    const parts = elementsOfKind(input.model.elements, "part")
      .filter((p) => input.scope.kind !== "level" || p.levelId === input.scope.levelId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const text = ["mark,type,level", ...parts.map((p) => `${p.mark},${p.typeId},${p.levelId}`)].join("\n") + "\n";
    return { bytes: new TextEncoder().encode(text), fileName: `${input.project.name} points.csv`, summary: `${parts.length} points`, warnings: [], counts: { points: parts.length } };
  },
};

const SURVEY = definePack({ id: "c11survey", name: "Survey (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(IMPORT_SOURCE_POINT, [SURVEY_READER])]);
const BAS = definePack({ id: "c11bas", name: "Building automation (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(EXPORT_TARGET_POINT, [POINT_LIST])]);
const WITH_BOTH = PackSet.create([SURVEY, BAS]);

function host(): ModelState {
  let m: ModelState = { modelId: "c11-host", revision: asRevision(1), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const run = (c: Parameters<typeof executeCommand>[1]) => {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error.message);
    m = r.model;
  };
  run({ type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });
  run({ type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 4000 });
  const t = builtinPartType("builtin:rtu-5-ton@1");
  if (!t) throw new Error("starter library is missing the RTU");
  run({ type: "place_part", partId: "ahu-2", typeId: t.id, partType: t.definition, levelId: "L2", position: { x: 0, y: 0 }, offsetMm: 0, mark: "AHU-2" });
  run({ type: "place_part", partId: "ahu-1", typeId: t.id, levelId: "L1", position: { x: 0, y: 0 }, offsetMm: 0, mark: "AHU-1" });
  return m;
}

const FILE = `${HEADER}\nBM-1,0,0,0\nBM-2,1000,0,0\n`;
const READ = { sourceId: "survey-1", label: "Site survey", disciplines: ["civil"] } as const;
const project = { id: "c11-project", name: "Test" };

describe("c11 an outside reader and writer, no kernel edit", () => {
  it("their rows pass the points' row checks", () => {
    expect(importSourceRowProblems([SURVEY_READER])).toEqual([]);
    expect(exportTargetRowProblems([POINT_LIST])).toEqual([]);
  });

  it("the survey reader is detected and read into an outside author's copy", () => {
    withPackSet(WITH_BOTH, () => {
      expect(detectImportSource(FILE, "site.pts")?.id).toBe("c11survey.points");
      const plan = planImportFrom(FILE, { model: host(), referenceId: "ref-survey", sourceKey: "s1", read: READ });
      expect(plan.format).toBe("c11survey.points");
      expect(plan.landsIn).toBe("external_author");
      expect(plan.report.source).toEqual({ id: "survey-1", label: "Site survey", disciplines: ["civil"] });
      expect(plan.report.converted + plan.report.stayLinked).toBe(2);
      expect(() => planImportFrom(FILE, { model: host(), referenceId: "ref-survey", sourceKey: "s1", read: READ, landIn: "proposal" })).toThrow(/Survey points files land in external_author copies/);
    });
  });

  it("the point list writes by model and by level, deterministic, with its artifact row", () => {
    withPackSet(WITH_BOTH, () => {
      const model = host();
      const all = exportTo("c11bas.point_list", { model, project, timeStamp: "2026-11-02T12:00:00", scope: { kind: "model" } });
      expect(new TextDecoder().decode(all.bytes)).toBe("mark,type,level\nAHU-1,builtin:rtu-5-ton@1,L1\nAHU-2,builtin:rtu-5-ton@1,L2\n");
      expect(all.row).toMatchObject({ target: "c11bas.point_list", mediaType: "text/csv", fileName: "Test points.csv", digest: payloadDigest(all.bytes), counts: { points: 2 }, summary: "2 points" });
      const l2 = exportTo("c11bas.point_list", { model, project, timeStamp: "2026-11-02T12:00:00", scope: { kind: "level", levelId: asElementId("L2") } });
      expect(new TextDecoder().decode(l2.bytes)).toBe("mark,type,level\nAHU-2,builtin:rtu-5-ton@1,L2\n");
      expect(exportTargetDeterminismProblem("c11bas.point_list", { model, project, timeStamp: "2026-11-02T12:00:00", scope: { kind: "model" } })).toBeNull();
    });
  });

  it("without the add-ons neither format is offered", () => {
    expect(detectImportSource(FILE, "site.pts")).toBeNull();
    expect(() => exportTo("c11bas.point_list", { model: host(), project, timeStamp: "2026-11-02T12:00:00", scope: { kind: "model" } })).toThrow(/No writer for "c11bas.point_list"/);
  });
});
