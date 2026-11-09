/**
 * @jest-environment node
 *
 * Round 14 P14: a wet vent (a level vent pipe that fixtures drain into) is
 * checked against the firm's wet vent table: too small for the drainage units
 * it carries is named, with Select (the pipes and the fixtures) and Fix (the
 * smallest size the table allows). With no table, or no row for its size, the
 * check says what to add and never guesses. A vent stack is not a wet vent.
 *
 * Fails on round 13: there was no wet vent check.
 */
import { DEFAULT_SETTINGS, planCommit, type Command, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import type { LookupTable } from "@permitzip/bim-kernel/policy";
import { WET_VENT_TABLE_SLOT, wetVentCheck, wetVentStretch } from "../src";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-11-04T12:00:00.000Z";
const VENT = { id: "sys-v", kind: "vent" as const, name: "Vent" };

function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `p14wv-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "rowan", name: "Rowan", kind: "human" }, command }, NOW, []);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const TABLE: LookupTable = {
  id: "firm-wet-vent",
  slot: WET_VENT_TABLE_SLOT,
  name: "Firm wet vent table",
  columns: [
    { key: "size_in", label: "Wet vent size", unit: "in" },
    { key: "max_dfu", label: "Most drainage units", unit: "DFU" },
  ],
  rows: [
    [2, 4],
    [3, 12],
  ],
  citation: { source: "Firm standard", section: "WV-1" },
};

/** A 2" level vent, 10 ft then 10 ft round a corner, with a 2 DFU and a 4 DFU fixture draining into its ends, and a vent stack rising off the corner. */
function build(): { m: ModelState; first: string; stack: string } {
  let m: ModelState = { modelId: "wv", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "route_run", idPrefix: "wv", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" }, elevationMm: 2 * FT, system: VENT, points: [{ x: 0, y: 0 }, { x: 10 * FT, y: 0 }, { x: 10 * FT, y: 10 * FT }] });
  const segs = Object.values(m.elements).filter((e): e is RunSegment => e.kind === "run_segment");
  const first = segs.find((s) => s.links.start === undefined);
  const last = segs.find((s) => s.links.end === undefined);
  if (!first || !last) throw new Error("no vent routed");
  m = commit(m, {
    type: "create_load",
    loads: [
      { id: "lav-1", anchor: { kind: "run_end", hostId: first.id, port: "start" }, values: { dfu: 2 }, mark: "LAV-1" },
      { id: "sink-1", anchor: { kind: "run_end", hostId: last.id, port: "end" }, values: { dfu: 4 }, mark: "SK-1" },
    ],
  });
  m = commit(m, { type: "route_run", idPrefix: "vs", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 2 * IN, material: "pvc" }, elevationMm: 2 * FT, system: VENT, points: [{ x: 20 * FT, y: 0 }, { x: 20 * FT, y: 0, elevationMm: 14 * FT }] });
  const stack = Object.values(m.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith("vs"));
  if (!stack) throw new Error("no stack");
  return { m, first: first.id, stack: stack.id };
}

describe("p14-wet-vent", () => {
  const { m, first, stack } = build();

  it("finds the level stretch and the drainage units that drain into it", () => {
    const s = wetVentStretch(m.elements, first);
    expect(s?.dfu).toBe(6);
    expect([...(s?.loadIds ?? [])].sort()).toEqual(["lav-1", "sink-1"]);
    expect(s?.segmentIds.length).toBe(2);
  });

  it("too small for 6 DFU on the firm's table, with Select and Fix", () => {
    const f = wetVentCheck(m, first, { firm: [TABLE] });
    if (f?.kind !== "too_small") throw new Error(`expected too_small, got ${f?.kind}`);
    expect(f.words).toBe('Wet vent too small for 6 DFU (2" takes 4 in Firm wet vent table)');
    expect(f.source).toBe("Firm standard WV-1");
    expect(f.selectIds).toEqual(expect.arrayContaining([first, "lav-1", "sink-1"]));
    expect(f.fix?.label).toBe('Make it 3"');
    const fixed = commit(m, f.fix?.command as Command);
    expect(wetVentCheck(fixed, first, { firm: [TABLE] })).toBeNull();
  });

  it("the project's table binds over the firm's", () => {
    const roomy: LookupTable = { ...TABLE, id: "proj", name: "Project wet vent table", rows: [[2, 8]] };
    expect(wetVentCheck(m, first, { firm: [TABLE], project: [roomy] })).toBeNull();
  });

  it("no table, or no row for its size: says what to add, never guesses", () => {
    expect(wetVentCheck(m, first, {})).toMatchObject({ kind: "no_table", words: "Can't check the wet vent for 6 DFU yet: add a wet vent table in Library › Lookup tables" });
    const no2 = { ...TABLE, rows: [[3, 12]] };
    expect(wetVentCheck(m, first, { firm: [no2] })).toMatchObject({ kind: "no_row" });
  });

  it("a vent stack is not a wet vent", () => {
    expect(wetVentStretch(m.elements, stack)).toBeNull();
    expect(wetVentCheck(m, stack, { firm: [TABLE] })).toBeNull();
  });
});
