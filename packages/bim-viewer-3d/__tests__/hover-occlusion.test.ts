/**
 * @jest-environment node
 *
 * Hover and grabs follow what the person sees (review video V1 2:03: pointing at a
 * pipe, "the little tool tips says duct but it's not a duct"). Before, hover
 * looked only at authored work, so pointing at the architect's pipe named and
 * grabbed the supply duct behind it.
 */
import { NORMAL_REFERENCE_TONE, type ReferenceTone } from "../src/reference-tone";
import { nativeHiddenByLinked } from "../src/hover-occlusion";

const receded: ReferenceTone = { ...NORMAL_REFERENCE_TONE, receded: true };
const linked = (distance: number) => ({ distance, linked: { referenceId: "arch" } });

describe("is our element hidden behind a linked model?", () => {
  it("the architect's pipe in front of our duct hides it", () => {
    expect(nativeHiddenByLinked(linked(4), 6, () => NORMAL_REFERENCE_TONE)).toBe(true);
  });
  it("a halftone or see-through linked model never hides our work", () => {
    expect(nativeHiddenByLinked(linked(4), 6, () => receded)).toBe(false);
  });
  it("our duct in front of the linked model stays ours, and so does one flush on its surface", () => {
    expect(nativeHiddenByLinked(linked(6), 4, () => NORMAL_REFERENCE_TONE)).toBe(false);
    expect(nativeHiddenByLinked(linked(4.999), 5, () => NORMAL_REFERENCE_TONE)).toBe(false);
  });
  it("nothing linked in front (or our own surface first): not hidden", () => {
    expect(nativeHiddenByLinked(null, 5, () => NORMAL_REFERENCE_TONE)).toBe(false);
    expect(nativeHiddenByLinked({ distance: 1, linked: null }, 5, () => NORMAL_REFERENCE_TONE)).toBe(false);
  });
});
