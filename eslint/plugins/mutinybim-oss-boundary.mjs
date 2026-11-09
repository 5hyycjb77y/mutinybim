/**
 * MutinyBIM open-source boundary.
 *
 * Everything under packages/bim-* and services/bim-authority ships under
 * Apache-2.0 and must run standalone (SCHEDULES-PLAN §9,
 * .cursor/rules/mutinybim-shared-kernel-first.mdc). A host app hosts and
 * extends it through documented extension points; the engine never reaches
 * back into its host. This rule fails an import in those trees of:
 *
 * - Host app code: `@/...`, or a relative path that leaves the MutinyBIM trees.
 * - Closed PermitZIP packages: any `@permitzip/*` that is not `@permitzip/bim-*`.
 * - Packages an Apache-2.0 product cannot ship: the named commercial / GPL
 *   list below, and any installed package whose declared license is GPL,
 *   AGPL, SSPL, BUSL, Elastic, "UNLICENSED", commercial or "SEE LICENSE IN".
 *   An SPDX `OR` passes when one alternative is acceptable. LGPL and MPL pass.
 *
 * The license field and LICENSE file of each package are checked by
 * mutinybim-oss-boundary-licenses.mjs (same lists).
 *
 * The chat product (packages/chat-*, docs/chat/MODULARITY.md) is held to the
 * same import boundary: no host app code, only its own @permitzip/chat-*
 * packages, nothing GPL / AGPL / commercial. Its license is not chosen yet,
 * so the Apache-2.0 field and LICENSE checks do not apply to it.
 */
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

/** Packages refused by name, whatever their installed metadata says. */
export const DENIED_PACKAGES = [
  { match: /^hyperformula$/, why: "GPL-3.0 (or a paid commercial license)" },
  { match: /^@tiptap-pro\//, why: "Tiptap Pro, a commercial package from a private registry" },
  { match: /^(ag-grid-enterprise$|@ag-grid-enterprise\/)/, why: "AG Grid Enterprise, a commercial package" },
  { match: /^(handsontable$|@handsontable\/)/, why: "Handsontable, a commercial package" },
];

/**
 * Standalone products. `root` finds the repo root and tree of a file inside
 * the product, `inside` tests a repo-relative path, `scope` is the only
 * @permitzip prefix the product may import.
 */
export const PRODUCTS = [
  {
    id: "mutinybim",
    name: "MutinyBIM",
    stance: "is open source (Apache-2.0) and runs standalone",
    root: /^(.*?)\/(packages\/bim-[^/]+|services\/bim-authority)\//,
    inside: (rel) => /^packages\/bim-[^/]+(\/|$)/.test(rel) || /^services\/bim-authority(\/|$)/.test(rel),
    scope: "@permitzip/bim-",
  },
  {
    id: "chat",
    name: "The chat product",
    stance: "runs standalone, with a host app as one host",
    root: /^(.*?)\/(packages\/chat-[^/]+)\//,
    inside: (rel) => /^packages\/chat-[^/]+(\/|$)/.test(rel),
    scope: "@permitzip/chat-",
  },
];

const BUILTINS = new Set(builtinModules);

function norm(p) {
  return p.replaceAll("\\", "/");
}

/** `{ repoRoot, tree, product }` when the file is inside a standalone product tree, else null. */
export function boundaryOf(filename) {
  const file = norm(filename);
  for (const product of PRODUCTS) {
    const m = product.root.exec(file);
    if (m) return { repoRoot: m[1], tree: m[2], product };
  }
  return null;
}

/** The package an import specifier names (`@scope/name` or `name`), null for relative, absolute and built-in specifiers. */
export function packageName(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || BUILTINS.has(name)) return null;
  return name;
}

function deniedBecause(name) {
  return DENIED_PACKAGES.find((d) => d.match.test(name))?.why ?? null;
}

const BAD_TERM = /^(A?GPL|SSPL|BUSL|Elastic|Commons-Clause)/i;

/** Why a declared license cannot ship in an Apache-2.0 product, or null when it can (or says nothing). */
export function licenseProblem(license) {
  if (license === undefined || license === null) return null;
  if (Array.isArray(license)) {
    const terms = license.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean);
    return terms.length > 0 && terms.every((t) => licenseProblem(t) !== null) ? terms.join(" / ") : null;
  }
  if (typeof license === "object") return licenseProblem(license.type);
  const text = String(license).trim();
  if (/^SEE LICENSE IN/i.test(text)) return text;
  if (/^UNLICENSED$/i.test(text)) return "UNLICENSED (proprietary)";
  if (/commercial|proprietary/i.test(text)) return text;
  const alternatives = text.replace(/[()]/g, " ").split(/\s+OR\s+/i);
  const ok = alternatives.some((alt) => alt.split(/\s+(?:AND|WITH)\s+/i).every((term) => !BAD_TERM.test(term.trim())));
  return ok ? null : text;
}

