import { fillTemplate, parseFieldTemplate, type TemplatePart } from "../src";

function fill(template: string, values: Record<string, string>): { text: string; any: boolean; missing: readonly string[] } {
  const parsed = parseFieldTemplate(template);
  if (!parsed.ok) throw new Error(parsed.error);
  return fillTemplate(parsed.parts as TemplatePart[], (p) => values[p] ?? "");
}

describe("field templates", () => {
  it("parses fields, literal text and optional groups", () => {
    const parsed = parseFieldTemplate("{feeder.source.name}[ via {feeder.breaker}][ via {feeder.type}]");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields).toEqual(["feeder.source.name", "feeder.breaker", "feeder.type"]);
    expect(parsed.parts.map((p) => p.kind)).toEqual(["field", "group", "group"]);
  });

  it("prints a group only when every field in it has a value", () => {
    const t = "{feeder.source.name}[ via {feeder.breaker}][ via {feeder.type}]";
    expect(fill(t, { "feeder.source.name": "MDP", "feeder.breaker": "225A/3P", "feeder.type": "F225" }).text).toBe("MDP via 225A/3P via F225");
    expect(fill(t, { "feeder.source.name": "MDP", "feeder.breaker": "225A/3P" }).text).toBe("MDP via 225A/3P");
    expect(fill(t, { "feeder.source.name": "T1" }).text).toBe("T1");
  });

  it("nested groups decide for themselves", () => {
    const t = "{a}[ ({b}[, {c}])]";
    expect(fill(t, { a: "A", b: "B", c: "C" }).text).toBe("A (B, C)");
    expect(fill(t, { a: "A", b: "B" }).text).toBe("A (B)");
    expect(fill(t, { a: "A", c: "C" }).text).toBe("A");
  });

  it("reports whether any field had a value (a tag line with none is left out)", () => {
    expect(fill("CKT {circuit}", {}).any).toBe(false);
    expect(fill("CKT {circuit}", { circuit: "L1-3" })).toEqual({ text: "CKT L1-3", any: true, missing: [] });
    expect(fill("SEE PLAN", {}).any).toBe(true);
    expect(fill("[{a}]", {}).any).toBe(false);
  });

  it("a field with no value drops the text glued to its right; a fallback prints instead", () => {
    expect(fill("{bus_rating}A BUS {mains_text}", { mains_text: "MLO" }).text).toBe(" BUS MLO");
    expect(fill("{bus_rating}A BUS {mains_text}", { bus_rating: "225", mains_text: "MLO" }).text).toBe("225A BUS MLO");
    expect(fill("{enclosure|NEMA 1}", {}).text).toBe("NEMA 1");
    expect(fill("[ via {feeder.type|TBD}]", {}).text).toBe(" via TBD");
    expect(fill("FED FROM {supply.text}[ ({feeder.type})]", {}).missing).toEqual(["supply.text", "feeder.type"]);
  });

  it("escapes braces and brackets", () => {
    expect(fill("\\[{a}\\] \\{x\\} \\\\", { a: "1" }).text).toBe("[1] {x} \\");
  });

  it.each([
    ["{circuit", "A { has no closing }"],
    ["circuit}", "A } has no opening {"],
    ["{}", "Empty {}"],
    ["{panel name}", "is not a field name"],
    ["{9lives}", "is not a field name"],
    ["[ via {a}", "A [ has no closing ]"],
    ["{a}]", "A ] has no opening ["],
    ["\\x", "A backslash escapes"],
  ])("refuses %s in plain words", (t, message) => {
    const parsed = parseFieldTemplate(t);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("refuses an over-long template", () => {
    const parsed = parseFieldTemplate("x".repeat(401));
    expect(parsed.ok).toBe(false);
  });
});
