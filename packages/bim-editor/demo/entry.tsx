/**
 * The full Building Model editor in a plain browser page, against the local
 * model server (packages/bim-devserver serves this page, the bundle build.ts
 * makes and the model at /sync). Package imports only: this file ships in the
 * open-source tree.
 */
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { MutinyThemeProvider, useMutinyPortalContainer, type MutinyThemeOverrides } from '@permitzip/bim-ui'
import { EditorHostProvider } from '@permitzip/bim-editor/host'
import { createLocalEditorHost } from '@permitzip/bim-editor/host/local'
import { PortalContainerProvider } from '@permitzip/bim-editor/ui/overlay-boundary'
import { TooltipProvider } from '@permitzip/bim-editor/ui/tooltip'
import { BuildingModelSurface, type BuildingModelView } from '@permitzip/bim-editor/editor/BuildingModelSurface'
import { mutinyToShadcnVars } from './theme'
import { MODEL_PATH } from './paths'

const THEME: MutinyThemeOverrides = {
  brand: { logoUrl: '/assets/bim-ui/mutiny-logo.png', iconUrl: '/assets/bim-ui/mutiny-icon.svg' },
}

const projectId = decodeURIComponent(window.location.pathname.match(MODEL_PATH)?.[1] ?? 'demo')
const params = new URLSearchParams(window.location.search)
const viewParam = params.get('view')
const initialView: BuildingModelView = viewParam === '3d' || viewParam === 'sheet' ? viewParam : 'plan'
const userName = params.get('name') ?? 'You'

/** The dev server's in-process model, or a real model server it points at (docker compose up) with a local sign-in. */
type DemoConfig =
  | { readonly authority: 'in-process' }
  | { readonly authority: 'external'; readonly authorityUrl: string; readonly token: string; readonly userId: string; readonly displayName: string }

function isDemoConfig(value: unknown): value is DemoConfig {
  if (typeof value !== 'object' || value === null || !('authority' in value)) return false
  if (value.authority === 'in-process') return true
  return value.authority === 'external' && 'authorityUrl' in value && typeof value.authorityUrl === 'string' && 'token' in value && typeof value.token === 'string' && 'userId' in value && typeof value.userId === 'string' && 'displayName' in value && typeof value.displayName === 'string'
}

async function loadDemoConfig(): Promise<DemoConfig> {
  const res = await fetch(`/demo-config.json?name=${encodeURIComponent(userName)}`)
  const body: unknown = await res.json()
  if (!res.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : `The dev server answered ${res.status} for its configuration.`)
  if (!isDemoConfig(body)) throw new Error('The dev server sent a configuration this page does not understand.')
  return body
}

/** Menus, selects and dialogs mount inside the Mutiny root so they wear its palette (as the standalone window does). */
function Overlays({ children }: { children: ReactNode }) {
  const root = useMutinyPortalContainer()
  return <PortalContainerProvider container={root}>{children}</PortalContainerProvider>
}

const mount = document.getElementById('app')
if (!mount) throw new Error('[editor-demo] the page has no #app element')
const root = createRoot(mount)

function render(config: DemoConfig) {
  const external = config.authority === 'external' ? config : null
  const userId = external?.userId ?? `local-${userName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const displayName = external?.displayName ?? userName
  const host = createLocalEditorHost({
    authorityUrl: external?.authorityUrl ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/sync`,
    userId,
    displayName,
    ...(external ? { token: external.token } : {}),
    connectHint: 'Connect your own AI to this model with the tool server (docs/CONNECT-AN-AGENT.md).',
  })
  root.render(
    <StrictMode>
      <MutinyThemeProvider presentation="standalone" theme={THEME} hostVars={mutinyToShadcnVars} applyToDocument className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-(--mutiny-surface)" data-testid="mutiny-root">
        <TooltipProvider>
          <Overlays>
            <EditorHostProvider host={host}>
              <BuildingModelSurface projectId={projectId} projectName="Local demo" projectNumber="DEMO" userId={userId} userName={displayName} initialView={initialView} />
            </EditorHostProvider>
          </Overlays>
        </TooltipProvider>
        <Toaster />
      </MutinyThemeProvider>
    </StrictMode>,
  )
}

loadDemoConfig().then(render, (err: unknown) => {
  console.error('[editor-demo] could not read the dev server configuration', err)
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.style.cssText = 'font: 14px system-ui, sans-serif; padding: 24px; max-width: 40rem'
  message.textContent = `The editor could not start: ${err instanceof Error ? err.message : String(err)} Reload once the dev server is running.`
  mount.replaceChildren(message)
})
