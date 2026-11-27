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
import { nativeSignIn, readNativeCallback } from './native-signin'
import { nativeRevocation, NativeSignedOut } from './native-signout'
import { createDemoFirmParts } from './local-firm-parts'

const THEME: MutinyThemeOverrides = {
  brand: { logoUrl: '/assets/bim-ui/mutiny-logo.png', iconUrl: '/assets/bim-ui/mutiny-icon.svg' },
}

const callback = readNativeCallback()
const userName = new URLSearchParams(location.search).get('name') ?? 'You'

/** The dev server's in-process model, or a real model server it points at (docker compose up) with a local sign-in. */
type DemoConfig =
  | { readonly authority: 'in-process'; readonly firmPartsId?: string }
  | { readonly authority: 'native'; readonly authorityUrl: string }
  | { readonly authority: 'external'; readonly authorityUrl: string; readonly token: string; readonly userId: string; readonly displayName: string; readonly requireWriteGrant?: boolean }

function isDemoConfig(value: unknown): value is DemoConfig {
  if (typeof value !== 'object' || value === null || !('authority' in value)) return false
  if (value.authority === 'in-process') return !('firmPartsId' in value) || typeof value.firmPartsId === 'string'
  if (value.authority === 'native') return 'authorityUrl' in value && typeof value.authorityUrl === 'string'
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

function renderFrame(content: ReactNode) {
  root.render(
    <StrictMode>
      <MutinyThemeProvider presentation="standalone" theme={THEME} hostVars={mutinyToShadcnVars} applyToDocument className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-(--mutiny-surface)" data-testid="mutiny-root">
        <TooltipProvider><Overlays>{content}</Overlays></TooltipProvider>
        <Toaster />
      </MutinyThemeProvider>
    </StrictMode>
  )
}


function render(config: Exclude<DemoConfig, { authority: 'native' }>, nativeMembership: boolean) {
  const projectId = decodeURIComponent(location.pathname.match(MODEL_PATH)?.[1] ?? 'demo')
  const viewParam = new URLSearchParams(location.search).get('view')
  const initialView: BuildingModelView = viewParam === '3d' || viewParam === 'sheet' ? viewParam : 'plan'
  const external = config.authority === 'external' ? config : null
  const userId = external?.userId ?? `local-${userName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const displayName = external?.displayName ?? userName
  const firmParts = config.authority === 'in-process' && config.firmPartsId
    ? createDemoFirmParts(config.firmPartsId, userName, () => window.localStorage) : undefined
  const host = createLocalEditorHost({
    nativeMembership,
    authorityUrl: external?.authorityUrl ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/sync`,
    userId,
    displayName,
    firmParts,
    ...(external ? { token: external.token, requireWriteGrant: external.requireWriteGrant } : {}),
    connectHint: 'Connect your own AI to this model with the tool server (docs/CONNECT-AN-AGENT.md).',
  })
  let signingOut = false
  const signOut = nativeMembership && external ? () => {
    if (signingOut) return
    signingOut = true
    renderFrame(<NativeSignedOut confirm={nativeRevocation(external.token)} signIn={() => location.reload()} />)
  } : undefined
  renderFrame(
    <EditorHostProvider host={host}>
      <BuildingModelSurface projectId={projectId} projectName={external?.requireWriteGrant ? projectId : 'Local demo'} projectNumber={external?.requireWriteGrant ? undefined : 'DEMO'} userId={userId} userName={displayName} initialView={initialView} onSignOut={signOut} />
    </EditorHostProvider>
  )
  void firmParts?.recoverPending((ok, message) => ok ? host.notify.success(message) : host.notify.error(message))
}

function showStartupError(err: unknown, loadingConfig: boolean) {
  console.error(loadingConfig ? '[editor-demo] could not read the dev server configuration' : '[editor-demo] could not open the editor')
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.style.cssText = 'font: 14px system-ui, sans-serif; padding: 24px; max-width: 40rem'
  const reason = err instanceof Error ? err.message : 'The editor could not start.'
  message.textContent = loadingConfig ? `${reason} Reload once the dev server is running.` : reason
  mount.replaceChildren(message)
}

loadDemoConfig().then(async config => {
  const ready = config.authority === 'native' ? await nativeSignIn(config, callback) : config
  if (ready) render(ready, config.authority === 'native')
}, err => showStartupError(err, true)).catch(err => showStartupError(err, false))
