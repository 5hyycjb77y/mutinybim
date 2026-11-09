import type { PartConnector, PartTypeDefinition } from "@permitzip/bim-kernel";

/** Round 9 J9 test pieces. */
export const IN = 25.4;

export type End = Partial<Pick<PartConnector, "shape" | "diameter" | "width" | "height" | "endType" | "systemKind" | "domain">>;

/** A straight piece 300 mm long: opening `a` on its west face, `b` on its east face. */
export function straightPiece(typeName: string, end: End = {}): PartTypeDefinition {
  const opening = (id: "a" | "b"): PartConnector => ({
    id,
    label: id === "a" ? "In" : "Out",
    domain: end.domain ?? "duct",
    systemKind: end.systemKind ?? "supply_air",
    position: [id === "a" ? -150 : 150, 0, 0],
    direction: [id === "a" ? -1 : 1, 0, 0],
    shape: end.shape ?? "round",
    ...(end.shape === "rect" ? { width: end.width ?? 12 * IN, height: end.height ?? 10 * IN } : { diameter: end.diameter ?? 12 * IN }),
    ...(end.endType !== undefined ? { endType: end.endType } : {}),
  });
  return {
    familyName: "J9 straight",
    typeName,
    category: "generic",
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    connectors: [opening("a"), opening("b")],
    geometry: [{ kind: "box", center: [0, 0, 0], size: [300, 300, 300] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [300, 300] }],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "j9" },
  };
}

