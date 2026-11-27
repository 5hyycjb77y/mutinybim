import { qty, type UnitFor } from "@permitzip/bim-units";
import type { GradingSurface, SurfaceRole, TinFace, TinVertex } from "./surfaces";

/**
 * LandXML 1.2 TIN import (Pnts + Faces only).
 *
 * A point's text is northing, easting, elevation, in that order, in the
 * file's linear unit. Faces are three point ids. Other surface kinds (a
 * grid, a series of contours) are skipped with a note.
 *
 * US survey feet are not a bim-units length. They are converted to metres at
 * the defined ratio 1200/3937 and stored as metres, and the note says so.
 * The international foot (`foot` in the file, `ft` here) is a different length.
 */

/** 1 US survey foot in metres, exactly. */
export const US_SURVEY_FOOT_METRES = 1200 / 3937;

/** How many triangles one surface may carry. Keeps the surface sized for a site TIN. */
export const MAX_TIN_FACES = 8000;

/** How many vertices one surface may carry alongside `MAX_TIN_FACES`. */
export const MAX_TIN_POINTS = 16000;

/** Maximum XML element nesting depth allowed during LandXML parsing. */
export const MAX_XML_DEPTH = 64;

const LINEAR_UNITS: ReadonlyMap<string, UnitFor<"length"> | "ussurveyfoot"> = new Map([
  ["millimeter", "mm"],
  ["centimeter", "cm"],
  ["meter", "m"],
  ["kilometer", "km"],
  ["foot", "ft"],
  ["ussurveyfoot", "ussurveyfoot"],
  ["inch", "in"],
  ["mile", "mi"],
]);

export interface LandXmlOptions {
  /** Role by surface name. Wins over the name. Exact match, then case-insensitive. */
  readonly roles?: Readonly<Record<string, SurfaceRole>>;
}

export interface LandXmlImport {
  readonly surfaces: readonly GradingSurface[];
  /** Why a surface or the file could not be used. The command imports nothing when this is non-empty. */
  readonly problems: readonly string[];
  /** Conversions and skipped parts. The surfaces were still read. */
  readonly notes: readonly string[];
}

interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

class LandXmlReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandXmlReadError";
  }
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    if (ent.startsWith("#x")) return String.fromCodePoint(Number.parseInt(ent.slice(2), 16));
    if (ent.startsWith("#")) return String.fromCodePoint(Number.parseInt(ent.slice(1), 10));
    return all;
  });
}

