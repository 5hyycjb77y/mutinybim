/**
 * The editor half of the local demo server: the editor page, its bundle
 * (build.ts), the static files the editor fetches at run time (pdf.js worker,
 * geometry and IFC WebAssembly, the 3D fragments worker, sheet fonts, brand
 * art) and plain-words 501s for the host app APIs a local demo doesn't have.
 * packages/bim-devserver mounts it next to the model server at /sync.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { defaultOutDir, ensureEditorDemoBuilt, REPO_ROOT, PACKAGES_DIR, type BuildOptions, type BuildReport } from './build'
import { MODEL_PATH } from './paths'

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

/**
 * Files libraries fetch from beside their own module (`new URL(…, import.meta.url)`
 * or a script-relative path), which esbuild doesn't copy: by file name, from
 * node_modules, wherever the browser asks for them.
 */
const BESIDE_MODULE: Readonly<Record<string, string>> = {
  'manifold.wasm': 'manifold-3d/manifold.wasm',
  'web-ifc.wasm': 'web-ifc/web-ifc.wasm',
  'web-ifc-mt.wasm': 'web-ifc/web-ifc-mt.wasm',
  'pdf.worker.min.mjs': 'pdfjs-dist/build/pdf.worker.min.mjs',
  'pdf.worker.mjs': 'pdfjs-dist/build/pdf.worker.mjs',
}

/** URL prefix → folder, for static files the editor reads by address. */
const STATIC_DIRS: ReadonlyArray<readonly [string, string]> = [
  ['/mutinybim/fonts/', path.join(REPO_ROOT, 'public/mutinybim/fonts')],
  ['/mutinybim/firm/', path.join(REPO_ROOT, 'public/mutinybim/firm')],
  ['/mutinybim/brand/', path.join(REPO_ROOT, 'public/mutinybim/brand')],
  ['/assets/bim-ui/', path.join(PACKAGES_DIR, 'bim-ui/assets')],
  ['/pdfjs/images/', path.join(REPO_ROOT, 'node_modules/pdfjs-dist/web/images')],
]

const NODE_MODULES = path.join(REPO_ROOT, 'node_modules')

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MutinyBIM editor (local demo)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/bim-ui/mutiny-icon.svg">
<link rel="stylesheet" href="/dist/styles.css">
<script>
/* Keep what the editor reports (console errors and warnings, uncaught errors) in window.__demoLog, for the demo's checks. */
window.__demoLog = [];
(function () {
  function text(v) { try { return v instanceof Error ? String(v.stack || v) : typeof v === 'object' ? JSON.stringify(v) : String(v) } catch (e) { return String(v) } }
  ['error', 'warn'].forEach(function (level) {
    var original = console[level];
    console[level] = function () { window.__demoLog.push(level + ': ' + Array.prototype.map.call(arguments, text).join(' ').slice(0, 2000)); return original.apply(console, arguments) };
  });
  window.addEventListener('error', function (e) { window.__demoLog.push('uncaught: ' + text(e.error || e.message)) });
  window.addEventListener('unhandledrejection', function (e) { window.__demoLog.push('unhandled rejection: ' + text(e.reason)) });
})();
</script></head>
<body><div id="app"></div><script type="module" src="/dist/app.js"></script></body></html>`

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

function failedPage(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MutinyBIM editor didn't build</title></head>
<body style="font: 15px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem">
<h1 style="font-size: 1.3rem">The editor didn't build</h1>
<p>The model server is running, but the editor page couldn't be built. The terminal running <code>npm run demo</code> has the full error. Fix it and reload this page to try again.</p>
<pre style="white-space: pre-wrap; background: #f4f1ea; padding: 1rem; border-radius: 6px">${escapeHtml(message.slice(0, 4000))}</pre>
<p>The model itself still works: <a href="/feasibility">open the small feasibility viewer</a>.</p>
</body></html>`
}

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, 'application/json', JSON.stringify(body))
}

/** A file under `base`, or null when the path escapes it or does not exist. */
async function fileUnder(base: string, relative: string): Promise<{ data: Buffer; type: string } | null> {
  const file = path.resolve(base, `.${path.sep}${relative}`)
  if (!file.startsWith(base + path.sep)) return null
  try {
    return { data: await readFile(file), type: TYPES[path.extname(file)] ?? 'application/octet-stream' }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR')) return null
    throw err
  }
}

/** What each host app API is, in words, for the 501 the editor shows. */
function missingThing(pathname: string): string {
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [/\/ui-prefs/, 'saved editor preferences'],
    [/\/design-limits/, "the firm's design limits"],
    [/\/route-defaults/, 'saved route defaults'],
    [/\/equipment|\/library/, 'the firm equipment library'],
    [/\/part/, 'the firm part library'],
    [/\/sheet-images|\/backgrounds|\/underlay/, 'stored drawings and images'],
    [/\/view-display/, 'saved view display settings'],
    [/\/revit/, 'a linked Revit model'],
    [/\/agent|\/threads?/, 'a built-in AI agent (connect your own instead: docs/CONNECT-AN-AGENT.md)'],
    [/\/questions?/, 'project questions'],
    [/\/code-stud|\/codes?/, 'a project code study'],
    [/\/schedules?/, 'saved project schedules'],
    [/\/storage|\/files?/, 'project file storage'],
  ]
  const hit = rules.find(([re]) => re.test(pathname))
  return hit ? hit[1] : `a host app server (${pathname})`
}

