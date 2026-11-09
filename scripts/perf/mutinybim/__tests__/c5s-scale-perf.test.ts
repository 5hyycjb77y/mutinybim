/**
 * @jest-environment node
 *
 * Round 5c f-scale: the 250k proof rows, one Jest file so a lane can measure
 * them through the shared run lock (`jest-file`) without the whole gate.
 * Each case prints `[c5s <row>] p50 … p95 …` (and the old path where it still
 * exists, as `before`); docs/perf/mutinybim-budgets.json holds the budgets. The expectations are
 * coarse ceilings so a loaded laptop doesn't fail them; the budgets are
 * enforced by the gate.
 *
 * C5S_PERF=1 runs it (it builds two 250k models and a 250k linked tower).
 */
import * as kernel from "@permitzip/bim-kernel";
import { applyChangeset, evaluateEquipmentSchedule, buildClassIndex, builtinRegistry, carryClassIndexes, draftElements, freezeElements, elementsOfKind, evaluateSchedule, executeCommand, planCommit, recomputeDerivedAfter, surfacesAt, asElementId, type ModelState } from "@permitzip/bim-kernel";
import { distributionEquipment, CONNECTED_LOAD_ONLY, ElectricalLoadEngine } from "@permitzip/bim-pack-electrical";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, type ExtensionPoint } from "@permitzip/bim-kernel/packs";
import * as calc from "@permitzip/bim-calc";
import * as lint from "@permitzip/bim-lint";
import { LintEngine } from "@permitzip/bim-lint";
import { SPATIAL_FIELD_PROVIDER } from "../../../../packages/bim-kernel/src/fields/providers/spatial";
import { networkOf } from "../../../../packages/bim-kernel/src/network";
import { FIRST_PARTY_ADDONS as FIRST_PARTY_PACKS } from "@permitzip/bim-first-party";
import { createSynthetic250k, p50p95, syntheticLinkedTower } from "../synthetic-250k";

const run = process.env.C5S_PERF === "1" ? describe : describe.skip;