function parseXml(source: string): XmlNode {
  const s = source.replace(/^\uFEFF/, "");
  let i = 0;
  const fail = (message: string): never => {
    const line = s.slice(0, i).split("\n").length;
    throw new LandXmlReadError(`${message} (line ${line}).`);
  };
  const skipWs = (): void => {
    while (i < s.length && /\s/.test(s.charAt(i))) i += 1;
  };
  const skipMisc = (): void => {
    for (;;) {
      skipWs();
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        if (end < 0) fail("A comment never closes");
        i = end + 3;
        continue;
      }
      if (s.startsWith("<?", i)) {
        const end = s.indexOf("?>", i + 2);
        if (end < 0) fail("The XML declaration never closes");
        i = end + 2;
        continue;
      }
      if (s.startsWith("<!DOCTYPE", i) || s.startsWith("<!doctype", i)) fail("This file has a document type declaration. Save it as plain LandXML and import it again");
      if (s.startsWith("<!", i)) {
        const end = s.indexOf(">", i + 2);
        if (end < 0) fail("A declaration never closes");
        i = end + 1;
        continue;
      }
      return;
    }
  };
  const readName = (): string => {
    const start = i;
    if (i >= s.length || !/[A-Za-z_:]/.test(s.charAt(i))) fail("Expected a name");
    i += 1;
    while (i < s.length && /[A-Za-z0-9._:-]/.test(s.charAt(i))) i += 1;
    return s.slice(start, i);
  };
  const readAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (i >= s.length) fail("A tag runs off the end of the file");
      const c = s.charAt(i);
      if (c === ">" || c === "/") return attrs;
      const name = localName(readName());
      skipWs();
      if (s.charAt(i) !== "=") fail(`Attribute ${name} has no value`);
      i += 1;
      skipWs();
      const quote = s.charAt(i);
      if (quote !== '"' && quote !== "'") fail(`Attribute ${name} needs quotes`);
      i += 1;
      const start = i;
      while (i < s.length && s.charAt(i) !== quote) i += 1;
      if (i >= s.length) fail(`Attribute ${name} never closes`);
      attrs[name] = decodeEntities(s.slice(start, i));
      i += 1;
    }
  };
  const parseElement = (depth: number): XmlNode => {
    if (depth > MAX_XML_DEPTH) fail(`This XML file is nested more than ${MAX_XML_DEPTH} levels deep`);
    skipMisc();
    if (s.charAt(i) !== "<" || s.startsWith("</", i)) fail("Expected an element");
    i += 1;
    const name = localName(readName());
    const attrs = readAttrs();
    skipWs();
    if (s.startsWith("/>", i)) {
      i += 2;
      return { name, attrs, children: [], text: "" };
    }
    if (s.charAt(i) !== ">") fail(`<${name}> never closes`);
    i += 1;
    let text = "";
    const children: XmlNode[] = [];
    for (;;) {
      if (i >= s.length) fail(`<${name}> never closes`);
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        if (end < 0) fail("A comment never closes");
        i = end + 3;
        continue;
      }
      if (s.startsWith("<?", i)) {
        const end = s.indexOf("?>", i + 2);
        if (end < 0) fail("The XML declaration never closes");
        i = end + 2;
        continue;
      }
      if (s.startsWith("</", i)) {
        i += 2;
        const close = localName(readName());
        skipWs();
        if (s.charAt(i) !== ">") fail(`</${close}> never closes`);
        i += 1;
        if (close !== name) fail(`<${name}> was closed with </${close}>`);
        return { name, attrs, children, text: decodeEntities(text).trim() };
      }
      if (s.charAt(i) === "<") {
        children.push(parseElement(depth + 1));
        continue;
      }
      const start = i;
      while (i < s.length && s.charAt(i) !== "<") i += 1;
      text += s.slice(start, i);
    }
  };
  skipMisc();
  if (i >= s.length || s.charAt(i) !== "<") fail("This isn't a LandXML file. Save the surface as LandXML 1.2 and import it again");
  const root = parseElement(0);
  skipMisc();
  if (i < s.length) fail("There's more than one top-level element");
  return root;
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function inferRole(name: string): SurfaceRole {
  const n = name.toLowerCase();
  if (/\b(existing|exist|original)\b/.test(n) || /\beg\b/.test(n)) return "existing";
  if (/\b(proposed|proposal|finish|finished|design)\b/.test(n) || /\bfg\b/.test(n)) return "proposed";
  return "unassigned";
}

function roleFor(name: string, roles: Readonly<Record<string, SurfaceRole>> | undefined): SurfaceRole {
  if (!roles) return inferRole(name);
  const exact = roles[name];
  if (exact) return exact;
  const key = Object.keys(roles).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (roles[key] ?? inferRole(name)) : inferRole(name);
}

function linearToken(units: XmlNode): string | null {
  if (units.attrs.linearUnit) return units.attrs.linearUnit;
  for (const child of units.children) if (child.attrs.linearUnit) return child.attrs.linearUnit;
  return null;
}

interface FileUnit {
  readonly linearUnit: UnitFor<"length">;
  readonly sourceLinearUnit: string;
  readonly note: string | null;
  /** True when the file's foot is the US survey foot, already converted into `linearUnit` metres. */
  readonly surveyFoot: boolean;
}

function fileUnit(token: string): FileUnit | string {
  const mapped = LINEAR_UNITS.get(token.toLowerCase());
  if (!mapped) return `"${token}" isn't a LandXML length this import knows (meter, foot, USSurveyFoot, and the other 1.2 length units).`;
  if (mapped === "ussurveyfoot") {
    return {
      linearUnit: "m",
      sourceLinearUnit: token,
      surveyFoot: true,
      note: `Lengths in ${token} were stored as metres (1 US survey foot = 1200/3937 m). The international foot is a different length, so they were not stored as feet.`,
    };
  }
  return { linearUnit: mapped, sourceLinearUnit: token, surveyFoot: false, note: null };
}

