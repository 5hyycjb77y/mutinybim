import { mutinyDarkTheme } from "./color-scheme";
import { mutinyDefaultTheme, themeToCssVars, type MutinyTheme } from "./theme";

/**
 * The MutinyBIM theme as a stylesheet, for pages drawn without the React
 * provider (server-rendered pages, static sites). The element matching
 * `selector` carries `data-mutiny-scheme="light" | "dark" | "system"`;
 * `system` follows the operating system. Same `--mutiny-*` variables the
 * provider sets, so every vendored primitive reads them unchanged.
 */
export function themeStyleSheet(options: { readonly selector?: string; readonly light?: MutinyTheme; readonly dark?: MutinyTheme } = {}): string {
  const selector = options.selector ?? ":root";
  const block = (theme: MutinyTheme) =>
    Object.entries(themeToCssVars(theme))
      .map(([name, value]) => `${name}:${value.replace(/[;{}<]/g, "")};`)
      .join("");
  const light = block(options.light ?? mutinyDefaultTheme);
  const dark = block(options.dark ?? mutinyDarkTheme);
  return [
    `${selector}{${light}color-scheme:light;}`,
    `${selector}[data-mutiny-scheme="dark"]{${dark}color-scheme:dark;}`,
    `@media (prefers-color-scheme: dark){${selector}[data-mutiny-scheme="system"]{${dark}color-scheme:dark;}}`,
  ].join("\n");
}
