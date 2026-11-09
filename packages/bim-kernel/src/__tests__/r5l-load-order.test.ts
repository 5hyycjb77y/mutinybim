/**
 * @jest-environment node
 *
 * Round 5a cycle breaks, proven by loading each lower module with the module
 * it used to import replaced by one that throws when loaded. On the old code
 * each of these requires reached the forbidden module (that was the cycle)
 * and threw; now none does. Then the moved code answers exactly as before.
 */

function loadWithout(blocked: readonly string[], load: () => void): void {
  try {
    jest.isolateModules(() => {
      for (const p of blocked) {
        jest.doMock(p, () => {
          throw new Error(`loaded ${p}`);
        });
      }
      load();
    });
  } finally {
    for (const p of blocked) jest.dontMock(p);
  }
}

afterEach(() => {
  jest.resetModules();
});

describe("lower modules load without the higher ones they used to import", () => {
  it("the edit spine loads without view or organization commands (C8, C10, C13)", () => {
    expect(() => loadWithout(["../commands/views", "../organization/commands", "../commands"], () => require("../command-core"))).not.toThrow();
  });

  it("the schedule engine's edit planner loads without the command dispatcher (C10)", () => {
    expect(() => loadWithout(["../commands"], () => require("../schedules/engine/edit"))).not.toThrow();
  });

  it("the schedule model half loads without the print half (C11, C12)", () => {
    expect(() => loadWithout(["../schedules/paper", "../schedules/engine"], () => require("../schedules/schedule"))).not.toThrow();
  });

  it("3D views load without crop boxes (C9)", () => {
    expect(() => loadWithout(["../crop"], () => require("../view3d"))).not.toThrow();
  });

  it("pipe run checks load without run validation (C4)", () => {
    expect(() => loadWithout(["../routing/validate"], () => require("../routing/pipe/run-checks"))).not.toThrow();
  });

  it("fitting refits load without the routing commands (C14)", () => {
    expect(() => loadWithout(["../routing/commands"], () => require("../routing/fitting-follow"))).not.toThrow();
  });
});

describe("the command handler table", () => {
  it("refuses loudly to check a command when no parser is registered", () => {
    jest.isolateModules(() => {
      const core = require("../command-core") as typeof import("../command-core");
      expect(() => core.parseCommand({ type: "set_terminal_cfm", terminalId: "t1", cfm: 100 })).toThrow(/No command parser is registered/);
    });
  });

  it("checks commands exactly as the intent schema does once the commands load", () => {
    jest.isolateModules(() => {
      const commands = require("../commands") as typeof import("../commands");
      const samples: unknown[] = [
        { type: "set_terminal_cfm", terminalId: "t1", cfm: 100 },
        { type: "set_terminal_cfm", terminalId: "t1", cfm: -5 },
        { type: "set_parameters", id: "p1", scope: "instance", values: { mark: "A-1" } },
        { type: "no_such_command" },
        { type: "set_tag_text", tagId: "g1", text: "" },
      ];
      for (const raw of samples) {
        const viaTable = commands.parseCommand(raw);
        const direct = commands.commandSchema.safeParse(raw);
        expect(viaTable.success).toBe(direct.success);
        if (viaTable.success && direct.success) expect(viaTable.data).toEqual(direct.data);
        if (!viaTable.success && !direct.success) expect(viaTable.error.issues[0]?.message).toBe(direct.error.issues[0]?.message);
      }
    });
  });

  it("runs edit hooks in registration order and replaces a re-registered id in place", () => {
    jest.isolateModules(() => {
      const core = require("../command-core") as typeof import("../command-core");
      const calls: string[] = [];
      core.registerEditHook("a", () => calls.push("a1"));
      core.registerEditHook("b", () => calls.push("b"));
      core.registerEditHook("a", () => calls.push("a2"));
      core.runEditHooks({ elements: {}, connections: [] } as unknown as import("../types").ModelState, {}, []);
      expect(calls).toEqual(["a2", "b"]);
    });
  });
});

describe("moved readers answer as before", () => {
  it("authored document and organization fields read through the spine", () => {
    jest.isolateModules(() => {
      const { authoredFieldValue } = require("../command-core") as typeof import("../command-core");
      const view = { id: "v1", kind: "view", name: "Level 1", viewType: "plan", cropMin: { x: 0, y: 0 }, cropMax: { x: 10, y: 5 }, props: { scale: 48 } } as unknown as import("../types").BimElement;
      expect(authoredFieldValue(view, "doc.name")).toBe("Level 1");
      expect(authoredFieldValue(view, "doc.crop")).toBe('{"max":{"x":10,"y":5},"min":{"x":0,"y":0}}');
      expect(authoredFieldValue(view, "doc.props.scale")).toBe("48");
      expect(authoredFieldValue(view, "doc.deleted")).toBe("false");
      const wall = { id: "w1", kind: "wall", start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, phaseDemolished: "phase-existing" } as unknown as import("../types").BimElement;
      expect(authoredFieldValue(wall, "org.groupId")).toBe("grp-general");
      expect(authoredFieldValue(wall, "org.phaseCreated")).toBe("phase-new");
      expect(authoredFieldValue(wall, "org.phaseDemolished")).toBe("phase-existing");
      expect(authoredFieldValue(wall, "nope")).toBeUndefined();
    });
  });

  it("the public barrel still exports every moved name", () => {
    const kernel = require("..") as Record<string, unknown>;
    for (const name of ["documentFieldValue", "organizationFieldValue", "ORG_FIELDS", "levelContentExtent", "linksFedFrom", "linkServing", "occupiedPositions", "serviceNeighbours", "serviceFingerprint", "serviceLinkName", "runLabel", "chooseFitting", "pipeComponent", "pipeWalkTree", "pipeNodeId", "pipePositionOn", "parseCommand", "registerEditHook", "scheduleV2Paper"]) {
      expect([name, typeof kernel[name]]).toEqual([name, expect.stringMatching(/function|object/)]);
    }
  });

  it("the schedules entry exports the moved schedule engine (round 13 took it off the root)", () => {
    const schedules = require("../schedules/engine") as Record<string, unknown>;
    for (const name of ["buildRowSet", "planFieldEdit"]) expect([name, typeof schedules[name]]).toEqual([name, "function"]);
  });
});
