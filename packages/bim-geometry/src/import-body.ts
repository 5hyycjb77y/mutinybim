import { meshBounds, type TriangleMesh } from "./program";

/**
 * Bodies from other programs: glTF 2.0 (`.gltf` with embedded buffers, or
 * binary `.glb`) and Wavefront OBJ. Only triangles come in: no materials,
 * textures, cameras, animation or file references, so nothing in the file
 * can reach outside it. Every number is checked, sizes are capped, and the
 * result is in millimetres with z up, the part's own frame.
 *
 * Readers written here (no dependency); STEP is a later round (answer 7).
 */

export const IMPORT_LIMITS = {
  /** File size. */
  bytes: 25 * 1024 * 1024,
  vertices: 500_000,
  triangles: 300_000,
  /** Largest extent after scaling (a 300 m body is a wrong unit, not a part). */
  extentMm: 300_000,
} as const;

export class ImportBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportBodyError";
  }
}

export interface ImportOptions {
  /** Millimetres per file unit. glTF is metres by its spec, so 1000 unless the vendor says otherwise. */
  readonly mmPerUnit: number;
  /** The file's up axis. glTF is y-up by its spec; OBJ files vary. */
  readonly upAxis: "y" | "z";
}

type Mat = number[];

const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat, b: Mat): Mat {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] = (out[c * 4 + r] ?? 0) + (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
  return out;
}

function finite(n: unknown, what: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ImportBodyError(`${what} isn't a number`);
  return n;
}

/** Positions (file units, file axes) and triangles into the part frame, checked against the limits. */
function finish(raw: { positions: number[]; indices: number[] }, options: ImportOptions): TriangleMesh {
  if (!(options.mmPerUnit > 0) || !Number.isFinite(options.mmPerUnit)) throw new ImportBodyError("The body's unit scale must be a positive number (millimetres per file unit)");
  const nv = raw.positions.length / 3;
  if (nv > IMPORT_LIMITS.vertices) throw new ImportBodyError(`The body has ${nv} corners; at most ${IMPORT_LIMITS.vertices}. Simplify it in the program it came from`);
  const nt = raw.indices.length / 3;
  if (nt === 0) throw new ImportBodyError("The file has no triangles to make a body from");
  if (nt > IMPORT_LIMITS.triangles) throw new ImportBodyError(`The body has ${nt} triangles; at most ${IMPORT_LIMITS.triangles}. Simplify it in the program it came from`);
  const positions = new Float32Array(nv * 3);
  const k = options.mmPerUnit;
  for (let i = 0; i < nv; i++) {
    const x = raw.positions[i * 3] ?? 0;
    const y = raw.positions[i * 3 + 1] ?? 0;
    const z = raw.positions[i * 3 + 2] ?? 0;
    // y-up files: the file's -z is the part's +y (right-handed turn about x).
    if (options.upAxis === "y") positions.set([x * k, -z * k, y * k], i * 3);
    else positions.set([x * k, y * k, z * k], i * 3);
  }
  const indices = new Uint32Array(raw.indices.length);
  for (let i = 0; i < raw.indices.length; i++) {
    const v = raw.indices[i] ?? -1;
    if (!Number.isInteger(v) || v < 0 || v >= nv) throw new ImportBodyError(`Triangle ${Math.floor(i / 3) + 1} names corner ${v + 1}, which isn't in the file`);
    indices[i] = v;
  }
  const bounds = meshBounds(positions);
  for (let a = 0; a < 3; a++) {
    const extent = (bounds.max[a] ?? 0) - (bounds.min[a] ?? 0);
    if (extent > IMPORT_LIMITS.extentMm) throw new ImportBodyError(`The body is ${Math.round(extent / 1000)} m across; check its unit (millimetres per file unit is ${k})`);
  }
  return { positions, indices, triangleCount: nt, bounds };
}

