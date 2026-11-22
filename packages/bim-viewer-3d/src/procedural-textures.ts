import * as THREE from "three";
import type { MaterialPattern } from "@permitzip/bim-kernel";

/**
 * Deterministic, zero-asset procedural PBR texture maps (`map` + `bumpMap`)
 * for architectural and building materials. Generated once per (pattern, color)
 * on an offscreen HTMLCanvasElement and cached for the lifetime of the viewer.
 * Safe in headless/Node environments (returns null when `document` is absent).
 */

export interface ProceduralMaps {
  readonly map: THREE.CanvasTexture;
  readonly bumpMap: THREE.CanvasTexture;
  readonly bumpScale: number;
}

const CACHE = new Map<string, ProceduralMaps | null>();

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [210, 206, 198];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgbCss(r: number, g: number, b: number, delta = 0): string {
  return `rgb(${clamp(r + delta)},${clamp(g + delta)},${clamp(b + delta)})`;
}

/** Simple deterministic hash PRNG in [0, 1). */
function hash2(x: number, y: number, seed = 1337): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function makeCanvas(size: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

function wrapTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Write smooth fine-grain per-pixel noise into albedo + bump canvases (zero blocky artifacts). */
function fillFineGrain(
  ac: CanvasRenderingContext2D,
  bc: CanvasRenderingContext2D,
  size: number,
  r: number,
  g: number,
  b: number,
  amp: number,
  bumpAmp: number,
  seed: number,
): void {
  const aImg = ac.createImageData(size, size);
  const bImg = bc.createImageData(size, size);
  const ad = aImg.data;
  const bd = bImg.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Smooth low-freq mottle + fine mineral grain
      const macro = Math.sin(x * 0.037 + seed) * Math.cos(y * 0.041 - seed) * (amp * 0.45);
      const micro = (hash2(x, y, seed) - 0.5) * amp;
      const d = macro + micro;
      const idx = (y * size + x) * 4;
      ad[idx] = clamp(r + d);
      ad[idx + 1] = clamp(g + d);
      ad[idx + 2] = clamp(b + d);
      ad[idx + 3] = 255;
      const bv = clamp(128 + d * bumpAmp);
      bd[idx] = bv;
      bd[idx + 1] = bv;
      bd[idx + 2] = bv;
      bd[idx + 3] = 255;
    }
  }
  ac.putImageData(aImg, 0, 0);
  bc.putImageData(bImg, 0, 0);
}

