import { registerBuiltinExportTarget, registerBuiltinImportSource, type ExportTargetDef, type ExportTargetOutput, type ImportSourceDef } from "@permitzip/bim-kernel/formats";
import { exportIfc, type IfcExportReport } from "./export";
import { readIfcSource } from "./import";

/**
 * IFC on the kernel's format points (round 11 C11): the first reader on
 * `IMPORT_SOURCE_POINT` and the first writer on `EXPORT_TARGET_POINT`. Both
 * call the existing reader and writer unchanged, so a file read or written
 * through a point is exactly what `readIfcSource` / `exportIfc` give.
 */

const STEP_HEADER = /^\uFEFF?\s*ISO-10303-21\s*;/;

export const IFC_IMPORT_SOURCE: ImportSourceDef = {
  id: "ifc",
  label: "IFC",
  extensions: [".ifc"],
  landsIn: ["proposal", "external_author"],
  detect: (head: string) => STEP_HEADER.test(head) && /FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head),
  read: readIfcSource,
};

export interface IfcTargetOutput extends ExportTargetOutput {
  readonly report: IfcExportReport;
}

export const IFC_EXPORT_TARGET: ExportTargetDef<IfcTargetOutput> = {
  id: "ifc",
  label: "IFC",
  extension: ".ifc",
  mediaType: "application/x-step",
  scopes: ["model"],
  write: (input) => {
    const result = exportIfc({
      model: input.model,
      project: input.project,
      timeStamp: input.timeStamp,
      ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.organization !== undefined ? { organization: input.organization } : {}),
    });
    const c = result.report.counts;
    return {
      bytes: result.bytes,
      fileName: input.fileName ?? `${input.project.number ?? input.project.name}.ifc`,
      summary: `${c.elements} elements on ${c.storeys} storeys, ${c.spaces} spaces, ${c.zones} zones and ${c.systems} systems${result.report.warnings.length > 0 ? `; ${result.report.warnings.length} things to look at` : ""}`,
      warnings: result.report.warnings,
      counts: { ...c },
      report: result.report,
    };
  },
};

registerBuiltinImportSource(IFC_IMPORT_SOURCE);
registerBuiltinExportTarget(IFC_EXPORT_TARGET);
