import { withLintRank, type RuleDef } from "@permitzip/bim-lint";
import { electricalRules, processRules } from "./electrical";
import { loadVoltageRules } from "./load-voltage";
import { PHOTOMETRIC_LINT_RULES } from "./photometrics";

export { electricalRules, processRules } from "./electrical";
export { loadVoltageRules } from "./load-voltage";
export { PHOTOMETRIC_LINT_RULES } from "./photometrics";

/** Electrical's lint rules at the places they ran when they were built in: distribution after documents, the load voltage check with the shared load rules, photometrics & egress compliance, and issue checks last. */
export const ELECTRICAL_LINT_RULES: readonly RuleDef[] = [...withLintRank(electricalRules, 600), ...withLintRank(loadVoltageRules, 700), ...withLintRank(PHOTOMETRIC_LINT_RULES, 920), ...withLintRank(processRules, 1300)];
