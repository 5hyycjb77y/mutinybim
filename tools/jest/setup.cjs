const fs = require("node:fs");
const path = require("node:path");

const hasDom = typeof window !== "undefined";
let cleanup = () => {};
if (hasDom) {
  require("@testing-library/jest-dom");
  cleanup = require("@testing-library/react").cleanup;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

for (const perf of [globalThis.performance, hasDom ? window.performance : undefined]) {
  if (perf && typeof perf.markResourceTiming !== "function") {
    Object.defineProperty(perf, "markResourceTiming", { configurable: true, writable: true, value: jest.fn() });
  }
}

afterEach(() => {
  cleanup();
  try {
    jest.clearAllTimers();
  } catch (err) {
    console.error("[jest setup] clearAllTimers failed", err);
  }
});

// Models open with the first-party add-ons installed, as every host does.
// A test that proves the bare kernel opts out with the marker @mutinybim-bare-kernel.
{
  const testPath = expect.getState().testPath;
  if (testPath && !fs.readFileSync(testPath, "utf8").includes("@mutinybim-bare-kernel")) {
    require(path.resolve(__dirname, "../../packages/bim-first-party/src/index.ts")).installFirstPartyAddOns();
  }
}
