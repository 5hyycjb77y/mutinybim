/**
 * @jest-environment node
 *
 * Groups and phases: defaults for models made before they existed, the
 * commands (with undo, conflicts and attribution through the real commit
 * path), locked groups refusing every edit, and how views draw by group and
 * phase filter.
 */
import {
  BUILTIN_PART_TYPES,
  DEFAULT_GROUP_ID,
  DEFAULT_PHASE_ID,
  PHASE_DASH,
  applyChangeset,
  buildViewScene,
  canonicalJson,
  displayResolver,
  executeCommand,
  groupIdOf,
  ifcOrganizationProperties,
  matchHints,
  organizationHintsFromRevit,
  organizationOf,
  phaseCreatedOf,
  phaseStatusAt,
  planCommit,
  type BimElement,
  type Changeset,
  type Command,
  type ModelState,
  type Primitive,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const NOW = () => "2026-10-20T00:00:00.000Z";

interface Person {
  readonly id: string;
  readonly name: string;
}
const AVERY: Person = { id: "avery", name: "Avery" };
const PRIYA: Person = { id: "priya", name: "Priya" };

let counter = 0;

class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(who: Person, command: Command, base: number = this.head.revision) {
    counter += 1;
    const req = { idempotencyKey: `${who.id}-${counter}`, baseRevision: base, actor: { id: who.id, name: who.name, kind: "human" as const }, command, clientSessionId: `tab-${who.id}` };
    const decision = planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(who: Person, command: Command, base?: number): Changeset {
    const d = this.submit(who, command, base);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(who: Person, command: Command, base?: number) {
    const d = this.submit(who, command, base);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error;
  }
  el(id: string): BimElement {
    const found = this.head.elements[id];
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
}

const DIFFUSER = BUILTIN_PART_TYPES.find((t) => t.definition.category === "air_terminal");
if (!DIFFUSER) throw new Error("starter library has no air terminal");

type Line = Extract<Primitive, { kind: "line" }>;
const lines = (prims: readonly Primitive[]): Line[] => prims.filter((p): p is Line => p.kind === "line");

function withPlan(): Model {
  const m = new Model(createDemoModel());
  m.ok(AVERY, { type: "create_view", viewId: "v-plan", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "L1", detailLevel: "coarse", visualStyle: "wireframe" } });
  return m;
}

describe("defaults and existing models", () => {
  it("a model made before groups and phases reads with the built-in lists, everything in General and New construction", () => {
    const model = createDemoModel();
    const org = organizationOf(model);
    expect(org.groups.map((g) => g.entry.name)).toEqual(["General", "Existing to remain", "New work", "Demolition", "Coordination"]);
    expect(org.phases.map((p) => p.entry.name)).toEqual(["Existing", "New construction"]);
    expect(org.filters.map((f) => f.entry.name)).toEqual(["Show all", "Show new", "Show existing + demo", "Show complete"]);
    expect(org.activeGroupId).toBe(DEFAULT_GROUP_ID);
    expect(org.activePhaseId).toBe(DEFAULT_PHASE_ID);
    for (const el of Object.values(model.elements)) {
      expect(el.groupId).toBeUndefined();
      expect(groupIdOf(org, el)).toBe(DEFAULT_GROUP_ID);
      expect(phaseCreatedOf(org, el)).toBe(DEFAULT_PHASE_ID);
    }
    // Nothing changes on screen for an existing model: every element shows in ink.
    const show = displayResolver(model, {});
    expect(Object.values(model.elements).every((el) => show(el).visible && !show(el).halftone && !show(el).dashed)).toBe(true);
  });

  it("renaming a built-in group stores it under the same id, and undo puts the default back", () => {
    const m = new Model(createDemoModel());
    const cs = m.ok(AVERY, { type: "update_group", groupId: "grp-new", name: "New ductwork" });
    expect(organizationOf(m.head).groupById.get("grp-new")?.entry.name).toBe("New ductwork");
    expect(cs.actor.name).toBe("Avery");
    m.ok(AVERY, { type: "undo", revision: cs.revision });
    expect(organizationOf(m.head).groupById.get("grp-new")?.entry.name).toBe("New work");
    expect(organizationOf(m.head).groupById.get("grp-new")?.builtIn).toBe(true);
  });
});

describe("groups", () => {
  it("create, assign (as a selection), and undo the assignment", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "create_group", groupId: "grp-hvac-a", name: "HVAC phase A", color: "#22c55e" });
    expect(m.refused(AVERY, { type: "create_group", groupId: "grp-x", name: "hvac phase a" }).message).toMatch(/already a group named "HVAC phase A"/);
    const assign = m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk", "ahu-1"], groupId: "grp-hvac-a" });
    expect(m.el("seg-trunk").groupId).toBe("grp-hvac-a");
    expect(m.el("ahu-1").groupId).toBe("grp-hvac-a");
    expect(assign.authored.map((a) => a.field)).toEqual(["org.groupId", "org.groupId"]);
    m.ok(AVERY, { type: "undo", revision: assign.revision });
    expect(m.el("seg-trunk").groupId).toBeUndefined();
  });

  it("views, sheets and annotations have no group", () => {
    const m = withPlan();
    expect(m.refused(AVERY, { type: "assign_elements_to_group", ids: ["v-plan"], groupId: "grp-new" }).message).toMatch(/A view has no group or phase/);
  });

  it("delete refuses while elements are in it, moves them when asked, and General can't be deleted", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-coordination" });
    expect(m.refused(AVERY, { type: "delete_group", groupId: "grp-coordination" }).message).toBe('1 element is in "Coordination". Choose a group to move it to, then delete.');
    const preview = executeCommand(m.head, { type: "delete_group", groupId: "grp-coordination", moveTo: "grp-new" });
    expect(preview.ok && preview.summary).toContain('1 element moved to "New work"');
    const del = m.ok(AVERY, { type: "delete_group", groupId: "grp-coordination", moveTo: "grp-new" });
    expect(m.el("seg-trunk").groupId).toBe("grp-new");
    expect(organizationOf(m.head).groupById.has("grp-coordination")).toBe(false);
    expect(m.refused(AVERY, { type: "delete_group", groupId: DEFAULT_GROUP_ID }).message).toMatch(/can't be deleted. Rename it instead/);
    // Undo brings the group back with its id.
    m.ok(AVERY, { type: "undo", revision: del.revision });
    expect(organizationOf(m.head).groupById.has("grp-coordination")).toBe(true);
    expect(m.el("seg-trunk").groupId).toBe("grp-coordination");
  });

  it("new elements go in the active group and phase", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    m.ok(AVERY, { type: "set_active_group", groupId: "grp-new" });
    m.ok(AVERY, { type: "set_active_phase", phaseId: "phase-existing" });
    m.ok(AVERY, { type: "place_part", partId: "p-1", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 1000, y: 2000 }, offsetMm: 2743, values: {} });
    expect(m.el("p-1").groupId).toBe("grp-new");
    expect(m.el("p-1").phaseCreated).toBe("phase-existing");
    // Levels and types belong to no group.
    expect(m.el("lvl-1").groupId).toBeUndefined();
  });

  it("a later conflicting assignment by someone else conflicts instead of silently winning", () => {
    const m = new Model(createDemoModel());
    const base = m.head.revision;
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-new" });
    const err = m.refused(PRIYA, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-demolition" }, base);
    expect(err.code).toBe("conflict");
    expect(m.el("seg-trunk").groupId).toBe("grp-new");
  });

  it("undo of a group creation is refused once elements use the group", () => {
    const m = new Model(createDemoModel());
    const created = m.ok(AVERY, { type: "create_group", groupId: "grp-temp", name: "Temporary" });
    m.ok(PRIYA, { type: "assign_elements_to_group", ids: ["ahu-1"], groupId: "grp-temp" });
    expect(m.refused(AVERY, { type: "undo", revision: created.revision }).message).toMatch(/now uses the group, phase or filter this change added/);
  });
});

