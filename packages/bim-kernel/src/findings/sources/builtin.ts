import { DIVERGENCE_FINDING_SOURCE, QUESTION_HOLD_FINDING_SOURCE, RELIANCE_FINDING_SOURCE } from "./kernel-records";
import { registerBuiltinFindingSource } from "./point";
import { REQUIREMENT_FINDING_SOURCE } from "./requirements";

// The kernel's own producers are built-in rows of `FINDING_SOURCE_POINT`, registered when the ledger loads.
registerBuiltinFindingSource(REQUIREMENT_FINDING_SOURCE);
registerBuiltinFindingSource(QUESTION_HOLD_FINDING_SOURCE);
registerBuiltinFindingSource(RELIANCE_FINDING_SOURCE);
registerBuiltinFindingSource(DIVERGENCE_FINDING_SOURCE);

export const BUILTIN_FINDING_SOURCE_IDS = [REQUIREMENT_FINDING_SOURCE.id, QUESTION_HOLD_FINDING_SOURCE.id, RELIANCE_FINDING_SOURCE.id, DIVERGENCE_FINDING_SOURCE.id] as const;
