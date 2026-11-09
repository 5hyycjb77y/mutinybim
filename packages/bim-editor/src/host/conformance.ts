import type { EditorDestination, EditorHost } from '@permitzip/bim-editor-host'

const SAMPLE_DESTINATIONS: readonly EditorDestination[] = [
  { kind: 'price_books' },
  { kind: 'connect_source_model', modelRef: 'conformance-model' },
  { kind: 'model_home', modelRef: 'conformance-model' },
]

/**
 * What every host must do, checked outside React (its hooks, the router's
 * location and preferences, are checked for shape only; render them in the
 * host's own tests). Returns the problems in plain words; empty means it
 * conforms.
 */
export async function checkEditorHostConformance(host: EditorHost): Promise<string[]> {
  const problems: string[] = []
  if (!host.identity.userId) problems.push('identity.userId is empty')
  if (!host.identity.displayName) problems.push('identity.displayName is empty')
  if (!host.capabilities.hostName) problems.push('capabilities.hostName is empty')

  const token = await host.session.getAccessToken()
  if (token !== null && (typeof token !== 'string' || token.length === 0)) problems.push('session.getAccessToken must give a non-empty string or null')

  for (const name of ['useLocation', 'push', 'replace'] as const) {
    if (typeof host.router[name] !== 'function') problems.push(`router.${name} is not a function`)
  }
  for (const name of ['success', 'error', 'info', 'warning'] as const) {
    if (typeof host.notify[name] !== 'function') problems.push(`notify.${name} is not a function`)
  }
  for (const destination of SAMPLE_DESTINATIONS) {
    const href = host.links.hrefFor(destination)
    if (href !== null && (typeof href !== 'string' || href.length === 0)) problems.push(`links.hrefFor(${destination.kind}) must give an address or null`)
  }

  if (typeof host.preferences.usePreferences !== 'function') problems.push('preferences.usePreferences is not a function')

  if (host.storage && (typeof host.storage.upload !== 'function' || typeof host.storage.urlFor !== 'function')) problems.push('storage is present but incomplete')
  if (host.agent) {
    if (typeof host.agent.ownThreadIdOn !== 'function' || typeof host.agent.subscribe !== 'function') problems.push('agent is present but incomplete')
    else {
      const thread = host.agent.ownThreadIdOn('conformance-model')
      if (thread !== null && (typeof thread !== 'string' || thread.length === 0)) problems.push('agent.ownThreadIdOn must give a thread id or null')
      const unsubscribe = host.agent.subscribe(() => {})
      if (typeof unsubscribe !== 'function') problems.push('agent.subscribe must return its unsubscribe function')
      else unsubscribe()
    }
  }
  return problems
}