describe("locked groups refuse edits, with a plain reason", () => {
  function locked(): Model {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-existing" });
    const preview = executeCommand(m.head, { type: "lock_group", groupId: "grp-existing", locked: true });
    expect(preview.ok && preview.summary?.[0]).toMatch(/is locked/);
    m.ok(AVERY, { type: "lock_group", groupId: "grp-existing", locked: true });
    return m;
  }

  it("resizing a locked run is refused and nothing changes", () => {
    const m = locked();
    const before = m.el("seg-trunk");
    const err = m.refused(PRIYA, { type: "resize_run", segmentId: "seg-trunk", profile: { shape: "rect", width: 600, height: 400 } });
    expect(err.code).toBe("locked");
    expect(err.message).toBe('This duct is in the locked group "Existing to remain", so it can\'t be changed. Unlock the group first (Manage › Groups & phases).');
    expect(m.el("seg-trunk")).toBe(before);
  });

  it("moving equipment that would push a locked run is refused", () => {
    const m = locked();
    expect(m.refused(PRIYA, { type: "move_equipment", equipmentId: "ahu-1", delta: { x: 0, y: 300 } }).code).toBe("locked");
  });

  it("taking elements out, demolishing them, or deleting them is refused; unlocking allows it again", () => {
    const m = locked();
    expect(m.refused(PRIYA, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-new" }).code).toBe("locked");
    expect(m.refused(PRIYA, { type: "demolish_elements", ids: ["seg-trunk"] }).code).toBe("locked");
    expect(m.refused(PRIYA, { type: "delete_elements", ids: ["seg-trunk"], policy: "cascade" }).code).toBe("locked");
    expect(m.refused(PRIYA, { type: "set_active_group", groupId: "grp-existing" }).message).toMatch(/is locked, so new elements can't go in it/);
    m.ok(AVERY, { type: "lock_group", groupId: "grp-existing", locked: false });
    m.ok(PRIYA, { type: "demolish_elements", ids: ["seg-trunk"] });
  });

  it("undo of your own edit is refused once its group is locked", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-existing" });
    const resize = m.ok(PRIYA, { type: "resize_run", segmentId: "seg-trunk", profile: { shape: "rect", width: 600, height: 400 } });
    m.ok(AVERY, { type: "lock_group", groupId: "grp-existing", locked: true });
    expect(m.refused(PRIYA, { type: "undo", revision: resize.revision }).code).toBe("locked");
  });
});

describe("phases", () => {
  it("add, rename and reorder phases; elements keep their phases", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "create_phase", phaseId: "phase-demo", name: "Demolition", after: "phase-existing" });
    expect(organizationOf(m.head).phases.map((p) => p.entry.name)).toEqual(["Existing", "Demolition", "New construction"]);
    m.ok(AVERY, { type: "update_phase", phaseId: "phase-demo", name: "Demo", after: null });
    expect(organizationOf(m.head).phases.map((p) => p.entry.name)).toEqual(["Demo", "Existing", "New construction"]);
  });

  it("demolish and un-demolish; demolishing before creation is refused", () => {
    const m = new Model(createDemoModel());
    expect(m.refused(AVERY, { type: "demolish_elements", ids: ["seg-trunk"], phaseId: "phase-existing" }).message).toBe(
      'It can\'t be demolished in "Existing": it is created in "New construction", which comes later.',
    );
    m.ok(AVERY, { type: "set_element_phases", ids: ["seg-trunk"], phaseCreated: "phase-existing" });
    m.ok(AVERY, { type: "demolish_elements", ids: ["seg-trunk"] });
    expect(m.el("seg-trunk").phaseDemolished).toBe(DEFAULT_PHASE_ID);
    const org = organizationOf(m.head);
    expect(phaseStatusAt(org, m.el("seg-trunk"), 1)).toBe("demolished");
    expect(phaseStatusAt(org, m.el("seg-trunk"), 0)).toBe("new");
    expect(phaseStatusAt(org, m.el("ahu-1"), 0)).toBe("future");
    m.ok(AVERY, { type: "undemolish_elements", ids: ["seg-trunk"] });
    expect(m.el("seg-trunk").phaseDemolished).toBeUndefined();
  });

  it("a phase in use, a view's phase, the default phase and the last phase can't be deleted", () => {
    const m = withPlan();
    m.ok(AVERY, { type: "create_phase", phaseId: "phase-2", name: "Phase 2" });
    m.ok(AVERY, { type: "set_element_phases", ids: ["ahu-1"], phaseCreated: "phase-2" });
    expect(m.refused(AVERY, { type: "delete_phase", phaseId: "phase-2" }).message).toBe('1 element is created or demolished in "Phase 2". Move them to another phase first.');
    m.ok(AVERY, { type: "set_element_phases", ids: ["ahu-1"], phaseCreated: DEFAULT_PHASE_ID });
    m.ok(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { phaseId: "phase-2" } });
    expect(m.refused(AVERY, { type: "delete_phase", phaseId: "phase-2" }).message).toMatch(/1 view shows "Phase 2" \(Level 1 Mechanical\)/);
    expect(m.refused(AVERY, { type: "delete_phase", phaseId: DEFAULT_PHASE_ID }).message).toMatch(/Rename it instead/);
  });

  it("moving a phase so something is demolished before it is created is refused", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "set_element_phases", ids: ["seg-trunk"], phaseCreated: "phase-existing", phaseDemolished: DEFAULT_PHASE_ID });
    expect(m.refused(AVERY, { type: "update_phase", phaseId: DEFAULT_PHASE_ID, after: null }).message).toMatch(/would put 1 element demolished before it is created/);
  });
});

