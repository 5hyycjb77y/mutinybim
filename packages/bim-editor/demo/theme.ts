import type { MutinyTheme } from '@permitzip/bim-ui'

/** "#FBF6EA" → "43 69% 95%". Null when the color isn't hex. */
export function hexToHslTriple(color: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m || !m[1]) return null
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  const deg = Math.round((((h * 60) % 360) + 360) % 360)
  return `${deg} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

/**
 * Points the vendored shadcn/ui tokens (HSL components, read as
 * `hsl(var(--primary))` by tokens.css) at the Mutiny palette inside the
 * editor root, so buttons, menus and selects follow the MutinyBIM theme.
 * Non-hex colors are skipped (the token default stays).
 */
export function mutinyToShadcnVars(theme: MutinyTheme): Record<string, string> {
  const c = theme.colors
  const pairs: [string, string][] = [
    ['--background', c.surface],
    ['--foreground', c.text],
    ['--card', c.panel],
    ['--card-foreground', c.text],
    ['--popover', c.field],
    ['--popover-foreground', c.text],
    ['--primary', c.accent],
    ['--primary-foreground', c.accentForeground],
    ['--primary-50', c.accentSubtle],
    ['--primary-100', c.accentSubtle],
    ['--primary-400', c.focusRing],
    ['--primary-500', c.focusRing],
    ['--secondary', c.subtle],
    ['--secondary-foreground', c.text],
    ['--muted', c.subtle],
    ['--muted-foreground', c.muted],
    ['--accent', c.subtle],
    ['--accent-foreground', c.text],
    ['--destructive', c.danger],
    ['--destructive-foreground', c.dangerForeground],
    ['--border', c.border],
    ['--input', c.border],
    ['--ring', c.focusRing],
    ['--ring-3', c.focusRing],
  ]
  const vars: Record<string, string> = {}
  for (const [name, color] of pairs) {
    const triple = hexToHslTriple(color)
    if (triple) vars[name] = triple
  }
  vars['--radius'] = theme.radius
  vars['--font-heading'] = theme.typography.fontHeading
  return vars
}
