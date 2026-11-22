import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureEditorDemoBuilt, type BuildOptions, type BuildReport } from '../../demo/build'

const dir = await mkdtemp(path.join(os.tmpdir(), 'mutinybim-demo-cache-'))
const entry = path.join(dir, 'entry.ts')
const outDir = path.join(dir, 'dist')
let builds = 0
const options: BuildOptions = {
  entry, outDir,
  plugins: [{ name: 'count-test-builds', setup(build) { build.onStart(() => { builds++ }) } }],
}
const bundle = () => readFile(path.join(outDir, 'app.js'), 'utf8')

async function edit(source: string, previous: BuildReport) {
  await writeFile(entry, source)
  // A tracked input newer than the last build, without a wall-clock sleep.
  const newer = new Date(Date.parse(previous.builtAt) + 1)
  await utimes(entry, newer, newer)
}

try {
  await writeFile(entry, 'document.body.textContent = "before-edit";')
  // Keep the initial input unambiguously older than the first build, even if
  // the write and build start land in the same millisecond on a fast runner.
  await utimes(entry, new Date(0), new Date(0))
  switch (process.argv[2]) {
    case 'shares a build and reuses unchanged output': {
      const first = ensureEditorDemoBuilt(options)
      assert.equal(ensureEditorDemoBuilt(options), first)
      const report = await first
      const writtenAt = (await stat(path.join(outDir, 'app.js'))).mtimeMs
      assert.deepEqual(await ensureEditorDemoBuilt(options), report)
      assert.equal((await stat(path.join(outDir, 'app.js'))).mtimeMs, writtenAt)
      assert.equal(builds, 1)
      assert.match(await bundle(), /before-edit/)
      break
    }
    case 'rebuilds changed sources after success and cache hits': {
      const report = await ensureEditorDemoBuilt(options)
      await ensureEditorDemoBuilt(options)
      await edit('document.body.textContent = "after-edit";', report)
      const rebuild = ensureEditorDemoBuilt(options)
      assert.equal(ensureEditorDemoBuilt(options), rebuild)
      await rebuild
      assert.match(await bundle(), /after-edit/)
      assert.doesNotMatch(await bundle(), /before-edit/)
      assert.equal(builds, 2)
      break
    }
    case 'rebuilds missing output': {
      await ensureEditorDemoBuilt(options)
      await rm(path.join(outDir, 'app.js'))
      await ensureEditorDemoBuilt(options)
      assert.match(await bundle(), /before-edit/)
      assert.equal(builds, 2)
      break
    }
    case 'keeps good output and recovers after a failed rebuild': {
      const report = await ensureEditorDemoBuilt(options)
      await edit('export const = ;', report)
      await assert.rejects(ensureEditorDemoBuilt(options))
      assert.match(await bundle(), /before-edit/)
      await edit('document.body.textContent = "recovered-edit";', report)
      await ensureEditorDemoBuilt(options)
      assert.match(await bundle(), /recovered-edit/)
      assert.equal(builds, 3)
      break
    }
    case 'retries a failed first build': {
      await writeFile(entry, 'export const = ;')
      await assert.rejects(ensureEditorDemoBuilt(options))
      await writeFile(entry, 'document.body.textContent = "first-success";')
      await ensureEditorDemoBuilt(options)
      assert.match(await bundle(), /first-success/)
      assert.equal(builds, 2)
      break
    }
    case 'keeps the first build when not watching sources': {
      const fixed = { ...options, watchSources: false }
      const report = await ensureEditorDemoBuilt(fixed)
      await edit('document.body.textContent = "after-edit";', report)
      assert.deepEqual(await ensureEditorDemoBuilt(fixed), report)
      assert.match(await bundle(), /before-edit/)
      assert.equal(builds, 1)
      break
    }
    default: throw new Error(`Unknown build-cache scenario: ${process.argv[2]}`)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}
