import { registerSchemaStep, schemaSteps } from "../schema-version/registry";
import type { BimElement } from "../types";
import { ELEMENT_CORE_KINDS, ELEMENT_CORE_STEP, ELEMENTS_CORE_FEATURE, isCoreElement } from "./feature";
import { builtinClassOf } from "./recognise";

/**
 * Quiet upgrade on edit (5a's registry, `schema-version/`): a building or
 * structure record at version 1 that a command touches gains the `classId`
 * the built-in registry recognises it as, and is stamped version 2, in the
 * same changeset as the edit. Untouched records are never rewritten; undo
 * restores the stored record and never upgrades. Gated on `elements:core`,
 * so a peer that doesn't read element-core fields never receives them.
 *
 * Version 1 is "no `classId`" (records were never stamped), so a record a
 * newer peer classified explicitly reads as already upgraded.
 */
export function upgradeToElementCore(record: BimElement): BimElement {
  if (!isCoreElement(record) || record.classId !== undefined) return record;
  const classId = builtinClassOf(record);
  return classId === null ? record : { ...record, classId, classSource: "recognised" };
}

for (const kind of ELEMENT_CORE_KINDS) {
  if (schemaSteps(kind).some((s) => s.name === ELEMENT_CORE_STEP)) continue;
  registerSchemaStep({
    kind,
    from: 1,
    to: 2,
    name: ELEMENT_CORE_STEP,
    feature: ELEMENTS_CORE_FEATURE,
    detect: (record) => isCoreElement(record) && record.classId === undefined,
    upgrade: upgradeToElementCore,
  });
}
