/**
 * @jest-environment node
 *
 * Bug log #18 (2026-10-23, site-7352): one invalid run froze every edit in
 * the model, and the refusal named that run against an unrelated action.
 * An edit is refused only for an issue it creates, or for an issue already
 * open on an element it edits ("fix this first"). An accepted edit reports
 * the issues still open.
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  canonicalJson,
  planCommit,
  validateModel,
  type Changeset,
  type Command,
  type CommandRequest,
  type ModelState,
  type RunSegment,
} from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-23T00:00:00.000Z";
const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const DUCT = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "open-issues", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    this.ok({ type: "route_run", idPrefix: "bad", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 0 }, { x: 20 * FT, y: 0 }] });
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `oi-${counter}`, baseRevision: base, actor: { id: "agent", name: "Agent", kind: "agent" }, command, clientSessionId: "tab" };
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command) {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d;
  }
  /** Tilt one end of the run 5 mm: no longer level, not 45°. An invalid run, as an older model or an import leaves it. */
  breakRun(): RunSegment {
    const seg = this.head.elements["bad-s1"];
    if (seg?.kind !== "run_segment") throw new Error("no run");
    const broken: RunSegment = { ...seg, end: { ...seg.end, z: seg.end.z + 5 } };
    this.head = { ...this.head, elements: { ...this.head.elements, [broken.id]: broken } };
    expect(validateModel(this.head).map((i) => i.elementIds)).toEqual([["bad-s1"]]);
    return broken;
  }
}

describe("an invalid run doesn't freeze unrelated edits (#18)", () => {
  test("an unrelated edit saves and reports the issue still open", () => {
    const m = new Model();
    m.breakRun();
    const d = m.ok({ type: "route_run", idPrefix: "other", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 10 * FT }, { x: 20 * FT, y: 10 * FT }] });
    expect(Object.keys(m.head.elements)).toContain("other-s1");
    expect(validateModel(d.model).map((i) => i.elementIds)).toEqual([["bad-s1"]]);
    // A second unrelated edit on the committed model takes the same path (the cached open issues), not the first one.
    m.ok({ type: "create_level", levelId: "lvl-2", name: "Level 2", elevationMm: 12 * FT });
    expect(m.head.elements["lvl-2"]).toBeDefined();
  });

  test("an edit that changes the invalid run is refused, naming its issue and saying fix it first", () => {
    const m = new Model();
    m.breakRun();
    const d = m.submit({ type: "drag_run", elementId: "bad-s1", delta: { x: 0, y: 0, z: 30 }, grip: "end" });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.elementIds).toEqual(["bad-s1"]);
    expect(d.error.message).toMatch(/open issue: ".*isn't level/);
    expect(d.error.message).toMatch(/Fix that issue first/);
  });

  test("an edit that creates a new issue is refused for that issue, not the old one", () => {
    const m = new Model();
    m.breakRun();
    // A second run that's too short: its own issue.
    const d = m.submit({ type: "route_run", idPrefix: "short", levelId: "lvl-1", domain: "duct", size: DUCT, elevationMm: 10 * FT, system: SA, points: [{ x: 0, y: 30 * FT }, { x: 20, y: 30 * FT }] });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.error.elementIds).not.toContain("bad-s1");
  });

  test("an edit that clears the issue is accepted and the model is valid again", () => {
    const m = new Model();
    const broken = m.breakRun();
    m.ok({ type: "delete_elements", ids: [broken.id], policy: "refuse" });
    expect(validateModel(m.head)).toEqual([]);
  });
});