export function proceduralMaterialMaps(pattern: MaterialPattern | undefined, colorHex: string): ProceduralMaps | null {
  if (!pattern || pattern === "solid" || pattern === "glass") return null;
  const key = `${pattern}:${colorHex.toLowerCase()}`;
  if (CACHE.has(key)) return CACHE.get(key) ?? null;

  const size = 512;
  const albedo = makeCanvas(size);
  const bump = makeCanvas(size);
  if (!albedo || !bump) {
    CACHE.set(key, null);
    return null;
  }
  const ac = albedo.getContext("2d");
  const bc = bump.getContext("2d");
  if (!ac || !bc) {
    CACHE.set(key, null);
    return null;
  }

  const [r, g, b] = hexToRgb(colorHex);
  ac.fillStyle = rgbCss(r, g, b);
  ac.fillRect(0, 0, size, size);
  bc.fillStyle = "rgb(134,134,134)";
  bc.fillRect(0, 0, size, size);

  let bumpScale = 0.008;

  switch (pattern) {
    case "brick": {
      bumpScale = 0.018;
      // Soft recessed warm-grey architectural mortar bed
      ac.fillStyle = rgbCss(r * 0.4 + 108, g * 0.4 + 106, b * 0.4 + 102);
      ac.fillRect(0, 0, size, size);
      bc.fillStyle = "rgb(68,68,68)";
      bc.fillRect(0, 0, size, size);
      const rows = 16;
      const cols = 6;
      const rh = size / rows;
      const cw = size / cols;
      const mortar = 3.5;
      for (let row = 0; row < rows; row++) {
        const offset = (row % 2) * (cw / 2);
        for (let col = -1; col <= cols; col++) {
          const x = col * cw + offset + mortar / 2;
          const y = row * rh + mortar / 2;
          const w = cw - mortar;
          const h = rh - mortar;
          const tone = (hash2(col + 17, row + 5, 19) - 0.5) * 18;
          const warm = (hash2(col + 31, row + 11, 41) - 0.5) * 8;
          ac.fillStyle = rgbCss(r + warm, g + tone * 0.7, b + tone * 0.5, tone * 0.6);
          ac.fillRect(x, y, w, h);
          // Subtle top highlight + bottom shadow for crisp masonry depth
          ac.fillStyle = "rgba(255,255,255,0.06)";
          ac.fillRect(x, y, w, 2);
          ac.fillStyle = "rgba(0,0,0,0.09)";
          ac.fillRect(x, y + h - 2, w, 2);
          const bv = clamp(180 + tone * 0.6);
          bc.fillStyle = `rgb(${bv},${bv},${bv})`;
          bc.fillRect(x, y, w, h);
        }
      }
      break;
    }
    case "concrete": {
      bumpScale = 0.01;
      // Smooth architectural cast-in-place / board-formed concrete (zero blocky pixels)
      fillFineGrain(ac, bc, size, r, g, b, 10, 1.4, 29);
      // Crisp architectural formwork panel joints & subtle tie-rod cones
      ac.strokeStyle = "rgba(0,0,0,0.11)";
      ac.lineWidth = 1.5;
      bc.strokeStyle = "rgb(92,92,92)";
      bc.lineWidth = 2;
      for (let row = 0; row < 4; row++) {
        const y = row * (size / 4) + 0.5;
        ac.beginPath(); ac.moveTo(0, y); ac.lineTo(size, y); ac.stroke();
        bc.beginPath(); bc.moveTo(0, y); bc.lineTo(size, y); bc.stroke();
        // Subtle architectural form-tie dimples
        for (const tx of [size * 0.25, size * 0.75]) {
          const ty = y + size / 8;
          ac.fillStyle = "rgba(0,0,0,0.13)";
          ac.beginPath(); ac.arc(tx, ty, 3, 0, Math.PI * 2); ac.fill();
          bc.fillStyle = "rgb(82,82,82)";
          bc.beginPath(); bc.arc(tx, ty, 3.5, 0, Math.PI * 2); bc.fill();
        }
      }
      ac.beginPath(); ac.moveTo(size * 0.5, 0); ac.lineTo(size * 0.5, size); ac.stroke();
      break;
    }
    case "gypsum": {
      bumpScale = 0.003;
      // Ultra-clean matte architectural stucco / painted gypsum plaster
      fillFineGrain(ac, bc, size, r, g, b, 5, 0.8, 53);
      break;
    }
    case "wood": {
      bumpScale = 0.014;
      // Refined architectural cedar/oak tongue-and-groove slats with realistic longitudinal grain
      const planks = 8;
      const ph = size / planks;
      const aImg = ac.createImageData(size, size);
      const bImg = bc.createImageData(size, size);
      const ad = aImg.data;
      const bd = bImg.data;
      for (let y = 0; y < size; y++) {
        const plank = Math.floor(y / ph);
        const localY = y - plank * ph;
        const plankTone = (hash2(plank, 3, 71) - 0.5) * 14;
        const isGroove = localY < 2.5 || localY > ph - 1.5;
        for (let x = 0; x < size; x++) {
          const idx = (y * size + x) * 4;
          if (isGroove) {
            ad[idx] = clamp(r - 48);
            ad[idx + 1] = clamp(g - 44);
            ad[idx + 2] = clamp(b - 38);
            ad[idx + 3] = 255;
            bd[idx] = 62; bd[idx + 1] = 62; bd[idx + 2] = 62; bd[idx + 3] = 255;
            continue;
          }
          const fiber = Math.sin((localY * 0.55 + Math.sin(x * 0.025 + plank * 2.3) * 3.2)) * 5.5
            + (hash2(x >> 2, y, 83) - 0.5) * 5;
          const d = plankTone + fiber;
          ad[idx] = clamp(r + d);
          ad[idx + 1] = clamp(g + d * 0.88);
          ad[idx + 2] = clamp(b + d * 0.72);
          ad[idx + 3] = 255;
          const bv = clamp(142 + fiber * 2.2);
          bd[idx] = bv; bd[idx + 1] = bv; bd[idx + 2] = bv; bd[idx + 3] = 255;
        }
      }
      ac.putImageData(aImg, 0, 0);
      bc.putImageData(bImg, 0, 0);
      break;
    }
    case "metal": {
      bumpScale = 0.016;
      // Crisp architectural standing-seam zinc/metal cladding with brushed sheen & raised seam ribs
      fillFineGrain(ac, bc, size, r, g, b, 6, 0.8, 97);
      const panels = 6;
      const pw = size / panels;
      for (let i = 0; i < panels; i++) {
        const sx = i * pw;
        // Subtle directional metallic sheen gradient across each pan
        const grad = ac.createLinearGradient(sx, 0, sx + pw, 0);
        grad.addColorStop(0, "rgba(0,0,0,0.08)");
        grad.addColorStop(0.18, "rgba(255,255,255,0.05)");
        grad.addColorStop(0.85, "rgba(0,0,0,0.03)");
        grad.addColorStop(1, "rgba(0,0,0,0.12)");
        ac.fillStyle = grad;
        ac.fillRect(sx, 0, pw, size);
        // Raised standing seam rib (highlight + crisp shadow line)
        ac.fillStyle = "rgba(255,255,255,0.16)";
        ac.fillRect(sx, 0, 3, size);
        ac.fillStyle = "rgba(0,0,0,0.34)";
        ac.fillRect(sx + 3, 0, 4, size);
        bc.fillStyle = "rgb(235,235,235)";
        bc.fillRect(sx, 0, 4, size);
        bc.fillStyle = "rgb(75,75,75)";
        bc.fillRect(sx + 4, 0, 3, size);
      }
      break;
    }
    case "tile": {
      bumpScale = 0.012;
      // Clean 2'x4' architectural acoustic ceiling / large-format terrazzo tile grid
      fillFineGrain(ac, bc, size, r, g, b, 6, 1.0, 113);
      const cols = 4;
      const rows = 2;
      const cw = size / cols;
      const rh = size / rows;
      ac.strokeStyle = rgbCss(r, g, b, -20);
      ac.lineWidth = 3;
      bc.strokeStyle = "rgb(82,82,82)";
      bc.lineWidth = 3;
      for (let i = 0; i <= cols; i++) {
        const p = i * cw;
        ac.beginPath(); ac.moveTo(p, 0); ac.lineTo(p, size); ac.stroke();
        bc.beginPath(); bc.moveTo(p, 0); bc.lineTo(p, size); bc.stroke();
      }
      for (let j = 0; j <= rows; j++) {
        const p = j * rh;
        ac.beginPath(); ac.moveTo(0, p); ac.lineTo(size, p); ac.stroke();
        bc.beginPath(); bc.moveTo(0, p); bc.lineTo(size, p); bc.stroke();
      }
      break;
    }
    default:
      break;
  }

  const maps: ProceduralMaps = {
    map: wrapTexture(albedo, true),
    bumpMap: wrapTexture(bump, false),
    bumpScale,
  };
  CACHE.set(key, maps);
  return maps;
}

