// MutinyBIM lint: the open-source boundary and the layer rules. A rule here
// stays "error"; a layer debt only goes down (see the kernel's import-layer tests).
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import mutinybimOssBoundaryPlugin from "./eslint/plugins/mutinybim-oss-boundary.mjs";
import mutinybimNoProprietaryPlugin from "./eslint/plugins/mutinybim-no-proprietary.mjs";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "coverage/**"] },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } } },
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    // The UI packages also render inside Next.js hosts, whose lint has these rules; their disable comments must resolve here.
    files: ["packages/bim-ui/**/*.{ts,tsx}", "packages/bim-editor/**/*.{ts,tsx}", "packages/bim-editor-host/**/*.{ts,tsx}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: {
      "@next/next": { rules: { "no-img-element": { meta: { type: "problem", schema: [] }, create: () => ({}) } } },
      "react-hooks": { rules: { "exhaustive-deps": { meta: { type: "suggestion", schema: [] }, create: () => ({}) }, "rules-of-hooks": { meta: { type: "problem", schema: [] }, create: () => ({}) } } },
    },
  },

  // MutinyBIM open-source boundary — packages/bim-* and services/bim-authority
  // ship under Apache-2.0 and must run standalone. They may not import Hours
  // code (@/..., or a relative path out of the MutinyBIM trees), closed
  // @permitzip packages, or GPL / AGPL / commercial packages (HyperFormula,
  // Tiptap Pro, AG Grid Enterprise...). Hours plugs in through documented
  // extension points. Stays "error". License fields and LICENSE files:
  // eslint/plugins/mutinybim-oss-boundary-licenses.mjs. SCHEDULES-PLAN §9.
  // ==========================================================================
  {
    files: [
      "packages/bim-*/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "services/bim-authority/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "apps/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
    ],
    plugins: {
      "permitzip-mutinybim-oss": mutinybimOssBoundaryPlugin,
    },
    rules: {
      "permitzip-mutinybim-oss/no-closed-or-copyleft-import": "error",
    },
  },

  // MutinyBIM never reaches PermitZIP's code studies (round 7, lane P): no
  // lib/code-study, lib/code-library, @/lib, app/ import and no `codes.`
  // schema reference in packages/bim-* or services/bim-authority. Our code
  // studies arrive only through kernel.requirements_source (the connector is
  // lib/bim/requirements-source). Stays "error".
  {
    files: [
      "packages/bim-*/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "services/bim-authority/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
      "apps/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
    ],
    plugins: {
      "permitzip-mutinybim-proprietary": mutinybimNoProprietaryPlugin,
    },
    rules: {
      "permitzip-mutinybim-proprietary/no-proprietary-in-kernel": "error",
    },
  },

  // ==========================================================================
  // MutinyBIM layers (KERNEL-FOUNDATION §2). Runtime cycles and today's layer
  // debts are ratcheted by packages/bim-kernel/src/__tests__/import-layers.test.ts
  // (+ import-cycles.baseline.json, shrink-only); these blocks flag a new edge
  // in the editor. Type-only imports are allowed. Stays "error".
  // ==========================================================================
  {
    files: ["packages/bim-kernel/src/**/*.ts", "packages/bim-kernel/src/**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["@permitzip/bim-calc", "@permitzip/bim-calc/*", "@permitzip/bim-lint", "@permitzip/bim-sheets", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-library", "@permitzip/bim-library/*", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@permitzip/bim-pack", "@permitzip/bim-pack-*", "@permitzip/bim-first-party"], message: "The kernel imports no package built on it." }] }],
    },
  },
  {
    // After the kernel-wide block (a later block replaces the rule), so it repeats its packages.
    files: ["packages/bim-kernel/src/registry/**/*.ts", "packages/bim-kernel/src/parts.ts", "packages/bim-kernel/src/types.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/connections/**", "**/routing/**", "**/load-points/**", "@permitzip/bim-calc", "@permitzip/bim-calc/*", "@permitzip/bim-lint", "@permitzip/bim-sheets", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-library", "@permitzip/bim-library/*", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@permitzip/bim-pack", "@permitzip/bim-pack-*", "@permitzip/bim-first-party"], allowTypeImports: true, message: "L1 schema imports no domain (connections, routing, load-points); a domain registers into the schema instead." }] }],
    },
  },
  {
    // Same rule; the four imports listed are today's debts (import-cycles.baseline.json).
    files: ["packages/bim-kernel/src/catalog/types.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ regex: "(^|/)(connections|routing|load-points)/(?!(electrical/load-classes|types|pipe/pipe-types|pipe/plumbing-settings)$)", allowTypeImports: true, message: "L1 schema imports no domain (connections, routing, load-points)." }, { group: ["@permitzip/bim-calc", "@permitzip/bim-calc/*", "@permitzip/bim-lint", "@permitzip/bim-sheets", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-library", "@permitzip/bim-library/*", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@permitzip/bim-pack", "@permitzip/bim-pack-*", "@permitzip/bim-first-party"], message: "The kernel imports no package built on it." }] }],
    },
  },
  {
    // After the kernel-wide block: it replaces that rule on this file, so it repeats its packages.
    files: ["packages/bim-kernel/src/command-core.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["./commands", "./commands/*", "./*/commands", "./**/*-commands", "./schedules/**", "./drawing/**", "./diagrams/**", "./crop", "./view3d", "@permitzip/bim-calc", "@permitzip/bim-calc/*", "@permitzip/bim-lint", "@permitzip/bim-sheets", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-library", "@permitzip/bim-library/*", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@permitzip/bim-pack", "@permitzip/bim-pack-*", "@permitzip/bim-first-party"], allowTypeImports: true, message: "The edit spine imports no command module and no derived output; register through the handler table (registerCommandParser / registerEditHook)." }] }],
    },
  },
  {
    // Packages and the model server reach the kernel through its public entries only.
    // Today's debts (baseline): bim-lint/src/rules/packs/questions.ts, bim-sheets/src/blocks.ts.
    // Each has a subpath to switch to (/questions, /blocks). The drainage debts left with the plumbing add-on (round 6).
    files: ["packages/bim-*/src/**/*.{ts,tsx}", "services/bim-authority/src/**/*.ts"],
    ignores: ["packages/bim-kernel/**", "packages/bim-lint/src/rules/packs/questions.ts", "packages/bim-sheets/src/blocks.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/bim-kernel/src/**"], message: "Import @permitzip/bim-kernel or a subpath in its package.json exports, never its src." }] }],
    },
  },
  {
    // Shared MutinyBIM packages import no add-on (round 6; CI half: packages/bim-lint/__tests__/c6x-no-addon-cycle.test.ts).
    // After the public-entry block above, which it replaces on these files, so it repeats that block's pattern and debts.
    files: ["packages/bim-{lint,calc,library,sheets,pack,sync,units,formula,geometry}/src/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**", "packages/bim-lint/src/rules/packs/questions.ts", "packages/bim-sheets/src/blocks.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/bim-kernel/src/**"], message: "Import @permitzip/bim-kernel or a subpath in its package.json exports, never its src." }, { group: ["@permitzip/bim-pack-electrical", "@permitzip/bim-pack-electrical/*", "@permitzip/bim-pack-plumbing", "@permitzip/bim-pack-plumbing/*", "@permitzip/bim-pack-mechanical", "@permitzip/bim-pack-mechanical/*", "@permitzip/bim-pack-structural", "@permitzip/bim-pack-structural/*", "@permitzip/bim-pack-civil", "@permitzip/bim-pack-civil/*", "@permitzip/bim-pack-architecture", "@permitzip/bim-pack-architecture/*", "@permitzip/bim-first-party", "**/bim-pack-electrical/**", "**/bim-pack-plumbing/**", "**/bim-pack-mechanical/**", "**/bim-pack-structural/**", "**/bim-pack-civil/**", "**/bim-pack-architecture/**", "**/bim-first-party/**"], message: "Shared MutinyBIM packages import no add-on; add-ons contribute rows instead." }] }],
    },
  },
  {
    // Proof packs (STATUS "Proof rule for 5c-6 and 5c-7") are built only through the add-on contract.
    // After the public-entry block above, which also matches these files; repeats its pattern.
    // CI half: packages/bim-kernel/__tests__/c5k-proof-pack-isolation.test.ts and scripts/bim/check-proof-pack-commits.sh.
    files: ["packages/bim-pack-structural/**/*.{ts,tsx}", "packages/bim-pack-civil/**/*.{ts,tsx}"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/bim-kernel/src/**", "**/bim-*/src/**", "@permitzip/bim-calc", "@permitzip/bim-calc/*", "@permitzip/bim-lint", "@permitzip/bim-lint/*", "@permitzip/bim-library", "@permitzip/bim-library/*", "@permitzip/bim-sheets", "@permitzip/bim-sheets/*", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-ifc", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@/*"], message: "A proof pack imports only @permitzip/bim-pack, @permitzip/bim-units, zod and the kernel's published subpaths. A missing extension point goes into the contract first, in its own commit." }] }],
    },
  },
  {
    // First-party add-ons (round 6): built through the add-on contract like the proof packs, plus the shared calc library.
    // The kernel never imports them: packages/bim-kernel/src/__tests__/c6k-kernel-imports-no-addon.test.ts.
    files: ["packages/bim-pack-electrical/**/*.{ts,tsx}", "packages/bim-pack-plumbing/**/*.{ts,tsx}", "packages/bim-pack-mechanical/**/*.{ts,tsx}", "packages/bim-pack-architecture/**/*.{ts,tsx}", "packages/bim-first-party/**/*.{ts,tsx}"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/bim-kernel/src/**", "**/bim-*/src/**", "@permitzip/bim-lint/*", "@permitzip/bim-library/*", "@permitzip/bim-sheets", "@permitzip/bim-sheets/*", "@permitzip/bim-sync", "@permitzip/bim-sync/*", "@permitzip/bim-ifc", "@permitzip/bim-ui", "@permitzip/bim-viewer", "@permitzip/bim-viewer-3d", "@permitzip/bim-viewer-3d/*", "@permitzip/bim-grid", "@permitzip/bim-schedules-ui", "@/*"], message: "A first-party add-on imports only @permitzip/bim-pack, @permitzip/bim-units, @permitzip/bim-calc, @permitzip/bim-lint, @permitzip/bim-library, zod, other first-party add-ons and the kernel's published subpaths. A missing extension point goes into the contract first." }] }],
    },
  },
  {
    // Last: the public-entry block above also matches these files and would replace this rule.
    files: ["packages/bim-units/src/**/*.ts", "packages/bim-formula/src/**/*.ts", "packages/bim-geometry/src/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["@permitzip/bim-kernel", "@permitzip/bim-kernel/*", "@permitzip/bim-calc", "@permitzip/bim-lint", "@permitzip/bim-sync", "@permitzip/bim-sheets", "@permitzip/bim-library", "**/bim-kernel/**"], allowTypeImports: true, message: "L0 primitives (bim-units, bim-formula, bim-geometry) import nothing above them." }] }],
    },
  },
];