function numbersOf(text: string): number[] | null {
  if (text.trim() === "") return null;
  const parts = text.trim().split(/\s+/);
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "surface";
}

function planArea(points: readonly TinVertex[], faces: readonly TinFace[]): number {
  let area = 0;
  for (const face of faces) {
    const a = points[face.a];
    const b = points[face.b];
    const c = points[face.c];
    if (!a || !b || !c) continue;
    const ax = a.easting;
    const ay = a.northing;
    const bx = b.easting;
    const by = b.northing;
    const cx = c.easting;
    const cy = c.northing;
    // Quantities are SI metres, so this area is square metres. Zero means the triangle stands on edge or repeats a point.
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5;
  }
  return area;
}

function readSurface(node: XmlNode, unit: FileUnit, roles: LandXmlOptions["roles"], taken: Set<string>, problems: string[], notes: string[]): GradingSurface | null {
  const name = node.attrs.name?.trim() || "Surface";
  const definitions = childrenNamed(node, "Definition");
  if (definitions.length === 0) {
    problems.push(`${name} has no Definition. A TIN needs Pnts and Faces.`);
    return null;
  }
  const tin = definitions.find((def) => (def.attrs.surfType ?? "TIN") === "TIN");
  const skipped = definitions.filter((def) => def.attrs.surfType !== undefined && def.attrs.surfType !== "TIN");
  for (const def of skipped) notes.push(`${name} has a ${def.attrs.surfType} definition. This import reads TIN surfaces (Pnts and Faces) only, so that definition was skipped.`);
  if (!tin) {
    problems.push(`${name} has no TIN definition. This import reads Pnts and Faces.`);
    return null;
  }
  if (definitions.filter((def) => (def.attrs.surfType ?? "TIN") === "TIN").length > 1) notes.push(`${name} has more than one TIN definition. The first one was imported.`);
  const pnts = childrenNamed(tin, "Pnts")[0];
  const facesNode = childrenNamed(tin, "Faces")[0];
  if (!pnts || !facesNode) {
    problems.push(`${name} needs both Pnts and Faces.`);
    return null;
  }
  const pointNodes = childrenNamed(pnts, "P");
  const faceNodes = childrenNamed(facesNode, "F");
  if (pointNodes.length < 3) {
    problems.push(`${name} needs at least three points.`);
    return null;
  }
  if (pointNodes.length > MAX_TIN_POINTS) {
    problems.push(`${name} has ${pointNodes.length} points. Keep each site TIN surface under ${MAX_TIN_POINTS} points.`);
    return null;
  }
  if (faceNodes.length < 1) {
    problems.push(`${name} needs at least one triangle.`);
    return null;
  }
  if (faceNodes.length > MAX_TIN_FACES) {
    problems.push(`${name} has ${faceNodes.length} triangles. Keep each site TIN surface under ${MAX_TIN_FACES} triangles.`);
    return null;
  }
  const byId = new Map<string, number>();
  const points: TinVertex[] = [];
  const scale = unit.surveyFoot ? US_SURVEY_FOOT_METRES : 1;
  for (const [index, p] of pointNodes.entries()) {
    const id = p.attrs.id?.trim() ?? "";
    if (id === "") {
      problems.push(`${name}: point ${index + 1} has no id.`);
      return null;
    }
    if (byId.has(id)) {
      problems.push(`${name} uses the point id ${id} twice.`);
      return null;
    }
    const nums = numbersOf(p.text);
    if (!nums || nums.length !== 3) {
      problems.push(`${name}: point ${id} should be northing, easting and elevation. It says "${p.text}".`);
      return null;
    }
    const northing = nums[0]! * scale;
    const easting = nums[1]! * scale;
    const elevation = nums[2]! * scale;
    byId.set(id, points.length);
    const u = unit.linearUnit;
    points.push({ id, easting: qty("length", easting, u), northing: qty("length", northing, u), elevation: qty("length", elevation, u) });
  }
  const faces: TinFace[] = [];
  let invisible = 0;
  for (const [index, f] of faceNodes.entries()) {
    // LandXML 1.2 marks hidden/trimmed TIN faces (boundary cutouts, voids) with i="1".
    if (f.attrs.i?.trim() === "1") {
      invisible += 1;
      continue;
    }
    const raw = f.text.trim().split(/\s+/).filter((part) => part !== "");
    if (raw.length !== 3) {
      problems.push(`${name}: face ${index + 1} should be three point ids. It says "${f.text}".`);
      return null;
    }
    const ids = raw.map((part) => byId.get(part));
    if (ids.some((n) => n === undefined)) {
      const missing = raw.find((part) => !byId.has(part));
      problems.push(`${name}: face ${index + 1} names point ${missing}, which isn't in that surface.`);
      return null;
    }
    faces.push({ a: ids[0]!, b: ids[1]!, c: ids[2]! });
  }
  if (invisible > 0) {
    notes.push(`${name}: skipped ${invisible} invisible ${invisible === 1 ? "face" : "faces"} (i="1").`);
  }
  if (faces.length < 1) {
    problems.push(`${name} has no visible triangles.`);
    return null;
  }
  if (planArea(points, faces) <= 0) {
    problems.push(`${name}'s triangles cover no ground. A vertical face or a repeated point adds no area.`);
    return null;
  }
  let id = `gs-${slug(name)}`;
  let n = 2;
  while (taken.has(id)) {
    id = `gs-${slug(name)}-${n}`;
    n += 1;
  }
  taken.add(id);
  return { id, name, role: roleFor(name, roles), linearUnit: unit.linearUnit, sourceLinearUnit: unit.sourceLinearUnit, points, faces };
}

