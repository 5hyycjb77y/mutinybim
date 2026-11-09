/**
 * Builds the plain-browser editor demo: one code-split esbuild bundle of
 * entry.tsx and one Tailwind v4 stylesheet (styles.css). The dev server
 * (packages/bim-devserver) calls `ensureEditorDemoBuilt` on start and serves
 * the result; it rebuilds only when a source file is newer than the build.
 *
 * Output goes outside the checkout (the OS temp folder, or MUTINYBIM_DEMO_OUT).
 * Run it by hand to force a rebuild:
 *
 *   node --import tsx packages/bim-editor/demo/build.ts
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, type Plugin } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

export const DEMO_DIR = path.dirname(fileURLToPath(import.meta.url))
/** The folder holding every bim-* package (`packages/`). */
export const PACKAGES_DIR = path.resolve(DEMO_DIR, '../..')
/** The repository root: where `node_modules` and `public/` are. */
export const REPO_ROOT = path.resolve(PACKAGES_DIR, '..')

const ENTRY = path.join(DEMO_DIR, 'entry.tsx')
const STYLES = path.join(DEMO_DIR, 'styles.css')
/** Files that change the build without being esbuild inputs. */
const BUILD_FILES = [STYLES, path.join(DEMO_DIR, 'tokens.css'), fileURLToPath(import.meta.url)]

export interface BuildReport {
  readonly builtAt: string
  readonly ms: number
  readonly jsBytes: number
  readonly cssBytes: number
  readonly files: number
  readonly entryBytes: number
  /** Every source file the bundle read (absolute): a newer one means rebuild. */
  readonly inputs: readonly string[]
  readonly warnings: readonly string[]
}

export interface BuildOptions {
  readonly outDir?: string
  /** Extra esbuild plugins, run before the demo's own resolver. */
  readonly plugins?: readonly Plugin[]
  /** The TypeScript config esbuild reads paths and JSX settings from. */
  readonly tsconfig?: string
  /** The page script to bundle in place of this demo's entry.tsx (another app hosting the editor). */
  readonly entry?: string
}

/** One folder per checkout, so two checkouts on one computer don't share a build. */
export function defaultOutDir(): string {
  const fromEnv = process.env.MUTINYBIM_DEMO_OUT
  if (fromEnv) return path.resolve(fromEnv)
  const key = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), 'mutinybim-editor-demo', key)
}

function demoResolve(): Plugin {
  return {
    name: 'mutinybim-editor-demo-resolve',
    setup(b) {
      // manifold-3d and web-ifc import node: modules only when they run under Node; the browser never takes that branch.
      b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }))
      b.onResolve({ filter: /^next(\/|$)/ }, (args) => ({
        errors: [{ text: `"${args.path}" (imported by ${path.relative(REPO_ROOT, args.importer)}) is Next.js. The open editor reads routing, links and lazy parts through the editor host (@permitzip/bim-editor/host, @permitzip/bim-editor/client-only).` }],
      }))
      b.onResolve({ filter: /^@\// }, (args) => ({
        errors: [{ text: `"${args.path}" (imported by ${path.relative(REPO_ROOT, args.importer)}) is host app code. The open editor may import only @permitzip/bim-* packages and its own files.` }],
      }))
    },
  }
}

/** `entry`: another app's page script; its own Tailwind classes are added to the sheet. */
async function buildCss(entry?: string): Promise<string> {
  const base = await readFile(STYLES, 'utf8')
  const source = entry ? `${base}\n@source "${path.relative(DEMO_DIR, entry).split(path.sep).join('/')}";\n` : base
  const result = await postcss([tailwind({ base: DEMO_DIR })]).process(source, { from: STYLES })
  return result.css
}

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

function isBuildReport(value: unknown): value is BuildReport {
  return typeof value === 'object' && value !== null && 'builtAt' in value && typeof value.builtAt === 'string' && 'inputs' in value && Array.isArray(value.inputs)
}

