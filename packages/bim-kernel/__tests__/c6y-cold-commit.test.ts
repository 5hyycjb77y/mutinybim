/**
 * @jest-environment node
 *
 * Round 6 lane Y, part 2. A freshly loaded head now establishes "fully
 * derived" and "valid" in one pass that reads referenced elements by slot,
 * the topology index keeps those forward references (carried by
 * `NetworkIndex.after`), and view display reads annotation targets by slot,
 * worked out once per annotation and slot table. Every answer must equal the
 * separate passes and the plain-record reading.
 */
import {
  asElementId,
  canonicalJson,
  coldFacts,
  displayResolver,
  draftElements,
  elementSlots,
  elementValues,
  freezeElements,
  isFullyDerived,
  issuesOf,
  planCommit,
  plainElements,
  validateModel,
  type BimElement,
  type Command,
  type CommitDecision,
  type DisplayContext,
  type ModelState,
} from "../src";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { NetworkIndex, deriveNetwork, downstreamEndsOf, networkOf, registerColdFacts } from "../src/network";

const FT = 304.8;
const NOW = () => "2026-10-30T00:00:00.000Z";
const actor = { id: "c6y", name: "Lane Y", kind: "human" as const };
const XS = createFullBimModel(FULL_BIM_TIERS.XS);

function plainCopy(model: ModelState): ModelState {
  return structuredClone({ ...model, elements: plainElements(model.elements) });
}

function of<K extends BimElement["kind"]>(model: ModelState, kind: K): Array<Extract<BimElement, { kind: K }>> {
  return elementValues(model.elements).filter((el): el is Extract<BimElement, { kind: K }> => el.kind === kind);
}

function first<T>(items: readonly T[], what: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`the XS building has no ${what}`);
  return item;
}

/** XS with stored values edited directly, as a loaded head can hold them. */
function withEdits(model: ModelState, edit: (elements: Record<string, BimElement>) => void): ModelState {
  const copy = plainCopy(model);
  edit(copy.elements as Record<string, BimElement>);
  return copy;
}

const tap = first(of(XS, "tap"), "tap");
const tag = first(of(XS, "tag"), "tag");
const dimension = first(of(XS, "dimension"), "dimension");
const opening = first(of(XS, "opening"), "opening");
const sameHostTaps = of(XS, "tap").filter((t) => t.hostId === tap.hostId);

/** Heads that hold every kind of finding the cold pass reports, and one that is not fully derived. */
const HEADS: ReadonlyArray<[string, ModelState]> = [
  ["a valid head", plainCopy(XS)],
  ["a tap moved along its host without its position (not derived)", withEdits(XS, (els) => void (els[tap.id] = { ...tap, s: tap.s + 50 }))],
  ["a tag whose target is gone", withEdits(XS, (els) => void (els[tag.id] = { ...tag, targetId: asElementId("c6y-missing") }))],
  ["a dimension with one end gone and a moved opening", withEdits(XS, (els) => {
    els[dimension.id] = { ...dimension, bId: asElementId("c6y-missing") };
    els[opening.id] = { ...opening, offset: -5000 };
  })],
  ["two taps too close on one host", withEdits(XS, (els) => {
    const [a, b] = sameHostTaps;
    if (a && b) els[b.id] = { ...b, s: a.s + 1 };
  })],
];

