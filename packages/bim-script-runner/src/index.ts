/**
 * `@permitzip/bim-script-runner`: runs one MutinyBIM script in a fresh
 * process with the kit's caps. Hosts that run other people's scripts put the
 * two bundled files on a sealed machine; `LocalScriptRunner` runs them on
 * this computer for one person's own scripts.
 */
export { NEVER_FINISHED_WORDS, RUN_MESSAGE_MAX, SCRIPT_CHILD_FILE, SCRIPT_RUNNER_CAPS, SCRIPT_RUNNER_FILE, UNAWAITED_WORDS, childEnv, childNodeArgs, clampLimits, clipRunMessage, exitWords, type ChildLine, type ScriptRunnerLimits, type ScriptRunnerRequestFile } from "./protocol";
export { superviseRun, type SupervisedResult, type SuperviseOptions } from "./supervisor";
export { buildScriptRunner, type BuildScriptRunnerOptions } from "./build";
export { RUNNER_RESULT_SCHEMA, toScriptRunResult, type RunnerResultLine } from "./result";
export { LocalScriptRunner, type LocalRunnerAvailability, type LocalScriptRunnerOptions } from "./local";
