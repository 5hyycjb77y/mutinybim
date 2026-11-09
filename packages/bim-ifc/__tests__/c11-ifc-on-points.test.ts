/**
 * @jest-environment node
 *
 * Round 11 C11: IFC is the first reader on `IMPORT_SOURCE_POINT` and the first
 * writer on `EXPORT_TARGET_POINT`. Through the points a model exports to the
 * same bytes as `exportIfc` and a file imports to the same plan as
 * `importIfc`; the artifact row carries the digest; a file is detected by its
 * ending and its header; what it reads lands in a proposal copy by default or
 * an outside author's copy when asked, never another purpose.
 *
 * Fails on round 10's code: neither point, nor `exportTo` / `planImportFrom`,
 * nor the IFC rows existed (IFC was the only reader and writer, written in).
 */
import { payloadDigest } from "@permitzip/bim-kernel";
import { EXPORT_TARGET_POINT, IMPORT_SOURCE_POINT, ImportSourceError, ExportTargetError, detectImportSource, exportTargetDeterminismProblem, exportTo, planImportFrom } from "@permitzip/bim-kernel/formats";
import { activePackSet } from "@permitzip/bim-kernel/packs";
import { IFC_EXPORT_TARGET, IFC_IMPORT_SOURCE, exportIfc, importIfc } from "../src";
import { PROJECT_ID, TIME_STAMP, syntheticModel } from "./c5i-model";
import { architectureAndStructure, hostModel } from "./i9-fixtures";

const project = { id: PROJECT_ID, name: "Synthetic kitchen", number: "0001" };
const READ = { sourceId: "ver-arch-1", label: "Main St shell", disciplines: ["architecture", "structure"] } as const;

describe("c11 IFC on the format points", () => {
  it("both rows are built in, by bare id", () => {
    expect(activePackSet().items(IMPORT_SOURCE_POINT)).toContain(IFC_IMPORT_SOURCE);
    expect(activePackSet().items(EXPORT_TARGET_POINT)).toContain(IFC_EXPORT_TARGET);
    expect(IFC_IMPORT_SOURCE.id).toBe("ifc");
    expect(IFC_EXPORT_TARGET.id).toBe("ifc");
  });

  it("export through the point: byte-identical to exportIfc, and the artifact row names it", () => {
    const model = syntheticModel();
    const direct = exportIfc({ model, project, timeStamp: TIME_STAMP });
    const via = exportTo("ifc", { model, project, timeStamp: TIME_STAMP, scope: { kind: "model" } });
    expect(Buffer.from(via.bytes).equals(Buffer.from(direct.bytes))).toBe(true);
    expect(via.row).toMatchObject({ target: "ifc", targetLabel: "IFC", modelId: model.modelId, revision: model.revision, mediaType: "application/x-step", byteLength: direct.bytes.byteLength, digest: payloadDigest(direct.bytes), timeStamp: TIME_STAMP, fileName: "0001.ifc" });
    expect(via.row.counts["elements"]).toBe(direct.report.counts.elements);
    expect(exportTargetDeterminismProblem("ifc", { model, project, timeStamp: TIME_STAMP, scope: { kind: "model" } })).toBeNull();
  });

  it("a scope IFC doesn't write, and a writer nobody registered, are refused in words", () => {
    const model = syntheticModel();
    expect(() => exportTo("ifc", { model, project, timeStamp: TIME_STAMP, scope: { kind: "elements", ids: [] } })).toThrow(ExportTargetError);
    expect(() => exportTo("ifc", { model, project, timeStamp: TIME_STAMP, scope: { kind: "elements", ids: [] } })).toThrow(/IFC writes model, not one elements/);
    expect(() => exportTo("c11nope.points", { model, project, timeStamp: TIME_STAMP, scope: { kind: "model" } })).toThrow(/No writer for "c11nope.points"/);
  });

  it("import through the point: the same plan as importIfc, landing in a proposal copy by default", () => {
    const text = architectureAndStructure().text;
    const input = { model: hostModel(), referenceId: "ref-arch", sourceKey: "v1" };
    const direct = importIfc(text, { ...input, ...READ });
    const via = planImportFrom(text, { ...input, read: READ, fileName: "Shell.IFC" });
    expect(via.format).toBe("ifc");
    expect(via.landsIn).toBe("proposal");
    expect(via.records).toEqual(direct.records);
    expect([...via.converted]).toEqual([...direct.converted]);
    expect(via.report).toEqual(direct.report);
    expect(planImportFrom(text, { ...input, read: READ, format: "ifc", landIn: "external_author" }).landsIn).toBe("external_author");
  });

  it("detects by ending and header; refuses a file it can't read and a purpose it doesn't land in", () => {
    const text = architectureAndStructure().text;
    expect(detectImportSource(text)?.id).toBe("ifc");
    expect(detectImportSource(text, "model.ifc")?.id).toBe("ifc");
    expect(detectImportSource("<?xml version=\"1.0\"?><LandXML/>", "site.xml")).toBeNull();
    const input = { model: hostModel(), referenceId: "ref-arch", sourceKey: "v1", read: READ };
    expect(() => planImportFrom("<?xml version=\"1.0\"?><LandXML/>", { ...input, fileName: "site.xml" })).toThrow(ImportSourceError);
    expect(() => planImportFrom(text, { ...input, landIn: "as_built" })).toThrow(/IFC files land in proposal or external_author copies/);
  });
});
