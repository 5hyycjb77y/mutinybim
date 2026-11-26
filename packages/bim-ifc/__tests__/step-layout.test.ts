/** @jest-environment node */
import { importIfc, readStep } from "../src";
import { architectureAndStructure, hostModel } from "./i9-fixtures";

const source = architectureAndStructure().text;
const singleLine = source.replaceAll("\n", " ");

describe("STEP record layout", () => {
  it.each([
    ["CRLF", source.replaceAll("\n", "\r\n")],
    ["a byte-order mark", "\uFEFF" + source],
    ["one line", singleLine],
    ["adjacent records", source.replaceAll("\n", "")],
    ["wrapped records with comments after instance IDs", source.replace(/^(#\d+)=/gm, "$1 /* instance */\n  =\n  ")],
    ["indented section markers", source.replace(/^(DATA;|ENDSEC;)/gm, "  $1")],
    ["CR-only line endings", source.replaceAll("\n", "\r")],
  ])("reads the same schema, entities and arguments with %s", (_layout, text) => {
    expect(readStep(text)).toEqual(readStep(source));
  });

  it("imports the same editable records and report from a single-line IFC", () => {
    const options = { model: hostModel(), referenceId: "ref", sourceKey: "layout", sourceId: "layout-v1",
      label: "Shell", disciplines: ["architecture", "structure"] };
    const normal = importIfc(source, options);
    expect(normal.records.filter((r) => r.kind === "wall")).toHaveLength(2);
    const compact = importIfc(singleLine, options);
    expect(compact.records).toEqual(normal.records);
    expect(compact.report).toEqual(normal.report);
  });

  it("keeps quoted punctuation in names and ignores section names inside comments", () => {
    const file = readStep([
      "ISO-10303-21;", "HEADER;",
      "FILE_DESCRIPTION(('Owner''s DATA; annotation'),'2;1');",
      "/* Example header syntax: FILE_SCHEMA(('EXAMPLE')); */",
      "FILE_SCHEMA(('IFC4'));", "ENDSEC;",
      "/* An example section is written", "DATA;", "ENDSEC;", "*/",
      "DATA;", "#1=IFCMATERIAL('Owner''s ENDSEC; /*finish*/',$,$);",
      "/* ENDSEC; is the section terminator. */",
      "#2=IFCCARTESIANPOINT((1.,/* Y coordinate */2.));",
      "ENDSEC;", "END-ISO-10303-21;",
    ].join("\n"));
    expect(file.schemas).toEqual(["IFC4"]);
    expect([...file.entities.keys()]).toEqual([1, 2]);
    expect(file.entities.get(1)?.args[0]).toEqual({ kind: "string", value: "Owner's ENDSEC; /*finish*/" });
    expect(file.entities.get(2)?.args[0]).toEqual({ kind: "list", items: [{ kind: "number", value: 1 }, { kind: "number", value: 2 }] });
  });

  it("accepts an empty DATA section", () => {
    expect(readStep("ISO-10303-21; HEADER; ENDSEC; DATA; ENDSEC; END-ISO-10303-21;").entities.size).toBe(0);
  });

  it("reports a missing semicolon between two instances", () => {
    const text = [
      "ISO-10303-21;", "HEADER;", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
      "#1=IFCCARTESIANPOINT((0.,0.))", "#2=IFCCARTESIANPOINT((1.,1.));",
      "ENDSEC;", "END-ISO-10303-21;",
    ].join("\n");
    expect(() => readStep(text)).toThrow(/expected ; after #1/);
  });

  it("distinguishes a missing DATA section from a missing closing ENDSEC", () => {
    const header = "ISO-10303-21;\nHEADER;\nENDSEC;\n";
    expect(() => readStep(header)).toThrow("STEP: no DATA section");
    expect(() => readStep(header + "DATA;\n#1=IFCCARTESIANPOINT((1.,2.));")).toThrow(/DATA section.*ENDSEC/);
    expect(() => readStep(header + "DATA;\n#1=IFCCARTESIANPOINT((1.,")).toThrow(/DATA section.*ENDSEC/);
  });
});