/** Generate world-scale triplanar/box UVs (1 tile = 1.5 m) for any BufferGeometry missing `uv`. */
export function ensureBoxUVs(geometry: THREE.BufferGeometry, tileMetres = 1.5): void {
  if (geometry.attributes.uv) return;
  const pos = geometry.attributes.position;
  if (!pos) return;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const norm = geometry.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);
  const inv = 1 / tileMetres;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = norm ? Math.abs(norm.getX(i)) : 0;
    const ny = norm ? Math.abs(norm.getY(i)) : 1;
    const nz = norm ? Math.abs(norm.getZ(i)) : 0;
    if (ny >= nx && ny >= nz) {
      uvs[i * 2] = x * inv;
      uvs[i * 2 + 1] = z * inv;
    } else if (nx >= nz) {
      uvs[i * 2] = z * inv;
      uvs[i * 2 + 1] = y * inv;
    } else {
      uvs[i * 2] = x * inv;
      uvs[i * 2 + 1] = y * inv;
    }
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

/**
 * Architectural feature-edge extractor: like `THREE.EdgesGeometry`, but also splits
 * collinear edges at T-junction breakpoints and cancels opposing coplanar faces where
 * abutting sub-prisms touch (such as full-height wall piers meeting shorter door lintels
 * or window sills). Eliminates unnatural vertical seam lines above/below openings while
 * preserving every real opening jamb, sill, head, and corner edge.
 */
