/** @jest-environment node */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(__dirname, '../../..')
const FIXTURE = path.join(__dirname, 'fixtures/demo-build-cache.ts')

// Exercise the real Node/esbuild/Tailwind path, outside Jest's module transforms
// and VM realm, just as the running demo does. Each scenario owns a temp folder.
describe('the local demo build cache in one server process', () => {
  it.each([
    'shares a build and reuses unchanged output',
    'rebuilds changed sources after success and cache hits',
    'rebuilds missing output',
    'keeps good output and recovers after a failed rebuild',
    'retries a failed first build',
    'keeps the first build when not watching sources',
  ])('%s', async (scenario) => {
    try {
      await run(process.execPath, ['--import', 'tsx', FIXTURE, scenario], { cwd: ROOT })
    } catch (err) {
      const result = err as Error & { stdout?: string; stderr?: string }
      throw new Error(`${result.message}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    }
  })
})
