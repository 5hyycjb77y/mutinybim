/**
 * @jest-environment node
 */
import { mergeTheme, mutinyDarkTheme, mutinyDefaultTheme, themeStyleSheet, themeToCssVars } from "../src";

describe("themeStyleSheet", () => {
  it("writes light on the root, dark for the dark scheme, and dark for system when the computer is dark", () => {
    const css = themeStyleSheet();
    const lines = css.split("\n");
    expect(lines[0]).toMatch(/^:root\{/);
    expect(lines[1]).toMatch(/^:root\[data-mutiny-scheme="dark"\]\{/);
    expect(lines[2]).toMatch(/^@media \(prefers-color-scheme: dark\)\{:root\[data-mutiny-scheme="system"\]\{/);

    const light = themeToCssVars(mutinyDefaultTheme);
    const dark = themeToCssVars(mutinyDarkTheme);
    for (const [name, value] of Object.entries(light)) expect(lines[0]).toContain(`${name}:${value.replace(/[;{}<]/g, "")};`);
    for (const [name, value] of Object.entries(dark)) expect(lines[1]).toContain(`${name}:${value.replace(/[;{}<]/g, "")};`);
  });

  it("uses the selector it is given", () => {
    expect(themeStyleSheet({ selector: "html" })).toMatch(/^html\{/);
  });

  it("cannot be used to break out of the style tag", () => {
    const hostile = mergeTheme(mutinyDefaultTheme, { radius: "x;}</style><script>alert(1)</script>" });
    const css = themeStyleSheet({ light: hostile });
    expect(css).not.toContain("</style");
    expect(css).not.toContain("<script");
  });
});