const manifestCache = new Map();

/** The installed package.json of `name` as Node would resolve it from `fromDir`, or null when it is not installed. */
export function installedManifest(name, fromDir) {
  let dir = fromDir;
  const seen = [];
  for (;;) {
    const key = `${dir}\0${name}`;
    if (manifestCache.has(key)) {
      const hit = manifestCache.get(key);
      for (const k of seen) manifestCache.set(k, hit);
      return hit;
    }
    seen.push(key);
    const file = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) {
      let manifest = null;
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        console.error(`[mutinybim-oss-boundary] unreadable ${file}`, err);
        manifest = { license: "SEE LICENSE IN (unreadable package.json)" };
      }
      for (const k of seen) manifestCache.set(k, manifest);
      return manifest;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const k of seen) manifestCache.set(k, null);
      return null;
    }
    dir = parent;
  }
}

const noClosedOrCopyleftImport = {
  meta: {
    type: "problem",
    docs: { description: "Standalone products (MutinyBIM, chat) may not import host app code, closed PermitZIP packages, or GPL / AGPL / commercial packages." },
    schema: [],
    messages: {
      hoursAlias:
        "{{product}} {{stance}}, so it cannot import host app code ('{{source}}'). Expose a documented extension point and let the host implement it.",
      hoursRelative:
        "{{product}} {{stance}}: '{{source}}' reaches out of its packages into '{{target}}'. Expose a documented extension point and let the host implement it.",
      closedPackage:
        "'{{name}}' is a closed PermitZIP package; {{product}} may only import other {{scope}}* packages.",
      deniedPackage:
        "'{{name}}' is {{why}}. {{product}} {{stance}} and cannot depend on it; use an Apache/MIT/BSD-licensed package or our own code.",
      copyleftLicense:
        "'{{name}}' is licensed '{{license}}', which {{product}} cannot ship. Use an Apache/MIT/BSD-licensed package or our own code.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const boundary = boundaryOf(filename);
    if (!boundary) return {};
    const { product } = boundary;
    const dir = path.dirname(filename);
    const about = { product: product.name, stance: product.stance, scope: product.scope };

    function check(node, spec) {
      if (typeof spec !== "string" || spec.length === 0) return;
      if (spec === "@" || spec.startsWith("@/")) {
        context.report({ node, messageId: "hoursAlias", data: { ...about, source: spec } });
        return;
      }
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const absolute = path.resolve(dir, spec);
        const rel = norm(path.relative(boundary.repoRoot, absolute));
        if (!product.inside(rel)) {
          context.report({ node, messageId: "hoursRelative", data: { ...about, source: spec, target: rel } });
        }
        return;
      }
      const name = packageName(spec);
      if (!name) return;
      if (name.startsWith("@permitzip/")) {
        if (!name.startsWith(product.scope)) context.report({ node, messageId: "closedPackage", data: { ...about, name } });
        return;
      }
      const why = deniedBecause(name);
      if (why) {
        context.report({ node, messageId: "deniedPackage", data: { ...about, name, why } });
        return;
      }
      const manifest = installedManifest(name, dir);
      const problem = manifest ? licenseProblem(manifest.license ?? manifest.licenses) : null;
      if (problem) context.report({ node, messageId: "copyleftLicense", data: { ...about, name, license: problem } });
    }

    const literal = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : n && n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0]?.value.cooked : null);

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value);
      },
      ImportExpression(node) {
        const spec = literal(node.source);
        if (spec) check(node.source, spec);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference?.type === "TSExternalModuleReference") {
          const spec = literal(node.moduleReference.expression);
          if (spec) check(node.moduleReference, spec);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const isRequire = callee.type === "Identifier" && callee.name === "require";
        const isModuleMock =
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          (callee.object.name === "jest" || callee.object.name === "vi") &&
          callee.property.type === "Identifier" &&
          ["mock", "doMock", "requireActual", "importActual"].includes(callee.property.name);
        if (!isRequire && !isModuleMock) return;
        const spec = literal(node.arguments[0]);
        if (spec) check(node.arguments[0], spec);
      },
    };
  },
};

const mutinybimOssBoundaryPlugin = {
  meta: { name: "permitzip-mutinybim-oss" },
  rules: {
    "no-closed-or-copyleft-import": noClosedOrCopyleftImport,
  },
};

export default mutinybimOssBoundaryPlugin;
