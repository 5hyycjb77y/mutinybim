/**
 * @jest-environment node
 */
import fs from 'node:fs'
import path from 'node:path'

// Host apps import `@permitzip/bim-editor/host` and `/host/context` on pages that never open
// the editor. Those entries must not reach the model engine. Nov 7 2026: the barrel re-exported
// the standalone host (`./local`, which imports the kernel), so a project page that only read
// the host context shipped the whole kernel, units and formulas on first load. The standalone
// host is its own entry, `@permitzip/bim-editor/host/local`.

const SRC = path.resolve(__dirname, '../src')
const ENGINE = [/^@permitzip\/bim-kernel($|\/)/, /^@permitzip\/bim-units($|\/)/, /^@permitzip\/bim-formula($|\/)/]
const EXTENSIONS = ['.ts', '.tsx']

function tryFile(base: string): string | null {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const ext of EXTENSIONS) if (fs.existsSync(base + ext)) return base + ext
  for (const ext of EXTENSIONS) if (fs.existsSync(path.join(base, `index${ext}`))) return path.join(base, `index${ext}`)
  return null
}

/** Value import specifiers: skips `import type`, all-`type` named lists and dynamic `import()`. */
function valueImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of code.matchAll(/(?:^|[\n;])[ \t]*(?:import|export)\s+((?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+|\*|[\w$]+))\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = (m[1] ?? '').trim()
    if (/^type\s/.test(clause)) continue
    const named = /^\{([\s\S]*)\}$/.exec(clause)
    const entries = named ? (named[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : []
    if (entries.length > 0 && entries.every((e) => /^type\s/.test(e))) continue
    if (m[2]) out.push(m[2])
  }
  for (const m of code.matchAll(/(?:^|[\n;])[ \t]*import\s*['"]([^'"]+)['"]/g)) if (m[1]) out.push(m[1])
  return out
}

function resolve(spec: string, from: string): string | null {
  if (spec.startsWith('.')) return tryFile(path.resolve(path.dirname(from), spec))
  if (spec === '@permitzip/bim-editor') return tryFile(path.join(SRC, 'index'))
  if (spec.startsWith('@permitzip/bim-editor/')) return tryFile(path.join(SRC, spec.slice('@permitzip/bim-editor/'.length)))
  return null
}

/** Engine packages statically reachable from `entry`, each with the file chain that reaches it. */
function engineReached(entry: string): string[] {
  const parent = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  const hits: string[] = []
  const chain = (file: string) => {
    const steps: string[] = []
    for (let at: string | null = file; at; at = parent.get(at) ?? null) steps.unshift(path.relative(SRC, at))
    return steps.join(' -> ')
  }
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const spec of valueImports(fs.readFileSync(file, 'utf8'))) {
      if (ENGINE.some((re) => re.test(spec))) {
        hits.push(`${spec} via ${chain(file)}`)
        continue
      }
      const next = resolve(spec, file)
      if (next && !parent.has(next)) {
        parent.set(next, file)
        queue.push(next)
      }
    }
  }
  return hits
}

describe('the host entries host apps load on every page', () => {
  const manifest: { exports: Record<string, string> } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))

  it('exports the context and the standalone host on their own subpaths', () => {
    expect(manifest.exports['./host/context']).toBe('./src/host/context.tsx')
    expect(manifest.exports['./host/local']).toBe('./src/host/local.ts')
  })

  it.each(['./host', './host/context'])('%s reaches no model engine', (sub) => {
    expect(engineReached(path.resolve(__dirname, '..', manifest.exports[sub] ?? ''))).toEqual([])
  })

  it('the walk sees the engine where it is: the standalone host imports the kernel', () => {
    expect(engineReached(path.join(SRC, 'host/local.ts')).some((hit) => hit.startsWith('@permitzip/bim-kernel'))).toBe(true)
  })

  it('reads value imports and skips type-only and dynamic ones', () => {
    const src = ["import type { A } from 'a'", "import { type B } from 'b'", "export { C } from './c'", "const D = () => import('d')", "import { E, type F } from 'e'"].join('\n')
    expect(valueImports(src).sort()).toEqual(['./c', 'e'])
  })
})
