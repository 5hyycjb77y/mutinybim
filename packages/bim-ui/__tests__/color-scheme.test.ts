/**
 * @jest-environment node
 */
import {
  baseThemeFor,
  contrastRatio,
  createMemoryColorSchemeAdapter,
  isMutinyColorScheme,
  mergeTheme,
  mutinyDarkTheme,
  mutinyDefaultTheme,
  resolveColorScheme,
  themeContrastProblems,
  themeProblems,
  themeToCssVars,
} from "../src";

describe("MutinyBIM colour scheme", () => {
  it("resolves system from the OS, and light / dark as picked", () => {
    expect(resolveColorScheme("system", true)).toBe("dark");
    expect(resolveColorScheme("system", false)).toBe("light");
    expect(resolveColorScheme("light", true)).toBe("light");
    expect(resolveColorScheme("dark", false)).toBe("dark");
  });

  it("accepts only light, dark and system", () => {
    expect(["light", "dark", "system"].every(isMutinyColorScheme)).toBe(true);
    expect(isMutinyColorScheme("")).toBe(false);
    expect(isMutinyColorScheme("auto")).toBe(false);
    expect(isMutinyColorScheme(undefined)).toBe(false);
  });

  it("the default adapter remembers the pick for the page and tells subscribers, without browser storage", () => {
    const adapter = createMemoryColorSchemeAdapter();
    expect(adapter.get()).toBe("system");
    const heard: string[] = [];
    const unsubscribe = adapter.subscribe?.((s) => heard.push(s));
    adapter.set("dark");
    expect(adapter.get()).toBe("dark");
    unsubscribe?.();
    adapter.set("light");
    expect(heard).toEqual(["dark"]);
  });

  it("dark is a full Mutiny token set with the same shape and brand as light", () => {
    expect(baseThemeFor("dark")).toBe(mutinyDarkTheme);
    expect(baseThemeFor("light")).toBe(mutinyDefaultTheme);
    expect(Object.keys(mutinyDarkTheme.colors).sort()).toEqual(Object.keys(mutinyDefaultTheme.colors).sort());
    expect(Object.keys(mutinyDarkTheme.viewer).sort()).toEqual(Object.keys(mutinyDefaultTheme.viewer).sort());
    expect(mutinyDarkTheme.colors.accent).toBe(mutinyDefaultTheme.colors.accent);
    expect(mutinyDarkTheme.brand).toEqual(mutinyDefaultTheme.brand);
    expect(themeProblems(mutinyDarkTheme)).toEqual([]);
    expect(Object.keys(themeToCssVars(mutinyDarkTheme))).toEqual(Object.keys(themeToCssVars(mutinyDefaultTheme)));
  });
});

describe("MutinyBIM contrast (WCAG 2.1 AA)", () => {
  it("measures contrast like WCAG", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("hsl(0 0% 0%)", "#FFFFFF")).toBeNull();
  });

  it.each([
    ["light", mutinyDefaultTheme],
    ["dark", mutinyDarkTheme],
  ])("the %s theme passes AA for text and controls, and selection reads on white paper", (_name, theme) => {
    expect(themeContrastProblems(theme)).toEqual([]);
  });

  it("names a pair that fails, with the ratio and the colors", () => {
    const bad = mergeTheme(mutinyDarkTheme, { colors: { muted: "#3A3D35" } });
    const problems = themeContrastProblems(bad);
    expect(problems.some((p) => p.startsWith("muted on panel:") && p.includes("needs 4.5:1") && p.includes("#3A3D35"))).toBe(true);
  });

  it("light outlines a 3D selection at 3:1 or more, because the lime fill alone barely shows on the light model background", () => {
    const { viewer } = mutinyDefaultTheme;
    expect(contrastRatio(viewer.selection, viewer.background) ?? 0).toBeLessThan(1.5);
    expect(contrastRatio(viewer.selectionOutline, viewer.background) ?? 0).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(viewer.selectionOutline, viewer.planBackground) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("light never uses lime as text: secondary text and selection labels pass AA on every light surface", () => {
    const { colors } = mutinyDefaultTheme;
    expect(contrastRatio(colors.accent, colors.surface) ?? 0).toBeLessThan(3);
    for (const bg of [colors.surface, colors.panel, colors.field, colors.subtle, colors.accentSubtle]) {
      expect(contrastRatio(colors.muted, bg) ?? 0).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.selection, bg) ?? 0).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("dark keeps on-screen selection strokes visible on sheets, which stay white", () => {
    const ratio = contrastRatio(mutinyDarkTheme.colors.selection, "#FFFFFF");
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeGreaterThanOrEqual(3);
  });
});