export function cleanEdgesGeometry(geometry: THREE.BufferGeometry, thresholdDeg = 30): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  if (!pos) return new THREE.BufferGeometry();
  const idx = geometry.getIndex();
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  const cosThreshold = Math.cos((thresholdDeg * Math.PI) / 180);

  interface CollinearSeg {
    t0: number;
    t1: number;
    nx: number;
    ny: number;
    nz: number;
  }
  interface LineGroup {
    ox: number; oy: number; oz: number;
    dx: number; dy: number; dz: number;
    segs: CollinearSeg[];
  }
  const lines = new Map<string, LineGroup>();

  const qDir = (v: number): number => Math.round(v * 100);
  const qPos = (v: number): number => Math.round(v * 200); // 5 mm quantization in meters

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  const addEdge = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, nx: number, ny: number, nz: number) => {
    let dx = bx - ax;
    let dy = by - ay;
    let dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len;
    dy /= len;
    dz /= len;
    // Canonical direction sign so opposite-order edges hash to the same infinite line
    if (dx < -1e-4 || (Math.abs(dx) <= 1e-4 && (dy < -1e-4 || (Math.abs(dy) <= 1e-4 && dz < 0)))) {
      dx = -dx;
      dy = -dy;
      dz = -dz;
    }
    const ta = ax * dx + ay * dy + az * dz;
    const tb = bx * dx + by * dy + bz * dz;
    const ox = ax - dx * ta;
    const oy = ay - dy * ta;
    const oz = az - dz * ta;
    const key = `${qDir(dx)},${qDir(dy)},${qDir(dz)}|${qPos(ox)},${qPos(oy)},${qPos(oz)}`;
    let grp = lines.get(key);
    if (!grp) {
      grp = { ox, oy, oz, dx, dy, dz, segs: [] };
      lines.set(key, grp);
    }
    const t0 = Math.min(ta, tb);
    const t1 = Math.max(ta, tb);
    grp.segs.push({ t0, t1, nx, ny, nz });
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const len = n.length();
    if (len < 1e-10) continue;
    n.divideScalar(len);
    addEdge(a.x, a.y, a.z, b.x, b.y, b.z, n.x, n.y, n.z);
    addEdge(b.x, b.y, b.z, c.x, c.y, c.z, n.x, n.y, n.z);
    addEdge(c.x, c.y, c.z, a.x, a.y, a.z, n.x, n.y, n.z);
  }

  const out: number[] = [];
  const EPS_T = 0.002; // 2 mm in meters
  lines.forEach((grp) => {
    const breaks: number[] = [];
    for (const s of grp.segs) {
      breaks.push(s.t0, s.t1);
    }
    breaks.sort((u, v) => u - v);
    const uniq: number[] = [];
    for (const v of breaks) {
      if (uniq.length === 0 || v - uniq[uniq.length - 1]! > EPS_T) uniq.push(v);
    }
    for (let bi = 0; bi + 1 < uniq.length; bi++) {
      const s0 = uniq[bi]!;
      const s1 = uniq[bi + 1]!;
      const mid = (s0 + s1) * 0.5;
      const normals: number[] = [];
      for (const s of grp.segs) {
        if (s.t0 <= mid && s.t1 >= mid) normals.push(s.nx, s.ny, s.nz);
      }
      const count = normals.length / 3;
      if (count === 0) continue;
      const cancelled = new Uint8Array(count);
      // Cancel opposing face normals (abutting internal sub-prism caps like lintel/sill-to-pier seams).
      for (let i = 0; i < count; i++) {
        if (cancelled[i]) continue;
        const ix = normals[i * 3]!, iy = normals[i * 3 + 1]!, iz = normals[i * 3 + 2]!;
        for (let j = i + 1; j < count; j++) {
          if (cancelled[j]) continue;
          const dot = ix * normals[j * 3]! + iy * normals[j * 3 + 1]! + iz * normals[j * 3 + 2]!;
          if (dot < -0.98) {
            cancelled[i] = 1;
            cancelled[j] = 1;
            break;
          }
        }
      }
      const exposed: number[] = [];
      for (let i = 0; i < count; i++) {
        if (!cancelled[i]) exposed.push(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
      }
      const expCount = exposed.length / 3;
      if (expCount === 0) continue;
      let sharp = expCount === 1;
      if (!sharp) {
        for (let i = 0; i < expCount && !sharp; i++) {
          const ix = exposed[i * 3]!, iy = exposed[i * 3 + 1]!, iz = exposed[i * 3 + 2]!;
          for (let j = i + 1; j < expCount; j++) {
            const dot = ix * exposed[j * 3]! + iy * exposed[j * 3 + 1]! + iz * exposed[j * 3 + 2]!;
            if (dot <= cosThreshold) {
              sharp = true;
              break;
            }
          }
        }
      }
      if (sharp) {
        out.push(
          grp.ox + grp.dx * s0, grp.oy + grp.dy * s0, grp.oz + grp.dz * s0,
          grp.ox + grp.dx * s1, grp.oy + grp.dy * s1, grp.oz + grp.dz * s1,
        );
      }
    }
  });

  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return edgeGeo;
}

  /** Inflate a geometry outward along triangle face normals by `offsetM` meters so hover/selection overlays never z-fight with batched meshes. */
  export function inflateAlongNormals(geometry: THREE.BufferGeometry, offsetM = 0.002): THREE.BufferGeometry {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    const pos = nonIndexed.getAttribute("position");
    if (!pos) return nonIndexed;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i + 2 < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const len = n.length();
      if (len < 1e-10) continue;
      n.multiplyScalar(offsetM / len);
      pos.setXYZ(i, a.x + n.x, a.y + n.y, a.z + n.z);
      pos.setXYZ(i + 1, b.x + n.x, b.y + n.y, b.z + n.z);
      pos.setXYZ(i + 2, c.x + n.x, c.y + n.y, c.z + n.z);
    }
    pos.needsUpdate = true;
    nonIndexed.computeVertexNormals();
    return nonIndexed;
  }

  /** Build a rich architectural daylight studio environment texture for authentic glass & metal reflections. */
