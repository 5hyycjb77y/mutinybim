// The release version rule, without git or the environment (next-version.mjs
// feeds it; __tests__/versions.test.ts holds it).

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] of a plain release version, or null (pre-releases and anything else). */
export function parseVersion(text) {
  const m = RELEASE.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The next release: one patch above the newest `v<version>` tag, or the
 * manifests' version when it was set higher by hand (or there is no tag yet).
 */
export function nextVersion({ tags, manifestVersion }) {
  const manifest = parseVersion(manifestVersion);
  if (!manifest) throw new Error(`the manifests' version "${manifestVersion}" is not major.minor.patch`);
  const released = tags.map((t) => parseVersion(t.replace(/^v/, ""))).filter((v) => v !== null);
  if (released.length === 0) return manifest.join(".");
  const newest = released.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  if (compareVersions(manifest, newest) > 0) return manifest.join(".");
  return [newest[0], newest[1], newest[2] + 1].join(".");
}