/** The previous build's report when its output is there and no source changed since; null otherwise. */
export async function freshBuild(outDir: string = defaultOutDir()): Promise<BuildReport | null> {
  let report: unknown
  try {
    report = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'))
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null
    console.error('[editor-demo] the previous build report is unreadable; rebuilding', { outDir, err })
    return null
  }
  if (!isBuildReport(report)) return null
  const builtAt = Date.parse(report.builtAt)
  for (const out of ['app.js', 'styles.css']) if ((await mtimeMs(path.join(outDir, out))) === null) return null
  for (const file of [...BUILD_FILES, ...report.inputs]) {
    const changed = await mtimeMs(file)
    if (changed === null || changed > builtAt) return null
  }
  return report
}

export async function buildEditorDemo(options: BuildOptions = {}): Promise<BuildReport> {
  const finalDir = options.outDir ?? defaultOutDir()
  // Build beside the current one and swap on success, so a failed rebuild keeps the last good build.
  const outDir = `${finalDir}.next`
  const started = performance.now()
  const startedAt = new Date().toISOString()
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const result = await build({
    entryPoints: { app: options.entry ?? ENTRY },
    absWorkingDir: REPO_ROOT,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outdir: outDir,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    minify: true,
    sourcemap: 'linked',
    metafile: true,
    jsx: 'automatic',
    tsconfig: options.tsconfig ?? path.join(PACKAGES_DIR, 'tsconfig.bim.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'globalThis.process ??= { env: {} };' },
    loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.wasm': 'file', '.glb': 'file' },
    plugins: [...(options.plugins ?? []), demoResolve()],
    logLevel: 'warning',
    logLimit: 0,
  })
  const css = await buildCss(options.entry)
  await writeFile(path.join(outDir, 'styles.css'), css)

  const outputs = Object.entries(result.metafile.outputs)
  const report: BuildReport = {
    builtAt: startedAt,
    ms: Math.round(performance.now() - started),
    jsBytes: outputs.filter(([file]) => file.endsWith('.js')).reduce((sum, [, o]) => sum + o.bytes, 0),
    cssBytes: Buffer.byteLength(css),
    files: outputs.length,
    entryBytes: outputs.find(([file]) => file.endsWith('/app.js'))?.[1].bytes ?? 0,
    inputs: Object.keys(result.metafile.inputs)
      .filter((file) => !file.includes(':'))
      .map((file) => path.resolve(REPO_ROOT, file)),
    warnings: result.warnings.map((w) => `${w.location?.file ?? '?'}:${w.location?.line ?? '?'} ${w.text}`),
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  await rm(finalDir, { recursive: true, force: true })
  await rename(outDir, finalDir)
  console.log('[editor-demo] built', {
    out: finalDir,
    ms: report.ms,
    jsMb: (report.jsBytes / 1e6).toFixed(2),
    entryKb: Math.round(report.entryBytes / 1e3),
    cssKb: Math.round(report.cssBytes / 1e3),
    files: report.files,
    warnings: report.warnings.length,
  })
  return report
}

const pending = new Map<string, Promise<BuildReport>>()

/** The current build: the cached one when nothing changed, else a new one. Concurrent callers share one build. */
export function ensureEditorDemoBuilt(options: BuildOptions = {}): Promise<BuildReport> {
  const outDir = options.outDir ?? defaultOutDir()
  const running = pending.get(outDir)
  if (running) return running
  const next = (async () => {
    const fresh = await freshBuild(outDir)
    if (fresh) {
      console.log('[editor-demo] using the cached build', { out: outDir, builtAt: fresh.builtAt })
      return fresh
    }
    console.log('[editor-demo] building the editor (first start or sources changed; about a minute)', { out: outDir })
    return buildEditorDemo({ ...options, outDir })
  })()
  pending.set(outDir, next)
  next.catch((err: unknown) => {
    console.error('[editor-demo] build failed', err)
    pending.delete(outDir)
  })
  return next
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildEditorDemo().catch((err: unknown) => {
    console.error('[editor-demo] build failed', err)
    process.exit(1)
  })
}
