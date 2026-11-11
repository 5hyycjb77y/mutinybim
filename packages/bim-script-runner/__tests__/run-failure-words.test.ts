/**
 * @jest-environment node
 *
 * Words for a run that failed. A script error longer than the host's result
 * schema takes (4,000 characters) used to be refused whole and reported as
 * "the script runner's answer isn't a run result"; it is cut instead. A
 * script process that ended with no answer says whether the machine never
 * started or was stopped from outside. Fails on the code before: neither
 * function existed and the long message was passed on uncut.
 */
import { runFailureWords, RUNNER_CONTRACT } from "@permitzip/bim-script";
import { RUN_MESSAGE_MAX, clipRunMessage, exitWords } from "../src/protocol";
import { RUNNER_RESULT_SCHEMA } from "../src/result";

describe("run failure words", () => {
  it("a long script error is cut to what the result schema takes, and says how much was cut", () => {
    const long = `Line 4: ${"x".repeat(9000)}`;
    const cut = clipRunMessage(long);
    expect(cut.length).toBeLessThan(4000);
    expect(cut.startsWith(long.slice(0, RUN_MESSAGE_MAX))).toBe(true);
    expect(cut).toContain(`${long.length - RUN_MESSAGE_MAX} more characters cut`);
    expect(RUNNER_RESULT_SCHEMA.safeParse({ ok: false, code: "script_error", message: cut, ms: 1 }).success).toBe(true);
    expect(RUNNER_RESULT_SCHEMA.safeParse({ ok: false, code: "script_error", message: long, ms: 1 }).success).toBe(false);
    expect(clipRunMessage("Line 4: short")).toBe("Line 4: short");
  });

  it("a process that ended before it was ready is the machine's fault, and says so", () => {
    expect(exitWords(1, null, "Error: Cannot find module 'script-child.cjs'\n", false)).toBe("the script process exited 1 before answering: Error: Cannot find module 'script-child.cjs'. It ended before it was ready, so the script machine didn't start");
  });

  it("a process killed from outside says memory is the usual reason, and keeps the words hosts match on", () => {
    const words = exitWords(null, "SIGKILL", "", true);
    expect(words).toContain("exited SIGKILL before answering");
    expect(words).toContain("too much memory");
    expect(exitWords(1, null, "", true)).toBe("the script process exited 1 before answering");
  });

  it("a machine fault tells the agent not to rewrite the script", () => {
    const words = runFailureWords({ ok: false, code: "runner_error", message: exitWords(1, null, "", true), ms: 1 }, RUNNER_CONTRACT);
    expect(words).toContain("The script couldn't be run here: the script process exited 1 before answering.");
    expect(words).toContain("don't rewrite the script");
    expect(runFailureWords({ ok: false, code: "script_error", message: "Line 3: no level", ms: 1 }, RUNNER_CONTRACT)).toBe("The script stopped: Line 3: no level");
  });
});