/** Read every TIN surface in a LandXML 1.2 document. Never throws: a bad file comes back as problems. */
export function importLandXml(xml: string, options: LandXmlOptions = {}): LandXmlImport {
  const problems: string[] = [];
  const notes: string[] = [];
  const text = xml.trim();
  if (text === "") return { surfaces: [], problems: ["The LandXML file is empty."], notes };
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch (err) {
    const message = err instanceof LandXmlReadError ? err.message : "This isn't a LandXML file. Save the surface as LandXML 1.2 and import it again.";
    return { surfaces: [], problems: [message], notes };
  }
  if (root.name !== "LandXML") return { surfaces: [], problems: [`The top element is <${root.name}>, not <LandXML>. Save the surface as LandXML 1.2 and import it again.`], notes };
  const version = root.attrs.version;
  if (version && !version.startsWith("1.2")) notes.push(`This file says LandXML ${version}. The importer reads 1.2 TIN surfaces (Pnts and Faces); a file that uses that shape is read the same way.`);
  const units = childrenNamed(root, "Units")[0];
  if (!units) return { surfaces: [], problems: ["This LandXML file doesn't say its units. Add a Units element with feet or metres and import it again."], notes };
  const token = linearToken(units);
  if (!token) return { surfaces: [], problems: ["The Units element doesn't give a linearUnit (foot, meter, USSurveyFoot, …)."], notes };
  const unit = fileUnit(token);
  if (typeof unit === "string") return { surfaces: [], problems: [unit], notes };
  if (unit.note) notes.push(unit.note);
  const group = childrenNamed(root, "Surfaces")[0];
  if (!group) return { surfaces: [], problems: ["This LandXML file has no Surfaces element."], notes };
  const nodes = childrenNamed(group, "Surface");
  if (nodes.length === 0) return { surfaces: [], problems: ["This LandXML file has no surface."], notes };
  const taken = new Set<string>();
  const surfaces: GradingSurface[] = [];
  for (const node of nodes) {
    const surface = readSurface(node, unit, options.roles, taken, problems, notes);
    if (surface) surfaces.push(surface);
  }
  if (surfaces.length === 0 && problems.length === 0) problems.push("This LandXML file has no TIN surface (Pnts and Faces).");
  return { surfaces, problems, notes };
}