describe("phase filters and view display", () => {
  function demolishedTrunk(): Model {
    const m = withPlan();
    m.ok(AVERY, { type: "set_element_phases", ids: ["seg-trunk"], phaseCreated: "phase-existing", phaseDemolished: DEFAULT_PHASE_ID });
    return m;
  }

  it("resolves the four statuses through the built-in filters", () => {
    const m = demolishedTrunk();
    m.ok(AVERY, { type: "set_element_phases", ids: ["ahu-1"], phaseCreated: "phase-existing" });
    const trunk = m.el("seg-trunk");
    const ahu = m.el("ahu-1");
    const terminal = Object.values(m.head.elements).find((e) => e.kind === "terminal");
    if (!terminal) throw new Error("demo model has no terminal");
    const all = displayResolver(m.head, { phaseFilterId: "pf-all" });
    expect(all(trunk)).toEqual({ visible: true, halftone: false, dashed: true });
    expect(all(ahu)).toEqual({ visible: true, halftone: true, dashed: false });
    expect(all(terminal)).toEqual({ visible: true, halftone: false, dashed: false });
    const existingDemo = displayResolver(m.head, { phaseFilterId: "pf-existing-demo" });
    expect(existingDemo(terminal).visible).toBe(false);
    expect(existingDemo(trunk).dashed).toBe(true);
    const complete = displayResolver(m.head, { phaseFilterId: "pf-complete" });
    expect(complete(trunk).visible).toBe(false);
    // As of Existing, the new terminal is in the future and does not draw.
    expect(displayResolver(m.head, { phaseId: "phase-existing" })(terminal).visible).toBe(false);
  });

  it("filters are editable: demolished can be made to hide", () => {
    const m = demolishedTrunk();
    m.ok(AVERY, { type: "update_phase_filter", filterId: "pf-all", statuses: { demolished: "hide" } });
    expect(displayResolver(m.head, {})(m.el("seg-trunk")).visible).toBe(false);
    m.ok(AVERY, { type: "create_phase_filter", filterId: "pf-ghost", name: "Ghost everything", statuses: { new: "halftone", existing: "halftone", demolished: "halftone", temporary: "halftone" } });
    expect(displayResolver(m.head, { phaseFilterId: "pf-ghost" })(m.el("ahu-1")).halftone).toBe(true);
  });

  it("a view refuses a phase or filter that doesn't exist", () => {
    const m = withPlan();
    expect(m.refused(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { phaseFilterId: "pf-nope" } }).message).toMatch(/There is no phase filter "pf-nope"/);
    expect(m.refused(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { groupDisplay: { "grp-nope": "hide" } } }).message).toMatch(/There is no group "grp-nope"/);
  });

  it("the plan drawing dashes a demolished duct in 'Show existing + demo' and drops new work", () => {
    const m = demolishedTrunk();
    const solidBefore = lines(buildViewScene(m.head, "v-plan").scene.primitives);
    m.ok(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { phaseFilterId: "pf-existing-demo" } });
    const after = lines(buildViewScene(m.head, "v-plan").scene.primitives);
    const dashed = after.filter((l) => l.dash === PHASE_DASH || (l.dash && canonicalJson(l.dash) === canonicalJson(PHASE_DASH)));
    expect(dashed.length).toBeGreaterThan(0);
    // The branches and terminals are new work: hidden here, so fewer lines overall.
    expect(after.length).toBeLessThan(solidBefore.length);
  });

  it("a hidden group draws nothing; a halftone group prints halftone", () => {
    const m = withPlan();
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-coordination" });
    const all = lines(buildViewScene(m.head, "v-plan").scene.primitives);
    m.ok(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { groupDisplay: { "grp-coordination": "hide" } } });
    const hidden = lines(buildViewScene(m.head, "v-plan").scene.primitives);
    expect(hidden.length).toBeLessThan(all.length);
    m.ok(AVERY, { type: "set_view_properties", viewId: "v-plan", props: { groupDisplay: { "grp-coordination": "halftone" } } });
    const halftone = lines(buildViewScene(m.head, "v-plan").scene.primitives);
    expect(halftone.length).toBe(all.length);
    expect(halftone.filter((l) => l.tone === "halftone").length).toBeGreaterThan(all.filter((l) => l.tone === "halftone").length);
  });
});

