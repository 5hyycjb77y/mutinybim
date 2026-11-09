import { registerEditHook } from "../command-core";
import { upgradeOnEdit } from "./upgrade";

/** Every command's `finish` upgrades the records it touched (command-core.ts runs registered edit hooks). */
registerEditHook("schema-version", (_base, working, touchedIds) => {
  upgradeOnEdit(working, touchedIds);
});
