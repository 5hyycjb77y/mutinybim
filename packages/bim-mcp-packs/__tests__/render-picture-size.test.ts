/**
 * @jest-environment node
 *
 * A picture's answer carries the PNG once, as MCP image content, and never
 * again as text; and a picture is 1,280 px on its long side unless the agent
 * asks for more (at 1,600 px one drawing was 100,000 to 177,000 characters of
 * base64 kept in the agent's context). Fails on the code before: the default
 * was 1,600 and a scaled-down picture didn't say to zoom.
 */
import { imageResult, scaledWords } from "../src/drawings/render";
import { RENDER_DEFAULT_DPI, RENDER_DEFAULT_MAX_PX, RENDER_MAX_PX } from "../src/support/render-image";

describe("render-picture-size", () => {
  it("the picture is image content, once; the text part holds only the numbers", () => {
    const png = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const result = imageResult({ status: "drawn", revision: 7 }, { png });
    expect(result.content).toHaveLength(2);
    const [first, image] = result.content;
    expect(image).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    expect(first?.type).toBe("text");
    const words = first?.type === "text" ? first.text : "";
    expect(JSON.parse(words)).toEqual({ status: "drawn", revision: 7 });
    expect(words).not.toContain(png.toString("base64").slice(0, 64));
  });

  it("the default size is about a megapixel, and a larger one is still there to ask for", () => {
    expect(RENDER_DEFAULT_MAX_PX).toBeLessThanOrEqual(1280);
    expect(RENDER_DEFAULT_MAX_PX).toBeGreaterThanOrEqual(1024);
    expect(RENDER_MAX_PX).toBeGreaterThanOrEqual(4000);
  });

  it("a picture drawn below the resolution asked for says to zoom; one at full resolution says nothing", () => {
    expect(scaledWords({ dpi: 35.6 }, RENDER_DEFAULT_DPI)).toContain("zoom with a region or raise max_px");
    expect(scaledWords({ dpi: RENDER_DEFAULT_DPI }, RENDER_DEFAULT_DPI)).toBe("");
  });
});