export interface EditorDemoAuthority {
  readonly url: string
  readonly modelId: string
  readonly mainModelId?: string
  readonly branchId?: string
}

export interface EditorDemoOptions extends BuildOptions {
  /** The model server address and model id the editor opens for a project (and branch). Null branch: Main. */
  readonly authority: (branch: string | null) => Promise<EditorDemoAuthority | { readonly error: string }>
  /** The model id `/` sends people to. */
  readonly mainModelId: () => Promise<string>
}

export interface EditorDemo {
  /** Start building (or reuse the cached build) now, so the first page load doesn't wait. */
  warm(): void
  /** Answers the request when it is one of the editor's; false when it isn't. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>
  readonly outDir: string
}

export function createEditorDemo(options: EditorDemoOptions): EditorDemo {
  const outDir = options.outDir ?? defaultOutDir()
  const buildOptions: BuildOptions = { ...options, outDir }
  let lastError: string | null = null
  /** Every /api request the editor made, in order of first call, with a count. */
  const apiCalls = new Map<string, number>()

  const built = async (): Promise<BuildReport | null> => {
    try {
      const report = await ensureEditorDemoBuilt(buildOptions)
      lastError = null
      return report
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.error('[editor-demo] the editor build is unavailable', { outDir, err })
      return null
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url
    const key = `${req.method ?? 'GET'} ${pathname}`
    const first = !apiCalls.has(key)
    apiCalls.set(key, (apiCalls.get(key) ?? 0) + 1)
    if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/building-model$/.test(pathname)) {
      const authority = await options.authority(url.searchParams.get('branch'))
      if ('error' in authority) return json(res, 400, { error: authority.error })
      return json(res, 200, { projectNumber: 'DEMO', references: [], authority })
    }
    if (req.method === 'GET' && pathname === '/api/building-model/fragments-worker') {
      const worker = await fileUnder(NODE_MODULES, '@thatopen/fragments/dist/Worker/worker.mjs')
      if (worker) return send(res, 200, worker.type, worker.data)
      console.error('[editor-demo] @thatopen/fragments is not installed; the 3D view has no fragments worker')
      return json(res, 404, { error: 'The 3D view needs @thatopen/fragments, which is not installed here. Run npm install.' })
    }
    if (first) console.log('[editor-demo] not available here', key)
    return json(res, 501, { error: `This needs ${missingThing(pathname)}, which the local demo doesn't have.` })
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url
    if (pathname.startsWith('/api/')) {
      await api(req, res, url)
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (pathname === '/') {
      res.writeHead(302, { location: `/m/${encodeURIComponent(await options.mainModelId())}?view=plan` })
      res.end()
      return true
    }
    if (pathname === '/debug/api-calls') {
      json(res, 200, Object.fromEntries(apiCalls))
      return true
    }
    for (const [prefix, dir] of STATIC_DIRS) {
      if (!pathname.startsWith(prefix)) continue
      const file = await fileUnder(dir, decodeURIComponent(pathname.slice(prefix.length)))
      if (file) send(res, 200, file.type, file.data, { 'cache-control': 'public, max-age=3600' })
      else send(res, 404, 'text/plain; charset=utf-8', `Not here: ${pathname}`)
      return true
    }
    const beside = BESIDE_MODULE[path.posix.basename(pathname)]
    if (beside && !pathname.startsWith('/dist/')) {
      const file = await fileUnder(NODE_MODULES, beside)
      if (file) send(res, 200, file.type, file.data)
      else send(res, 404, 'text/plain; charset=utf-8', `${beside} is not installed here. Run npm install.`)
      return true
    }
    if (MODEL_PATH.test(pathname)) {
      const report = await built()
      if (report) send(res, 200, 'text/html; charset=utf-8', INDEX_HTML)
      else send(res, 503, 'text/html; charset=utf-8', failedPage(lastError ?? 'Unknown build error.'))
      return true
    }
    if (pathname.startsWith('/dist/')) {
      const report = await built()
      if (!report) {
        send(res, 503, 'text/plain; charset=utf-8', `The editor didn't build: ${lastError ?? 'unknown error'}`)
        return true
      }
      const file = await fileUnder(outDir, pathname.slice('/dist/'.length))
      if (file) {
        send(res, 200, file.type, file.data)
        return true
      }
      const fallback = beside ? await fileUnder(NODE_MODULES, beside) : null
      if (fallback) send(res, 200, fallback.type, fallback.data)
      else send(res, 404, 'text/plain; charset=utf-8', `Not in the editor build: ${pathname}`)
      return true
    }
    return false
  }

  return {
    outDir,
    warm() {
      void built()
    },
    handle,
  }
}
