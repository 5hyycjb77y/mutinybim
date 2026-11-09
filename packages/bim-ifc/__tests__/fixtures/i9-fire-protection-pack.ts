import { CLASS_POINT, IFC_IMPORT_RULE_POINT, type Component, type ImportRuleDef } from "@permitzip/bim-kernel";
import { contribute, definePack } from "@permitzip/bim-kernel/packs";

/**
 * A fire-protection add-on nobody built into the kernel or the importer: it
 * declares a head class with an IFC home and its own import rule, and the
 * importer converts the heads with zero kernel or importer edits. Imports
 * only the kernel's public entry points.
 */
export const HEAD_CLASS = "tfp.head";
export const HEAD_RULE = "tfp.head_as_point";

const headRule: ImportRuleDef = {
  id: HEAD_RULE,
  label: "Heads as plan points",
  convert(product, ctx) {
    const level = ctx.level(product);
    const b = product.geometry.bounds;
    if (!level || !b) return { ok: false, reason: "its position couldn't be read" };
    const record: Component = {
      id: ctx.idFor(product.sourceId),
      kind: "component",
      version: 0,
      authoredRev: {},
      partition: ctx.partition(level),
      classId: ctx.cls.id,
      provenance: ctx.provenance(product),
      category: HEAD_CLASS,
      typeName: product.typeName ?? product.name ?? "Head",
      position: { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 },
      size: { x: b.max.x - b.min.x, y: b.max.y - b.min.y },
      rotationDeg: 0,
    };
    return { ok: true, records: [record] };
  },
};

export const FIRE_PROTECTION_TEST_PACK = definePack({ id: "tfp", name: "Test fire protection", version: "1.0.0", kernel: "^1.4.0" }, [
  contribute(CLASS_POINT, [
    {
      id: HEAD_CLASS,
      label: "Heads",
      discipline: "fire_protection",
      ifc: { entity: "IfcFireSuppressionTerminal", predefinedType: "SPRINKLER", import: { rule: HEAD_RULE } },
      recognize: { elementKinds: ["component"], where: [{ path: "classId", op: "equals", value: HEAD_CLASS }] },
    },
  ]),
  contribute(IFC_IMPORT_RULE_POINT, [headRule]),
]);
