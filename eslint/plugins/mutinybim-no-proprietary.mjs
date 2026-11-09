/**
 * MutinyBIM: no proprietary PermitZIP code-study code or data in the open
 * source packages (round 7, lane P; REQUIREMENTS-GRAPH §5).
 *
 * PermitZIP's code studies reach the Building Model through a closed-source
 * connector (lib/bim/requirements-source/permitzip-code-study.ts) that
 * implements `kernel.requirements_source`. The reverse direction must never
 * exist: nothing under packages/bim-* or services/bim-authority may import
 * the host app's code-study or code-library modules, any `@/lib/*` or `app/*`
 * code, or name the closed `codes` schema (the firm code library: section
 * bodies, ingest, embeddings).
 *
 * Sibling of mutinybim-oss-boundary.mjs (which refuses every host-app import);
 * this rule names the proprietary sources specifically so a message says what
 * would have leaked, and also catches a `codes.` table name in a string or a
 * `.schema("codes")` call.
 */
import path from "node:path";
import { boundaryOf } from "./mutinybim-oss-boundary.mjs";

const PROPRIETARY_MODULE = /(^|\/)lib\/code-(study|library)(\/|$)/;
const HOST_ALIAS = /^@\/(lib|app)(\/|$)/;
/** `codes.sections`, `codes.instruments`… but not a file name (`./codes.ts`) or a longer identifier. */
const CODES_SCHEMA_REFERENCE = /(?<![A-Za-z0-9_./-])codes\.(?!(?:ts|tsx|js|mjs|cjs|json|md)\b)[a-z_][a-z0-9_]*/;

function norm(p) {
  return p.replaceAll("\\", "/");
}

const noProprietaryInKernel = {
  meta: {
    type: "problem",
    docs: {
      description:
        "MutinyBIM's open-source packages may not import PermitZIP's code-study or code-library code, the host app's lib/ or app/ code, or reference the closed `codes` schema.",
    },
    schema: [],
    messages: {
      proprietaryModule:
        "'{{source}}' is PermitZIP's closed code-study / code-library code. MutinyBIM reads code studies only through `kernel.requirements_source`; the connector lives in the host app.",
      hostAlias:
        "'{{source}}' is host app code. MutinyBIM is open source and runs standalone; expose an extension point and let the host implement it.",
      hostRelative:
        "'{{source}}' reaches into the host app's '{{target}}'. MutinyBIM is open source and runs standalone; expose an extension point and let the host implement it.",
      codesSchema:
        "'{{text}}' names PermitZIP's closed code library (the `codes` schema). Library text, ingest and embeddings never enter MutinyBIM; rules arrive through `kernel.requirements_source` with citations and the author's own words.",
    },
  },
  create(context) {
    const filename = norm(context.filename ?? context.getFilename());
    const boundary = boundaryOf(filename);
    if (!boundary || boundary.product.id !== "mutinybim") return {};
    const dir = path.dirname(filename);
    const importSources = new WeakSet();

    function checkSpecifier(node, spec) {
      if (typeof spec !== "string" || spec.length === 0) return;
      importSources.add(node);
      if (PROPRIETARY_MODULE.test(spec)) {
        context.report({ node, messageId: "proprietaryModule", data: { source: spec } });
        return;
      }
      if (HOST_ALIAS.test(spec)) {
        context.report({ node, messageId: "hostAlias", data: { source: spec } });
        return;
      }
      if (spec.startsWith(".")) {
        const rel = norm(path.relative(boundary.repoRoot, path.resolve(dir, spec)));
        if (/^(lib|app)(\/|$)/.test(rel)) context.report({ node, messageId: "hostRelative", data: { source: spec, target: rel } });
      }
    }

    function literalValue(node) {
      if (!node) return null;
      if (node.type === "Literal" && typeof node.value === "string") return node.value;
      if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? null;
      return null;
    }

    function checkText(node, text) {
      if (importSources.has(node) || typeof text !== "string") return;
      const match = CODES_SCHEMA_REFERENCE.exec(text);
      if (match) context.report({ node, messageId: "codesSchema", data: { text: match[0] } });
    }

    return {
      ImportDeclaration(node) {
        checkSpecifier(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSpecifier(node.source, node.source.value);
      },
      ExportAllDeclaration(node) {
        checkSpecifier(node.source, node.source.value);
      },
      ImportExpression(node) {
        const spec = literalValue(node.source);
        if (spec !== null) checkSpecifier(node.source, spec);
      },
      TSImportType(node) {
        // typescript-eslint 8 names it `source`; older parsers only had `argument`.
        const arg = node.source ?? (node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument);
        const spec = literalValue(arg);
        if (spec !== null) checkSpecifier(arg, spec);
      },
      CallExpression(node) {
        const callee = node.callee;
        const first = node.arguments[0];
        if (callee.type === "Identifier" && callee.name === "require") {
          const spec = literalValue(first);
          if (spec !== null) checkSpecifier(first, spec);
          return;
        }
        if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "schema" && literalValue(first) === "codes") {
          importSources.add(first);
          context.report({ node: first, messageId: "codesSchema", data: { text: '.schema("codes")' } });
        }
      },
      Literal(node) {
        if (typeof node.value === "string") checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked);
      },
    };
  },
};

const mutinybimNoProprietaryPlugin = {
  meta: { name: "permitzip-mutinybim-proprietary" },
  rules: { "no-proprietary-in-kernel": noProprietaryInKernel },
};

export default mutinybimNoProprietaryPlugin;