describe("c6y cold pass: derived and valid in one walk", () => {
  it.each(HEADS)("on %s equals isFullyDerived and validateModel", (_name, head) => {
    const fused = coldFacts(plainCopy(head));
    expect(fused).not.toBeNull();
    registerColdFacts(() => null);
    try {
      const consistent = isFullyDerived(plainCopy(head));
      const issues = validateModel(plainCopy(head));
      expect(canonicalJson({ consistent: fused?.consistent, issues: fused?.issues })).toBe(canonicalJson({ consistent, issues }));
    } finally {
      registerColdFacts(coldFacts);
    }
  });

  it("finds something on the edited heads (the comparison above is not vacuous)", () => {
    const findings = HEADS.slice(1).map(([, head]) => {
      const facts = coldFacts(plainCopy(head));
      return (facts?.consistent === false ? 1 : 0) + (facts?.issues.length ?? 0);
    });
    expect(findings.every((n) => n > 0)).toBe(true);
  });

  it("reads no referenced element by id: hosts and targets come from the topology index's rows", () => {
    const head = plainCopy(XS);
    let reads = 0;
    let counting = false;
    const elements = new Proxy(head.elements, {
      get(target, key, receiver) {
        if (counting && typeof key === "string") reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const model: ModelState = { ...head, elements };
    elementSlots(model.elements);
    networkOf(model);
    counting = true;
    const facts = coldFacts(model);
    counting = false;
    expect(facts?.issues).toEqual([]);
    // Before: the derived check and validation each read every tap's host, opening's host and annotation's ends by id.
    const references = of(XS, "tap").length + of(XS, "opening").length + of(XS, "tag").length + 2 * of(XS, "dimension").length;
    expect(references).toBeGreaterThan(0);
    expect(reads).toBeLessThan(references / 4);
  });
});

function decision(d: CommitDecision): unknown {
  if (!d.ok) return { ok: false, error: d.error, conflict: d.conflict ?? null };
  return { ok: true, changeset: d.changeset, elements: plainElements(d.model.elements), connections: d.model.connections, issues: issuesOf(d.model) };
}

function commands(model: ModelState): Command[] {
  const wall = first(of(model, "wall"), "wall");
  const terminal = first(of(model, "terminal"), "terminal");
  const riser = first(of(model, "riser_segment"), "riser");
  const room = first(of(model, "room"), "room");
  return [
    { type: "slide_branch", tapId: tap.id, s: 5.5 * FT },
    { type: "move_wall", wallId: wall.id, delta: { x: FT, y: 0 } },
    { type: "set_terminal_cfm", terminalId: terminal.id, cfm: 432.1 },
    { type: "resize_riser", riserId: riser.riserId, profile: { shape: "round", diameter: 6 * 25.4 } },
    { type: "move_tag", tagId: tag.id, offset: { x: 600, y: 300 } },
    { type: "set_tag_text", tagId: tag.id, text: "C6Y" },
    { type: "create_level", levelId: "c6y-level", name: "C6Y", elevationMm: 9000 },
    { type: "delete_elements", ids: [room.id], policy: "cascade" },
  ];
}

describe("c6y first commit on a cold head", () => {
  it.each(HEADS)("on %s: every decision, changeset, committed record and open-issue list equals the separate passes", (_name, head) => {
    for (const [i, command] of commands(head).entries()) {
      const request = { idempotencyKey: `c6y-cold-${i}-key`, baseRevision: head.revision, actor, command };
      const fused = decision(planCommit(plainCopy(head), [], request, NOW));
      registerColdFacts(() => null);
      let separate: unknown;
      try {
        separate = decision(planCommit(plainCopy(head), [], request, NOW));
      } finally {
        registerColdFacts(coldFacts);
      }
      expect(canonicalJson(fused)).toBe(canonicalJson(separate));
    }
  });
});

describe("c6y topology index forward references", () => {
  function referenceRows(net: NetworkIndex, size: number): Array<[number, number]> {
    const rows: Array<[number, number]> = [];
    for (let s = 0; s < size; s++) rows.push([net.referencedSlot(s), net.referencedSlot(s, true)]);
    return rows;
  }

  it("are carried by NetworkIndex.after exactly as a fresh build has them", () => {
    const head = plainCopy(XS);
    networkOf(head);
    const otherDuct = first(of(XS, "duct_segment").filter((d) => d.id !== tap.hostId), "second duct");
    const otherTarget = first(of(XS, "terminal"), "terminal");
    const edits: ReadonlyArray<[string, (els: Record<string, BimElement>) => void, readonly string[]]> = [
      ["a tag pointed at another element", (els) => void (els[tag.id] = { ...tag, targetId: otherTarget.id }), [tag.id]],
      ["a dimension removed", (els) => void delete els[dimension.id], [dimension.id]],
      ["a tap re-hosted", (els) => void (els[tap.id] = { ...tap, hostId: otherDuct.id }), [tap.id]],
    ];
    let carried = 0;
    for (const [, edit, changed] of edits) {
      const draft = draftElements(head.elements);
      edit(draft);
      const to = freezeElements(draft);
      if (deriveNetwork(head.elements, to, head.connections, changed)) carried += 1;
      const size = elementSlots(to).size;
      expect(referenceRows(networkOf({ elements: to, connections: head.connections }), size)).toEqual(referenceRows(new NetworkIndex(head.connections, to), size));
    }
    expect(carried).toBeGreaterThan(0);
  });

  it("downstream ends by kind equal round 9's table (now from the Mechanical add-on's kind rows), and a kind this build doesn't know has none", () => {
    const round9: Readonly<Record<string, readonly string[]>> = { equipment: ["out"], duct_segment: ["end"], tap: ["branch"], elbow: ["out"], terminal: [], wall: [], part: [], run_segment: [] };
    for (const [kind, ends] of Object.entries(round9)) expect(downstreamEndsOf(kind)).toEqual(ends);
    expect(downstreamEndsOf("c6y_future_kind")).toEqual([]);
  });
});

describe("c6y view display: annotation targets by slot", () => {
  const ctx: DisplayContext = { phaseId: "phase-new", phaseFilterId: "pf-existing-demo", groupDisplay: { "grp-coordination": "hide" } };
  const reading = (model: ModelState): string => {
    const show = displayResolver(model, ctx);
    return canonicalJson(elementValues(model.elements).map((el) => [el.id, show(el)]));
  };

  it("looks each annotation's target up once per slot table, then reads it by slot on every later view and revision", () => {
    const head = plainCopy(XS);
    const frozen = freezeElements(head.elements);
    const model: ModelState = { ...head, elements: frozen };
    const slotOf = elementSlots(frozen).table.slotOf as Map<string, number>;
    let lookups = 0;
    const get = slotOf.get.bind(slotOf);
    Object.defineProperty(slotOf, "get", {
      configurable: true,
      value: (id: string) => {
        lookups += 1;
        return get(id);
      },
    });
    try {
      // The first view also builds the record's area index and organization, which look ids up once each.
      const firstView = reading(model);
      lookups = 0;
      expect(reading(model)).toBe(firstView);
      // Before: every tag and dimension end was looked up by id on every view.
      expect(lookups).toBe(0);
      // A later revision sharing the slot table: a draft that removes one tag's target.
      const draft = draftElements(frozen);
      delete draft[tag.targetId];
      const later: ModelState = { ...head, elements: draft };
      reading(later);
      lookups = 0;
      reading(later);
      // Only the draft's one pending removal is mapped to its slot.
      expect(lookups).toBe(1);
    } finally {
      Reflect.deleteProperty(slotOf, "get");
    }
  });

  it("answers as the plain record does on committed records, drafts with removed and rewritten targets, and plain records", () => {
    const head = plainCopy(XS);
    const frozen = freezeElements(head.elements);
    const draft = draftElements(frozen);
    delete draft[tag.targetId];
    const target = XS.elements[dimension.aId];
    if (target) draft[dimension.aId] = { ...target, groupId: "grp-coordination" } as BimElement;
    for (const elements of [frozen, draft]) {
      const model: ModelState = { ...head, elements };
      const viaPlain: ModelState = { ...head, elements: plainElements(elements) };
      expect(reading(model)).toBe(reading(viaPlain));
      expect(reading(model)).toBe(reading(viaPlain));
    }
  });
});
