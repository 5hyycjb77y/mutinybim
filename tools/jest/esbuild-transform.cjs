// Jest transform: esbuild strips TypeScript and compiles JSX, then Babel turns
// the ES modules (and import()) into CommonJS and hoists jest.mock() above the imports (as
// babel-jest does), so module mocks apply to the modules a test imports.
const { createHash } = require("node:crypto");
const path = require("node:path");
const babel = require("@babel/core");
const esbuild = require("esbuild");

const LOADERS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".jsx": "jsx", ".js": "js", ".mjs": "js", ".cjs": "js" };
const VERSION = `${esbuild.version}/${babel.version}/3`;

// Jest without --experimental-vm-modules cannot run import(). This is all
// @babel/plugin-transform-dynamic-import does: it switches on the CommonJS
// plugin's own import() -> Promise-wrapped require().
const dynamicImportToRequire = () => ({ pre() { this.file.set("@babel/plugin-proposal-dynamic-import", babel.version); } });

module.exports = {
  getCacheKey(source, filename) {
    return createHash("sha256").update(VERSION).update("\0").update(filename).update("\0").update(source).digest("hex");
  },
  process(source, filename) {
    const usesImportMeta = source.includes("import.meta");
    const stripped = esbuild.transformSync(source, {
      loader: LOADERS[path.extname(filename)] ?? "js",
      format: "esm",
      target: "node22",
      jsx: "automatic",
      sourcemap: "inline",
      sourcefile: filename,
      // Jest runs CommonJS: import.meta.url becomes this file's URL.
      define: usesImportMeta ? { "import.meta.url": "__jestImportMetaUrl", "import.meta.dirname": "__dirname", "import.meta.filename": "__filename" } : undefined,
    });
    const out = babel.transformSync(stripped.code, {
      filename,
      babelrc: false,
      configFile: false,
      sourceMaps: "inline",
      plugins: ["babel-plugin-jest-hoist", dynamicImportToRequire, "@babel/plugin-transform-modules-commonjs"],
    });
    const banner = usesImportMeta ? 'var __jestImportMetaUrl = require("node:url").pathToFileURL(__filename).href;\n' : "";
    return { code: `${banner}${out.code}` };
  },
};