describe("interop", () => {
  it("maps an element's group and phases to what an IFC exporter writes", () => {
    const m = new Model(createDemoModel());
    m.ok(AVERY, { type: "assign_elements_to_group", ids: ["seg-trunk"], groupId: "grp-existing" });
    m.ok(AVERY, { type: "set_element_phases", ids: ["seg-trunk"], phaseCreated: "phase-existing", phaseDemolished: DEFAULT_PHASE_ID });
    expect(ifcOrganizationProperties(m.head, m.el("seg-trunk"))).toEqual({
      group: { name: "Existing to remain", description: "Existing work that stays." },
      propertySet: { name: "MutinyBIM_Organization", properties: { Group: "Existing to remain", "Phase Created": "Existing", "Phase Demolished": "New construction" } },
    });
  });

  it("reads a Revit element's workset and phases as hints and matches them by name", () => {
    const hints = organizationHintsFromRevit([
      { name: "Workset", storage: "Integer", display: "Coordination" },
      { name: "Phase Created", storage: "ElementId", display: "Existing" },
      { name: "Phase Demolished", storage: "ElementId", display: "None" },
    ]);
    expect(hints).toEqual({ workset: "Coordination", phaseCreated: "Existing", phaseDemolished: null });
    expect(matchHints(createDemoModel(), hints)).toEqual({ groupId: "grp-coordination", phaseCreated: "phase-existing", phaseDemolished: null });
  });
});