/** Wavefront OBJ: `v` and `f` lines (any polygon, fanned to triangles; negative indices count back). Everything else is ignored. */
export function readObj(text: string, options: ImportOptions): TriangleMesh {
  if (text.length > IMPORT_LIMITS.bytes) throw new ImportBodyError(`The file is ${Math.round(text.length / 1048576)} MB; at most ${IMPORT_LIMITS.bytes / 1048576} MB`);
  const positions: number[] = [];
  const indices: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const [n, line] of lines.entries()) {
    const t = line.trim();
    if (t.startsWith("v ")) {
      const parts = t.split(/\s+/);
      for (let a = 1; a <= 3; a++) positions.push(finite(Number(parts[a]), `Line ${n + 1}'s corner`));
      if (positions.length / 3 > IMPORT_LIMITS.vertices) throw new ImportBodyError(`The body has more than ${IMPORT_LIMITS.vertices} corners. Simplify it in the program it came from`);
    } else if (t.startsWith("f ")) {
      const nv = positions.length / 3;
      const refs = t
        .split(/\s+/)
        .slice(1)
        .map((r) => {
          const i = Number.parseInt(r.split("/")[0] ?? "", 10);
          if (!Number.isInteger(i) || i === 0) throw new ImportBodyError(`Line ${n + 1}'s face names a corner that isn't a number`);
          return i < 0 ? nv + i : i - 1;
        });
      if (refs.length < 3) throw new ImportBodyError(`Line ${n + 1}'s face has fewer than three corners`);
      for (let i = 1; i + 1 < refs.length; i++) indices.push(refs[0] ?? 0, refs[i] ?? 0, refs[i + 1] ?? 0);
      if (indices.length / 3 > IMPORT_LIMITS.triangles) throw new ImportBodyError(`The body has more than ${IMPORT_LIMITS.triangles} triangles. Simplify it in the program it came from`);
    }
  }
  return finish({ positions, indices }, options);
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: unknown;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: { POSITION?: number };
  indices?: number;
  mode?: number;
}
interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfDoc {
  asset?: { version?: string };
  extensionsRequired?: string[];
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: Array<{ primitives: GltfPrimitive[] }>;
  nodes?: GltfNode[];
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
}

function isDoc(v: unknown): v is GltfDoc {
  return typeof v === "object" && v !== null && "asset" in v;
}

function decodeDataUri(uri: string): Uint8Array {
  const m = /^data:[^;,]*;base64,([\s\S]*)$/.exec(uri);
  if (!m) throw new ImportBodyError("The glTF names a separate buffer file; export it as .glb or with embedded buffers");
  const b64 = m[1] ?? "";
  if ((b64.length * 3) / 4 > IMPORT_LIMITS.bytes) throw new ImportBodyError(`The file's data is more than ${IMPORT_LIMITS.bytes / 1048576} MB`);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function nodeMatrix(node: GltfNode): Mat {
  if (node.matrix) {
    if (node.matrix.length !== 16) throw new ImportBodyError("A glTF node's matrix doesn't have 16 numbers");
    return node.matrix.map((n) => finite(n, "A glTF node's matrix"));
  }
  const [tx, ty, tz] = (node.translation ?? [0, 0, 0]).map((n) => finite(n, "A glTF node's position"));
  const [qx, qy, qz, qw] = (node.rotation ?? [0, 0, 0, 1]).map((n) => finite(n, "A glTF node's rotation"));
  const [sx, sy, sz] = (node.scale ?? [1, 1, 1]).map((n) => finite(n, "A glTF node's scale"));
  const [x, y, z, w] = [qx ?? 0, qy ?? 0, qz ?? 0, qw ?? 1];
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  const s = [sx ?? 1, sy ?? 1, sz ?? 1];
  return [
    (r[0] ?? 0) * (s[0] ?? 1), (r[1] ?? 0) * (s[0] ?? 1), (r[2] ?? 0) * (s[0] ?? 1), 0,
    (r[3] ?? 0) * (s[1] ?? 1), (r[4] ?? 0) * (s[1] ?? 1), (r[5] ?? 0) * (s[1] ?? 1), 0,
    (r[6] ?? 0) * (s[2] ?? 1), (r[7] ?? 0) * (s[2] ?? 1), (r[8] ?? 0) * (s[2] ?? 1), 0,
    tx ?? 0, ty ?? 0, tz ?? 0, 1,
  ];
}

const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };

