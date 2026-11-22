/**
 * @jest-environment node
 *
 * The generated reference (docs/reference/) and llms.txt match the code. A
 * change to the kit, a command schema, a calc, a pack read, an add-on or a
 * tool fails here until `npm run docs` is run and its output committed.
 */
import { staleDocs } from "../write-docs";

describe("docs-current", () => {
  it("docs/reference and llms.txt are what the code generates", async () => {
    const { changed, extra } = await staleDocs();
    // Stale: run `npm run docs` and commit the result.
    expect({ changed, extra }).toEqual({ changed: [], extra: [] });
    // It loads every package and lists every tool: slow on a shared runner.
  }, 120_000);
});
