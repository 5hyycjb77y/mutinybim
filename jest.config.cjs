/** Jest for every package and the model server. TypeScript is compiled by esbuild (tools/jest). */
module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["**/__tests__/**/*.test.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  testPathIgnorePatterns: ["/node_modules/"],
  transform: { "^.+\\.(c|m)?[jt]sx?$": "<rootDir>/tools/jest/esbuild-transform.cjs" },
  // three/examples and jose ship ES modules only.
  transformIgnorePatterns: ["/node_modules/(?!(three/examples|jose)/)"],
  moduleFileExtensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"],
  moduleNameMapper: { "\\.(css|less|scss)$": "<rootDir>/tools/jest/style-stub.cjs" },
  setupFiles: ["<rootDir>/tools/jest/polyfills.cjs"],
  setupFilesAfterEnv: ["<rootDir>/tools/jest/setup.cjs"],
  restoreMocks: true,
  testTimeout: Number(process.env.JEST_TEST_TIMEOUT || 20000),
  forceExit: true,
};
