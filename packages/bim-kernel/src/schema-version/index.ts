export {
  currentSchemaVersion,
  gatedRecordFeatures,
  registerSchemaStep,
  schemaSteps,
  schemaVersionOf,
  stepAllowed,
  storedSchemaVersion,
  unregisterSchemaSteps,
  withUpgradePolicy,
  withoutUpgrades,
  type SchemaStep,
  type UpgradePolicy,
} from "./registry";
export { upgradeOnEdit } from "./upgrade";
import "./edit-hook";
