/**
 * @jest-environment node
 *
 * Nov 8 showcase: the panel recipe sent people to a search for "circuit"
 * that found only the recipe itself (a circuit is a service link, and no
 * command is named for circuits). Every pointer a recipe gives now leads
 * somewhere: each `command: "…"` is a command a script can send, with the
 * fields the recipe uses, and each `search: "…"` finds more than the recipe.
 */
import { KIT_RECIPES, commandFields, scriptCommands, searchReference } from "../src";

const pointers = (step: string, key: "command" | "search") => [...step.matchAll(new RegExp(`${key}: "([^"]+)"`, "g"))].map((m) => m[1] ?? "");

describe("kit recipes point at things that exist", () => {
  const commands = new Set(scriptCommands().map((c) => c.type));

  it.each(KIT_RECIPES.map((r) => [r.name, r] as const))("%s", (_name, recipe) => {
    for (const step of recipe.steps) {
      for (const type of pointers(step, "command")) expect(commands.has(type) ? type : `missing command ${type}`).toBe(type);
      for (const q of pointers(step, "search")) expect(searchReference(q).filter((h) => h.name !== recipe.name).length).toBeGreaterThan(0);
    }
  });

  it("the panel recipe names the circuit command and the fields it sends", () => {
    const panel = KIT_RECIPES.find((r) => r.name === "Electrical panel and panel schedule");
    const step = panel?.steps.find((s) => s.includes("each circuit")) ?? "";
    expect(pointers(step, "command")).toEqual(["create_service_link"]);
    const fields = commandFields("create_service_link")?.fields.join("\n") ?? "";
    for (const f of ["sourceId", "positions", "members", "electrical"]) expect(fields).toMatch(new RegExp(`^${f}\\??:`, "m"));
  });
});