/** glTF 2.0, JSON with embedded (data:) buffers or binary GLB: every triangle primitive of the default scene, with node transforms. */
export function readGltf(file: Uint8Array, options: ImportOptions): TriangleMesh {
  if (file.byteLength > IMPORT_LIMITS.bytes) throw new ImportBodyError(`The file is ${Math.round(file.byteLength / 1048576)} MB; at most ${IMPORT_LIMITS.bytes / 1048576} MB`);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let docText: string;
  let glbBin: Uint8Array | null = null;
  if (file.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (view.getUint32(4, true) !== 2) throw new ImportBodyError("The .glb isn't glTF version 2");
    let off = 12;
    docText = "";
    while (off + 8 <= file.byteLength) {
      const len = view.getUint32(off, true);
      const type = view.getUint32(off + 4, true);
      if (off + 8 + len > file.byteLength) throw new ImportBodyError("The .glb is cut short");
      const chunk = file.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) docText = new TextDecoder().decode(chunk);
      else if (type === 0x004e4942) glbBin = chunk;
      off += 8 + len;
    }
  } else docText = new TextDecoder().decode(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(docText);
  } catch (err) {
    throw new ImportBodyError(`The file isn't glTF: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isDoc(parsed)) throw new ImportBodyError("The file isn't glTF (no asset block)");
  const doc = parsed;
  if (!doc.asset?.version?.startsWith("2")) throw new ImportBodyError("Only glTF version 2 is read");
  if (doc.extensionsRequired && doc.extensionsRequired.length > 0) throw new ImportBodyError(`The file needs ${doc.extensionsRequired.join(", ")} to read; export it without compression`);
  const buffers = (doc.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i !== 0 || !glbBin) throw new ImportBodyError("A glTF buffer has no data");
      return glbBin;
    }
    return decodeDataUri(b.uri);
  });
  const read = (index: number, want: "VEC3" | "SCALAR"): number[] => {
    const acc = doc.accessors?.[index];
    if (!acc) throw new ImportBodyError(`The file names accessor ${index}, which isn't there`);
    if (acc.sparse) throw new ImportBodyError("Sparse glTF data isn't read; export without it");
    if (acc.type !== want) throw new ImportBodyError(`A glTF accessor is ${acc.type}, expected ${want}`);
    const size = COMPONENT_BYTES[acc.componentType];
    if (!size) throw new ImportBodyError(`A glTF accessor's number type ${acc.componentType} isn't read`);
    if (want === "VEC3" && acc.componentType !== 5126) throw new ImportBodyError("glTF positions must be 32-bit floats");
    const per = want === "VEC3" ? 3 : 1;
    if (!Number.isInteger(acc.count) || acc.count < 0 || acc.count * per > IMPORT_LIMITS.vertices * 3) throw new ImportBodyError("A glTF accessor is larger than a part body may be");
    if (acc.bufferView === undefined) return new Array<number>(acc.count * per).fill(0);
    const bv = doc.bufferViews?.[acc.bufferView];
    const buf = bv ? buffers[bv.buffer] : undefined;
    if (!bv || !buf) throw new ImportBodyError("A glTF accessor points at data that isn't there");
    const stride = bv.byteStride ?? size * per;
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const last = base + stride * Math.max(0, acc.count - 1) + size * per;
    if (acc.count > 0 && (last > (bv.byteOffset ?? 0) + bv.byteLength || last > buf.byteLength)) throw new ImportBodyError("A glTF accessor runs past the end of its data");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out = new Array<number>(acc.count * per);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < per; c++) {
        const at = base + i * stride + c * size;
        const v = acc.componentType === 5126 ? dv.getFloat32(at, true) : acc.componentType === 5125 ? dv.getUint32(at, true) : acc.componentType === 5123 ? dv.getUint16(at, true) : dv.getUint8(at);
        out[i * per + c] = finite(v, "A glTF value");
      }
    }
    return out;
  };
  const positions: number[] = [];
  const indices: number[] = [];
  const visit = (nodeIndex: number, parent: Mat, depth: number) => {
    if (depth > 64) throw new ImportBodyError("The glTF's nodes nest more than 64 deep");
    const node = doc.nodes?.[nodeIndex];
    if (!node) throw new ImportBodyError(`The file names node ${nodeIndex}, which isn't there`);
    const m = mul(parent, nodeMatrix(node));
    const mesh = node.mesh === undefined ? undefined : doc.meshes?.[node.mesh];
    for (const prim of mesh?.primitives ?? []) {
      if ((prim.mode ?? 4) !== 4) continue;
      if (prim.attributes.POSITION === undefined) continue;
      const p = read(prim.attributes.POSITION, "VEC3");
      const start = positions.length / 3;
      for (let i = 0; i < p.length; i += 3) {
        const [x, y, z] = [p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0];
        positions.push((m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0), (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0), (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0));
      }
      if (positions.length / 3 > IMPORT_LIMITS.vertices) throw new ImportBodyError(`The body has more than ${IMPORT_LIMITS.vertices} corners. Simplify it in the program it came from`);
      const idx = prim.indices === undefined ? Array.from({ length: p.length / 3 }, (_, i) => i) : read(prim.indices, "SCALAR");
      const det = (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[6] ?? 0)) - (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[9] ?? 0) * (m[2] ?? 0)) + (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[5] ?? 0) * (m[2] ?? 0));
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = start + (idx[t] ?? 0);
        const b = start + (idx[t + 1] ?? 0);
        const c = start + (idx[t + 2] ?? 0);
        if (det < 0) indices.push(a, c, b);
        else indices.push(a, b, c);
      }
      if (indices.length / 3 > IMPORT_LIMITS.triangles) throw new ImportBodyError(`The body has more than ${IMPORT_LIMITS.triangles} triangles. Simplify it in the program it came from`);
    }
    for (const child of node.children ?? []) visit(child, m, depth + 1);
  };
  const scene = doc.scenes?.[doc.scene ?? 0];
  const roots = scene?.nodes ?? (doc.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY, 0);
  return finish({ positions, indices }, options);
}