export function buildStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xcde0f2);
    // Sky zenith dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(24, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xb7d4ee, side: THREE.BackSide }),
    );
    envScene.add(sky);
    // Bright crisp architectural horizon band (gives glass curtain walls realistic horizon reflection)
    const horizon = new THREE.Mesh(
      new THREE.CylinderGeometry(21, 21, 10, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xf4f7fb, side: THREE.BackSide }),
    );
    horizon.position.y = 1.5;
    envScene.add(horizon);
    // Warm sunlit softbox panel
    const sunPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff6e5, side: THREE.DoubleSide }),
    );
    sunPanel.position.set(12, 14, 9);
    sunPanel.lookAt(0, 0, 0);
    envScene.add(sunPanel);
    // Cool opposite sky fill bounce
    const coolPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 10),
      new THREE.MeshBasicMaterial({ color: 0xdceafb, side: THREE.DoubleSide }),
    );
    coolPanel.position.set(-14, 8, -10);
    coolPanel.lookAt(0, 0, 0);
    envScene.add(coolPanel);
    // Warm neutral architectural ground bounce
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshBasicMaterial({ color: 0x9aa0a6, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -4;
    envScene.add(ground);
    const rt = pmrem.fromScene(envScene, 0.035);
    pmrem.dispose();
    return rt.texture;
  } catch {
    return null;
  }
}