function report(row: string, samples: readonly number[], extra = ""): { p50: number; p95: number } {
  const s = p50p95(samples);
  process.stderr.write(`[c5s ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
  return s;
}

function isExtensionPoint(v: unknown): v is ExtensionPoint<unknown> {
  if (typeof v !== "object" || v === null) return false;
  const id: unknown = Reflect.get(v, "id");
  return typeof id === "string" && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(id) && typeof Reflect.get(v, "version") === "number" && typeof Reflect.get(v, "label") === "string";
}

run("c5s scale rows (250k)", () => {
  const syn = createSynthetic250k();
  const head = syn.model;

  it("kernel.class_index.one_edit.250k: one part moved, then every recognizable class read", () => {
    const registry = builtinRegistry();
    const classes = registry.listClasses().filter((c) => c.recognize).map((c) => c.id);
    const readAll = (m: ModelState) => {
      const index = buildClassIndex(registry, m);
      let n = 0;
      for (const c of classes) n += index.elementsOf(c).length;
      return n;
    };
    const total = readAll(head);
    const edit = (m: ModelState, i: number) => {
      const r = executeCommand(m, { type: "move_elements", ids: [syn.partIds[i % syn.partIds.length] ?? ""], delta: { x: i % 2 === 0 ? 300 : -300, y: 0 } });
      if (!r.ok) throw new Error(r.error.message);
      return r;
    };
    const after: number[] = [];
    let m = head;
    for (let i = 0; i < 12; i++) {
      const r = edit(m, i);
      const t0 = performance.now();
      carryClassIndexes(m.elements, r.model.elements, [...r.changedIds, ...r.removedIds]);
      const n = readAll(r.model);
      if (i > 0) after.push(performance.now() - t0);
      expect(n).toBe(total);
      m = r.model;
    }
    const before: number[] = [];
    m = head;
    for (let i = 0; i < 6; i++) {
      const r = edit(m, i);
      // The command core now carries the index, so the old path is a record nothing indexed (same content, new identity).
      const uncarried: ModelState = { ...r.model, elements: freezeElements(draftElements(r.model.elements)) };
      const t0 = performance.now();
      readAll(uncarried);
      if (i > 0) before.push(performance.now() - t0);
      m = r.model;
    }
    const b = p50p95(before);
    const a = report("kernel.class_index.one_edit.250k", after, `before (index rebuilt for the new record) p50 ${b.p50} / p95 ${b.p95} ms; ${classes.length} classes, ${total} memberships`);
    expect(a.p50).toBeLessThan(b.p50);
  });

  it("surfaces_at.250k: 1,000 asks across a 250k linked tower, the source re-read per ask", () => {
    const tower = syntheticLinkedTower();
    const points = Array.from({ length: 1_000 }, (_, i) => ({ x: ((i * 37) % 500) * 304.8, y: ((i * 53) % 400) * 304.8 }));
    const level = asElementId(syn.levelIds[0] ?? "lvl-01");
    surfacesAt(head, { point: points[0] ?? { x: 0, y: 0 }, levelId: level }, [{ ...tower, revision: "r1" }]);
    const samples: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (const p of points) surfacesAt(head, { point: p, levelId: level }, [{ ...tower, revision: "r1" }]);
      samples.push(performance.now() - t0);
    }
    const regrid: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      surfacesAt(head, { point: points[k] ?? { x: 0, y: 0 }, levelId: level }, [{ ...tower }]);
      regrid.push(performance.now() - t0);
    }
    const r = p50p95(regrid);
    report("surfaces_at.250k", samples, `before (a re-read source gridded per ask) ${r.p50} ms per ask, x1,000 = ${Math.round(r.p50 * 1000)} ms`);
  });

  it("derived.topology_edit.250k: one terminal removed, derived values after it", () => {
    const terminals = elementsOfKind(head.elements, "terminal");
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t = terminals[(i * 977) % terminals.length];
      if (!t) continue;
      const w = draftElements(head.elements);
      delete w[t.id];
      const t0 = performance.now();
      const out = recomputeDerivedAfter(head, w, [t.id]);
      if (i > 0) samples.push(performance.now() - t0);
      expect(out.changedIds.length).toBeGreaterThan(0);
    }
    const index: number[] = [];
    for (let i = 0; i < 3; i++) {
      const w = draftElements(head.elements);
      const t = terminals[i + 1];
      if (t) delete w[t.id];
      const t0 = performance.now();
      networkOf({ ...head, elements: w });
      index.push(performance.now() - t0);
    }
    report("derived.topology_edit.250k", samples, `${terminals.length} terminals; a full rebuild of the new revision's network index alone would take ${p50p95(index).p50} ms`);
  });

  it("lint.level_edit.250k: a level raised, the coordination index advanced", () => {
    const engine = new LintEngine();
    const t0 = performance.now();
    engine.build(head, []);
    const buildMs = performance.now() - t0;
    let m = head;
    const level = syn.levelIds[3] ?? "lvl-04";
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = executeCommand(m, { type: "update_level", levelId: level, elevationMm: (3 * 14 + (i % 2 === 0 ? 1 : 0)) * 304.8 });
      if (!r.ok) throw new Error(r.error.message);
      const t1 = performance.now();
      engine.advance(r.model, [...r.changedIds, ...r.removedIds]);
      samples.push(performance.now() - t1);
      m = r.model;
    }
    report("lint.level_edit.250k", samples, `cold build ${Math.round(buildMs)} ms`);
  });

  it("schedules.v1.first_read.250k and electrical.distribution.first_read.250k: the first read of a new revision", () => {
    const schedule: number[] = [];
    const distribution: number[] = [];
    let m = head;
    for (let i = 0; i < 9; i++) {
      const r = executeCommand(m, { type: "move_elements", ids: [syn.partIds[i] ?? ""], delta: { x: 300, y: 0 } });
      if (!r.ok) throw new Error(r.error.message);
      const t0 = performance.now();
      const rows = evaluateSchedule(r.model, { category: "mechanical_equipment", columns: [{ field: "mark" }] }).rows.length;
      const t1 = performance.now();
      const panels = new ElectricalLoadEngine(CONNECTED_LOAD_ONLY).distribution(r.model).length;
      const t2 = performance.now();
      if (i > 0) {
        schedule.push(t1 - t0);
        distribution.push(t2 - t1);
      }
      expect(rows).toBeGreaterThan(0);
      expect(panels).toBeGreaterThan(0);
      m = r.model;
    }
    report("schedules.v1.first_read.250k", schedule, "Mechanical equipment schedule, mark column");
    report("electrical.distribution.first_read.250k", distribution, "distribution list, fresh engine");
  });

  it("fields.level_members.first_read.250k: a level's members, first read of a new revision", () => {
    const resolve = SPATIAL_FIELD_PROVIDER.resolvers?.level_members;
    if (!resolve) throw new Error("level_members resolver missing");
    const levelId = syn.levelIds[0] ?? "lvl-01";
    const samples: number[] = [];
    let m = head;
    let members = 0;
    for (let i = 0; i < 4; i++) {
      const r = executeCommand(m, { type: "move_elements", ids: [syn.partIds[i] ?? ""], delta: { x: 300, y: 0 } });
      if (!r.ok) throw new Error(r.error.message);
      const level = r.model.elements[levelId];
      if (!level) throw new Error("synthetic level missing");
      const t0 = performance.now();
      members = resolve(level, { elements: r.model.elements }).length;
      if (i > 0) samples.push(performance.now() - t0);
      m = r.model;
    }
    expect(members).toBeGreaterThan(1_000);
    report("fields.level_members.first_read.250k", samples, `${members} members of ${levelId}`);
  });

  it("sync.apply.first_read.250k: a remote part move applied, then the class index, topology and a level's members read", () => {
    const registry = builtinRegistry();
    const classes = registry.listClasses().filter((c) => c.recognize).map((c) => c.id);
    const levelMembers = SPATIAL_FIELD_PROVIDER.resolvers?.level_members;
    if (!levelMembers) throw new Error("level_members resolver missing");
    const levelId = syn.levelIds[0] ?? "lvl-01";
    const read = (m: ModelState) => {
      const index = buildClassIndex(registry, m);
      for (const c of classes) index.elementsOf(c);
      networkOf(m);
      const level = m.elements[levelId];
      if (level) levelMembers(level, { elements: m.elements });
    };
    let server = head;
    let browser = head;
    read(browser);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = planCommit(server, [], { idempotencyKey: `c5s-sync-${i}`, baseRevision: server.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command: { type: "move_elements", ids: [syn.partIds[i] ?? ""], delta: { x: 300, y: 0 } } });
      if (!d.ok) throw new Error(d.error.message);
      server = d.model;
      const t0 = performance.now();
      browser = applyChangeset(browser, d.changeset);
      read(browser);
      if (i > 0) samples.push(performance.now() - t0);
    }
    report("sync.apply.first_read.250k", samples, `${classes.length} classes, topology, ${levelId} members`);
  });

  it("electrical.distribution_equipment.250k and sheet.equipment_schedule.250k: two first reads of a new revision", () => {
    const panels: number[] = [];
    const schedule: number[] = [];
    let m = head;
    for (let i = 0; i < 7; i++) {
      const r = executeCommand(m, { type: "move_elements", ids: [syn.partIds[i] ?? ""], delta: { x: 300, y: 0 } });
      if (!r.ok) throw new Error(r.error.message);
      const t0 = performance.now();
      const found = distributionEquipment(r.model.elements).length;
      const t1 = performance.now();
      const rows = evaluateEquipmentSchedule(r.model).length;
      const t2 = performance.now();
      if (i > 0) {
        panels.push(t1 - t0);
        schedule.push(t2 - t1);
      }
      expect(found).toBeGreaterThan(0);
      expect(rows).toBeGreaterThan(0);
      m = r.model;
    }
    report("electrical.distribution_equipment.250k", panels, "every panelboard, switchboard and transformer, by name");
    report("sheet.equipment_schedule.250k", schedule, "the v1 sheet's equipment and terminal rows");
  });

  it("organization.group_phase_command.250k: delete a group that has members, delete a phase in use, after an element edit", () => {
    // Committed heads, as the model server holds them (planCommit carries the indexes onto each).
    let n = 0;
    const run = (m: ModelState, command: Parameters<typeof planCommit>[2]["command"]) => {
      n += 1;
      const d = planCommit(m, [], { idempotencyKey: `c5s-org-${n}`, baseRevision: m.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command });
      if (!d.ok) throw new Error(d.error.message);
      return d.model;
    };
    let m = run(head, { type: "create_group", groupId: "perf-grp", name: "Perf group" });
    m = run(m, { type: "create_phase", phaseId: "perf-ph", name: "Perf phase" });
    m = run(m, { type: "assign_elements_to_group", ids: syn.partIds.slice(0, 200), groupId: "perf-grp" });
    m = run(m, { type: "set_element_phases", ids: syn.partIds.slice(0, 200), phaseCreated: "perf-ph" });
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      m = run(m, { type: "move_elements", ids: [syn.partIds[300 + i] ?? ""], delta: { x: 300, y: 0 } });
      const t0 = performance.now();
      const g = executeCommand(m, { type: "delete_group", groupId: "perf-grp" });
      const p = executeCommand(m, { type: "delete_phase", phaseId: "perf-ph" });
      if (i > 0) samples.push(performance.now() - t0);
      expect(g.ok).toBe(false);
      expect(p.ok).toBe(false);
    }
    report("organization.group_phase_command.250k", samples, "both refused: 200 members");
  });

  it("kernel.packs.resolve: first-party packs plus two stubs, built and every point read", () => {
    const points = [...(Object.values(kernel) as unknown[]), ...(Object.values(lint) as unknown[]), ...(Object.values(calc) as unknown[])].filter(isExtensionPoint);
    const tools = points.find((p) => p.id === "kernel.agent_tool");
    const stub = (id: string) =>
      definePack({ id, name: `Stub ${id}`, version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, tools ? [contribute(tools, [{ name: `${id}_read`, title: "Read", description: "A stub read.", input: { type: "object", properties: {} }, permission: "read", target: { kind: "read", read: `${id}.read` } }])] : []);
    const firstParty = FIRST_PARTY_PACKS;
    const samples: number[] = [];
    let items = 0;
    for (let i = 0; i < 25; i++) {
      const packs = [...firstParty, stub(`stub_a${i}`), stub(`stub_b${i}`)];
      const t0 = performance.now();
      const set = PackSet.create(packs);
      items = 0;
      for (const p of points) items += set.items(p).length;
      samples.push(performance.now() - t0);
    }
    report("kernel.packs.resolve", samples, `${points.length} points, ${items} items, ${firstParty.length} first-party packs + 2 stubs`);
  });
});