/** Read a body by its format name (`gltf`, `glb`, `obj`). */
export function readBody(format: string, file: Uint8Array, options: ImportOptions): TriangleMesh {
  switch (format) {
    case "gltf":
    case "glb":
      return readGltf(file, options);
    case "obj":
      return readObj(new TextDecoder().decode(file), options);
    default:
      throw new ImportBodyError(`A body in ${format} can't be read yet; use glTF or OBJ (STEP comes later)`);
  }
}

/**
 * A lighter copy for coarse and medium drawings: corners closer than
 * `cellMm` merge, and triangles that collapse go. The result is for drawing
 * and picking; it may not be a closed solid.
 */
export function decimateMesh(mesh: TriangleMesh, cellMm: number): TriangleMesh {
  if (!(cellMm > 0) || mesh.triangleCount === 0) return mesh;
  const key = new Map<string, number>();
  const remap = new Uint32Array(mesh.positions.length / 3);
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const x = mesh.positions[i * 3] ?? 0;
    const y = mesh.positions[i * 3 + 1] ?? 0;
    const z = mesh.positions[i * 3 + 2] ?? 0;
    const k = `${Math.floor(x / cellMm)},${Math.floor(y / cellMm)},${Math.floor(z / cellMm)}`;
    let idx = key.get(k);
    if (idx === undefined) {
      idx = counts.length;
      key.set(k, idx);
      counts.push(0);
      sums.push(0, 0, 0);
    }
    remap[i] = idx;
    counts[idx] = (counts[idx] ?? 0) + 1;
    sums[idx * 3] = (sums[idx * 3] ?? 0) + x;
    sums[idx * 3 + 1] = (sums[idx * 3 + 1] ?? 0) + y;
    sums[idx * 3 + 2] = (sums[idx * 3 + 2] ?? 0) + z;
  }
  const positions = new Float32Array(counts.length * 3);
  for (let i = 0; i < counts.length; i++) for (let a = 0; a < 3; a++) positions[i * 3 + a] = (sums[i * 3 + a] ?? 0) / (counts[i] ?? 1);
  const kept: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t] ?? 0] ?? 0;
    const b = remap[mesh.indices[t + 1] ?? 0] ?? 0;
    const c = remap[mesh.indices[t + 2] ?? 0] ?? 0;
    if (a === b || b === c || a === c) continue;
    const sig = [a, b, c].sort((p, q) => p - q).join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push(a, b, c);
  }
  const indices = Uint32Array.from(kept);
  return { positions, indices, triangleCount: indices.length / 3, bounds: meshBounds(positions) };
}
