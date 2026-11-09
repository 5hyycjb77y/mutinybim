/**
 * @jest-environment node
 *
 * Plumbing follow-ups (Nov 7): starter tag styles for drains on plans and
 * printed drawings, from the plumbing add-on's rows (no kernel code): "Drain
 * slope" (1/4"/FT along the pipe) and "Drain size, slope and inverts".
 * Annotate › Tag / Tag all offer them through Tag styles › Start from.
 *
 * Fails on the old code: the add-on offered no slope-only or invert tag.
 */
import { createTagStyleFromPreset, tagLines, tagStylePreset, tagStylePresets } from "@permitzip/bim-kernel";
import { toiletRoom } from "./p15-fixtures";

describe("drain slope and invert tags", () => {
  it("the plumbing add-on offers a slope tag and a size, slope and invert tag for pipe", () => {
    const ids = tagStylePresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["plumbing.drain_slope", "plumbing.drain_inverts"]));
    expect(tagStylePreset("plumbing.drain_slope")?.appliesTo).toEqual(["pipe"]);
    // The slope tag points downhill (the kernel's trade-neutral tag arrow, towards the run's lower end).
    expect(tagStylePreset("plumbing.drain_slope")?.arrow).toBe("down_slope");
    expect(createTagStyleFromPreset(tagStylePreset("plumbing.drain_slope")!, "ts", []).arrow).toBe("down_slope");
  });

  it("a tag in the slope style on a 4\" sanitary drain reads its fall; the invert style reads size, slope and both inverts", () => {
    const m = toiletRoom();
    const slope = tagStylePreset("plumbing.drain_slope");
    const inverts = tagStylePreset("plumbing.drain_inverts");
    if (!slope || !inverts) throw new Error("presets");
    m.ok(createTagStyleFromPreset(slope, "ts-slope", []));
    m.ok(createTagStyleFromPreset(inverts, "ts-inv", []));
    const slopeText = tagLines(m.head, { elementId: "san-s1", template: "auto", leader: false, styleId: "ts-slope" })
    expect(slopeText).toHaveLength(1);
    expect(slopeText?.[0]).toMatch(/\/FT/i);
    const inv = tagLines(m.head, { elementId: "san-s1", template: "auto", leader: false, styleId: "ts-inv" });
    expect(inv?.[0]).toMatch(/^4" @ /);
    expect(inv?.[1]).toMatch(/^IE .+ TO .+/);
  });
});
