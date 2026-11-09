import type { DerivedZoneRegion, DerivedZoneRuleDef, ZonePurposeDef } from "@permitzip/bim-kernel/spaces";
import type { BimElement, ModelState } from "@permitzip/bim-kernel/types";
import { frameOf, type Frame, type FrameBeam, type FrameDeck } from "./frame";
import { tributaryStrips, type TributaryStrip } from "./tributary";

/**
 * Tributary areas as derived zones: a beam's strip of each deck it carries,
 * computed on read from the deck's span direction and the neighbouring
 * beams, never stored. Accepting one as a zone stores only
 * `{ kind: "derived", hostId: <beam>, rule: "struct.tributary" }`.
 */

export const TRIBUTARY_RULE_ID = "struct.tributary";
export const TRIBUTARY_PURPOSE: ZonePurposeDef = { id: "struct.tributary", label: "Tributary area" };

const byFrame = new WeakMap<Frame, Map<string, ReadonlyMap<string, TributaryStrip>>>();

/** Every carrying beam's strip on a deck, computed once per frame read. */
export function deckStrips(frame: Frame, deck: FrameDeck): ReadonlyMap<string, TributaryStrip> {
  let perDeck = byFrame.get(frame);
  if (!perDeck) {
    perDeck = new Map();
    byFrame.set(frame, perDeck);
  }
  const hit = perDeck.get(deck.id);
  if (hit) return hit;
  const strips = tributaryStrips(deck, frame.beamsByLevel.get(deck.levelId) ?? []);
  perDeck.set(deck.id, strips);
  return strips;
}

/** A beam's strips, one per deck it carries (usually one; a beam under two decks has two). */
export function beamStrips(frame: Frame, beam: Pick<FrameBeam, "id" | "levelId">): TributaryStrip[] {
  const out: TributaryStrip[] = [];
  for (const deck of frame.decksByLevel.get(beam.levelId) ?? []) {
    const s = deckStrips(frame, deck).get(beam.id);
    if (s) out.push(s);
  }
  return out;
}

function beamOf(frame: Frame, host: BimElement): FrameBeam | null {
  if (host.kind !== "beam") return null;
  const b = frame.byId.get(host.id);
  return b && "sectionName" in b && "startZMm" in b ? b : null;
}

function derive(model: ModelState, host: BimElement): DerivedZoneRegion[] {
  const frame = frameOf(model);
  const beam = beamOf(frame, host);
  if (!beam) return [];
  const z = Math.max(beam.startZMm, beam.endZMm);
  return beamStrips(frame, beam).map((s) => {
    const xs = s.outline.map((v) => v.x);
    const ys = s.outline.map((v) => v.y);
    return {
      hostId: host.id,
      rule: TRIBUTARY_RULE_ID,
      clearanceId: s.deckId,
      name: `Tributary area of ${beam.label}`,
      cite: null,
      levelId: beam.levelId,
      outline: s.outline,
      centre: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
      bottomMm: z,
      topMm: z,
      floorMm: z,
    };
  });
}

/**
 * What a beam's strips depend on besides the beam itself: its level, every
 * deck on that level and the beams either side of it on each. A moved
 * neighbour, a new beam between, or a turned deck changes one of these
 * records, so the strip is recomputed; anything else reuses it.
 */
function dependsOn(model: ModelState, host: BimElement): readonly unknown[] {
  const frame = frameOf(model);
  const beam = beamOf(frame, host);
  if (!beam) return [model.elements[host.id]];
  const deps: unknown[] = [model.elements[beam.levelId]];
  for (const deck of frame.decksByLevel.get(beam.levelId) ?? []) {
    const s = deckStrips(frame, deck).get(beam.id);
    deps.push(model.elements[deck.id], s?.previousId ? model.elements[s.previousId] : null, s?.nextId ? model.elements[s.nextId] : null);
  }
  return deps;
}

export const TRIBUTARY_RULE: DerivedZoneRuleDef = {
  id: TRIBUTARY_RULE_ID,
  label: "Tributary area",
  ifcPredefinedType: "USERDEFINED",
  derive,
  dependsOn,
};
