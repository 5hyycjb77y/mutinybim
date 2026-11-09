/**
 * @jest-environment node
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MUTINY_PALETTE, mergeTheme, mutinyDefaultTheme, themeProblems, themeToCssVars, wordmarkSvg } from "../src";

describe("MutinyBIM theme", () => {
  it("defaults to neutral whites and grays with charcoal text and an electric lime accent", () => {
    const { colors, viewer } = mutinyDefaultTheme;
    expect(colors.surface).toBe("#FBFBFB");
    expect(colors.panel).toBe("#F2F3F4");
    expect(colors.field).toBe("#FFFFFF");
    expect(colors.border).toBe("#DDE1E4");
    expect(colors.text).toBe("#182126");
    expect(colors.muted).toBe("#626C73");
    expect(colors.accent).toBe("#D7E620");
    expect(colors.accentForeground).toBe(colors.text);
    expect(colors.accentSubtle).toBe("#F2F6D4");
    expect(viewer.selection).toBe(MUTINY_PALETTE.lime);
    expect(viewer.planBackground).toBe("#FFFFFF");
    // No cream left in the light app; it stays in the logo artwork and the dark theme.
    const light = [...Object.values(colors), ...Object.values(viewer)].map((c) => c.toUpperCase());
    for (const beige of [MUTINY_PALETTE.cream, "#F2ECDC", "#FFFCF4", "#EFE8D6", "#DCD4BF"]) expect(light).not.toContain(beige);
    expect(mutinyDefaultTheme.brand.productName).toBe("MutinyBIM");
    expect(themeProblems(mutinyDefaultTheme)).toEqual([]);
  });

  it("writes every color, viewer color, font and the radius as --mutiny-* variables", () => {
    const vars = themeToCssVars(mutinyDefaultTheme);
    expect(vars["--mutiny-surface"]).toBe("#FBFBFB");
    expect(vars["--mutiny-accent-foreground"]).toBe("#182126");
    expect(vars["--mutiny-accent-subtle"]).toBe("#F2F6D4");
    expect(vars["--mutiny-viewer-selection-outline"]).toBe("#5C6B00");
    expect(vars["--mutiny-viewer-background"]).toBe(mutinyDefaultTheme.viewer.background);
    expect(vars["--mutiny-viewer-axis-x"]).toBe(mutinyDefaultTheme.viewer.axisX);
    expect(vars["--mutiny-font-heading"]).toContain("Slab");
    expect(vars["--mutiny-radius"]).toBe("0.375rem");
    expect(Object.keys(vars).every((k) => k.startsWith("--mutiny-"))).toBe(true);
    const colorCount = Object.keys(mutinyDefaultTheme.colors).length + Object.keys(mutinyDefaultTheme.viewer).length;
    expect(Object.keys(vars)).toHaveLength(colorCount + 5);
  });

  it("merges overrides slot by slot and keeps everything else", () => {
    const merged = mergeTheme(mutinyDefaultTheme, { colors: { accent: "#123456" }, viewer: { selection: "#654321" }, brand: { logoUrl: "/logo.png" } });
    expect(merged.colors.accent).toBe("#123456");
    expect(merged.colors.surface).toBe(mutinyDefaultTheme.colors.surface);
    expect(merged.viewer.selection).toBe("#654321");
    expect(merged.viewer.edges).toBe(mutinyDefaultTheme.viewer.edges);
    expect(merged.brand).toEqual({ productName: "MutinyBIM", logoUrl: "/logo.png" });
    expect(mergeTheme(mutinyDefaultTheme, undefined)).toBe(mutinyDefaultTheme);
  });

  it("names a viewer color that isn't #rrggbb, because the 3D view can't parse it", () => {
    const bad = mergeTheme(mutinyDefaultTheme, { viewer: { background: "hsl(1 2% 3%)" as `#${string}` } });
    expect(themeProblems(bad)).toEqual(['Viewer color "background" must be a #rrggbb color, got "hsl(1 2% 3%)".']);
  });

  it("ships a vector wordmark file identical to the built-in geometry", () => {
    const file = readFileSync(path.join(__dirname, "../assets/mutiny-wordmark.svg"), "utf8");
    expect(file).toBe(wordmarkSvg());
  });
});
