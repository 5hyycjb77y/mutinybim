/**
 * The editor page of the hosted app: the full Building Model editor against
 * this app's model server, under a slim bar with the way back to the model
 * list, Ask AI (the person's own key, browser to provider) and, when the
 * deployment has one, the quote link. Package imports only.
 */
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import { Badge, Button, Card, CardDescription, CardTitle, MutinyThemeProvider, Spinner, Textarea, ThemeToggle, isMutinyColorScheme, useMutinyPortalContainer, type ColorSchemeAdapter, type MutinyColorScheme, type MutinyThemeOverrides } from '@permitzip/bim-ui'
import { EditorHostProvider } from '@permitzip/bim-editor/host'
import { createLocalEditorHost, createLocalShellHost } from '@permitzip/bim-editor/host/local'
import { PortalContainerProvider } from '@permitzip/bim-editor/ui/overlay-boundary'
import { TooltipProvider } from '@permitzip/bim-editor/ui/tooltip'
import { BuildingModelSurface, type BuildingModelView } from '@permitzip/bim-editor/editor/BuildingModelSurface'
import { mutinyToShadcnVars } from '../../../packages/bim-editor/demo/theme'
import { AiError, ask, providerName, readAiSettings } from './ai'
import { answerApproval, ApprovalsError, fetchWaitingApprovals, type ApprovalAnswer, type WaitingApproval } from './approvals'

interface PageData {
  readonly modelId: string
  readonly modelName: string
  readonly userId: string
  readonly displayName: string
  readonly quoteLabel: string | null
  /** owner, edit or view (view: the model server refuses edits). */
  readonly access: 'owner' | 'edit' | 'view'
  /** Whose model it is, when it was shared with this person. */
  readonly owner: string | null
  readonly colorScheme: MutinyColorScheme
}

function readPageData(): PageData {
  const el = document.getElementById('mutinybim-page')
  if (!el?.textContent) throw new Error('[mutinybim-web] the editor page has no page data')
  const parsed: unknown = JSON.parse(el.textContent)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('[mutinybim-web] the editor page data is not an object')
  const p = parsed as Record<string, unknown>
  const text = (key: string) => {
    const value = p[key]
    if (typeof value !== 'string') throw new Error(`[mutinybim-web] the editor page data has no ${key}`)
    return value
  }
  const access = p.access === 'edit' || p.access === 'view' ? p.access : 'owner'
  return {
    modelId: text('modelId'),
    modelName: text('modelName'),
    userId: text('userId'),
    displayName: text('displayName'),
    quoteLabel: typeof p.quoteLabel === 'string' ? p.quoteLabel : null,
    access,
    owner: typeof p.owner === 'string' ? p.owner : null,
    colorScheme: isMutinyColorScheme(p.colorScheme) ? p.colorScheme : 'system',
  }
}

const data = readPageData()
const THEME: MutinyThemeOverrides = {
  brand: { logoUrl: '/assets/bim-ui/mutiny-logo.png', iconUrl: '/assets/bim-ui/mutiny-icon.svg' },
}
const params = new URLSearchParams(window.location.search)
const viewParam = params.get('view')
const initialView: BuildingModelView = viewParam === '3d' || viewParam === 'sheet' ? viewParam : 'plan'
const authorityUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/sync`
const localHost = createLocalEditorHost({
  authorityUrl,
  userId: data.userId,
  displayName: data.displayName,
  token: 'session',
  connectHint: 'Connect your own AI assistant to this model: Connect an assistant, in the bar above.',
})
const host = {
  ...localHost,
  shell: createLocalShellHost({ connectAgentHref: '/connect' }),
  capabilities: { ...localHost.capabilities, hostName: 'MutinyBIM' },
}

/** The theme choice is kept in the account, so the model list and the editor agree. */
const schemeAdapter: ColorSchemeAdapter = {
  get: () => data.colorScheme,
  set: async (scheme) => {
    const response = await fetch('/settings/scheme', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheme }) })
    if (!response.ok) throw new Error(response.status === 401 ? 'You are signed out, so the theme was not saved.' : 'The theme could not be saved. Try again.')
    document.documentElement.setAttribute('data-mutiny-scheme', scheme)
  },
}

interface Summary {
  readonly revision: number
  readonly elements: number
  readonly byKind: Readonly<Record<string, number>>
  readonly levels: readonly string[]
  readonly connections: number
}

async function fetchSummary(signal: AbortSignal): Promise<Summary> {
  const response = await fetch(`/api/hosted/models/${encodeURIComponent(data.modelId)}/summary`, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new AiError(response.status === 401 ? 'You are signed out. Log in again, then ask.' : 'The model summary could not be read from the server. Try again.')
  return (await response.json()) as Summary
}

function AskAiPanel({ onClose }: { readonly onClose: () => void }) {
  const [settings] = useState(() => readAiSettings())
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'asking' } | { kind: 'answer'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' })
  const abort = useRef<AbortController | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      abort.current?.abort()
    }
  }, [onClose])

  const submit = useCallback(async () => {
    if (!settings || !question.trim()) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState({ kind: 'asking' })
    try {
      const summary = await fetchSummary(controller.signal)
      const kinds = Object.entries(summary.byKind).map(([k, n]) => `${k}: ${n}`).join(', ')
      const system = `You help a person working in MutinyBIM, a browser building model for every AEC trade. Their model "${data.modelName}" is at revision ${summary.revision} with ${summary.elements} elements (${kinds || 'none'}), levels ${summary.levels.join(', ') || 'none'}, and ${summary.connections} connections. You can see only this summary, not the drawing. Answer plainly and briefly. To let an assistant change the model, they connect it with "Connect an assistant".`
      const text = await ask(settings, { system, question: question.trim(), signal: controller.signal })
      setState({ kind: 'answer', text })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setState({ kind: 'idle' })
        return
      }
      if (!(err instanceof AiError)) console.error('[mutinybim-web] Ask AI failed', err)
      setState({ kind: 'error', text: err instanceof AiError ? err.message : 'Asking failed for a reason this page can\'t name. Try again.' })
    }
  }, [question, settings])

  return (
    <Card role="dialog" aria-label="Ask AI" data-testid="ask-ai-panel" className="fixed top-13 right-3 z-[2147483000] max-h-[calc(100dvh-70px)] w-[min(420px,calc(100vw-24px))] gap-3 overflow-auto shadow-xl">
      <div className="flex items-center">
        <CardTitle className="text-base">Ask AI</CardTitle>
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClose} aria-label="Close Ask AI">
          Close
        </Button>
      </div>
      {!settings ? (
        <CardDescription>
          No AI key in this browser yet. This app pays for no AI: add your own Claude, ChatGPT or Grok key in <a className="underline" href="/settings#ai">Settings → Your AI</a> (it stays in this browser), or <a className="underline" href="/connect">connect your assistant app</a>.
        </CardDescription>
      ) : (
        <>
          <CardDescription>Uses your {providerName(settings)} key, from this browser straight to {providerName(settings)}. It sees a summary of this model, not the drawing.</CardDescription>
          <Textarea
            ref={input}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            rows={4}
            placeholder="What should I check before sizing these ducts?"
            aria-label="Your question"
          />
          <div className="flex items-center gap-2">
            <Button type="button" disabled={state.kind === 'asking' || !question.trim()} onClick={() => void submit()}>
              {state.kind === 'asking' ? <Spinner /> : null}
              {state.kind === 'asking' ? 'Asking…' : 'Ask'}
            </Button>
            {state.kind === 'asking' ? (
              <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
                Stop
              </Button>
            ) : null}
            {!question.trim() && state.kind !== 'asking' ? <span className="text-sm text-(--mutiny-muted)">Type a question first.</span> : null}
          </div>
          <div role="status" aria-live="polite" className="text-sm">
            {state.kind === 'asking' ? <p className="text-(--mutiny-muted)">Waiting for {providerName(settings)}…</p> : null}
            {state.kind === 'error' ? <p className="text-(--mutiny-danger)">{state.text}</p> : null}
            {state.kind === 'answer' ? <div className="rounded-(--mutiny-radius) bg-(--mutiny-subtle) p-2.5 whitespace-pre-wrap">{state.text}</div> : null}
          </div>
        </>
      )}
    </Card>
  )
}

function HostedBar() {
  const [askOpen, setAskOpen] = useState(false)
  const close = useCallback(() => setAskOpen(false), [])
  return (
    <div className="flex flex-none flex-wrap items-center gap-2 border-b border-(--mutiny-border) bg-(--mutiny-surface) px-3 py-1.5 text-sm text-(--mutiny-text)" data-testid="hosted-bar">
      <Button asChild variant="ghost" size="sm">
        <a href="/models" title="Back to my models">
          ← My models
        </a>
      </Button>
      <img src="/assets/bim-ui/mutiny-icon.svg" alt="" width={20} height={20} />
      <strong className="max-w-[40ch] truncate">{data.modelName}</strong>
      {data.owner ? <span className="text-(--mutiny-muted)">{data.owner}'s</span> : null}
      {data.access === 'view' ? (
        <Badge variant="secondary" title="The owner shared this model to view. Edits are refused.">View only</Badge>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        <ThemeToggle />
        <Button type="button" variant={askOpen ? 'outline' : 'default'} size="sm" onClick={() => setAskOpen((v) => !v)} aria-expanded={askOpen}>
          Ask AI
        </Button>
        <Button asChild variant="ghost" size="sm">
          <a href="/connect">Connect an assistant</a>
        </Button>
        {data.quoteLabel ? (
          <Button asChild variant="outline" size="sm">
            <a href={`/quote?model=${encodeURIComponent(data.modelId)}`}>{data.quoteLabel}</a>
          </Button>
        ) : null}
      </span>
      {askOpen ? createPortal(<AskAiPanel onClose={close} />, document.body) : null}
    </div>
  )
}

const APPROVALS_EVERY_MS = 5000
const APPROVALS_SHOWN = 2

/** Changes an outside assistant is waiting for this person to approve, shown above the model without a reload. */
function ApprovalNotices() {
  const [waiting, setWaiting] = useState<readonly WaitingApproval[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ readonly ok: boolean; readonly words: string } | null>(null)

  /** False once checking should stop (signed out). */
  const check = useCallback(async (): Promise<boolean> => {
    if (document.visibilityState !== 'visible') return true
    try {
      setWaiting(await fetchWaitingApprovals())
      setProblem(null)
      return true
    } catch (err) {
      console.error('[mutinybim-web] checking for approval requests failed', err)
      setProblem(err instanceof ApprovalsError ? err.message : 'Checking for approval requests failed. Open Approvals to see what is waiting.')
      return !(err instanceof ApprovalsError && err.signedOut)
    }
  }, [])

  useEffect(() => {
    let timer = 0
    let stopped = false
    const tick = async () => {
      if (stopped || (await check())) return
      stopped = true
      window.clearInterval(timer)
    }
    void tick()
    timer = window.setInterval(() => void tick(), APPROVALS_EVERY_MS)
    const onVisible = () => void tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [check])

  useEffect(() => {
    document.title = `${waiting.length > 0 ? `(${waiting.length}) ` : ''}${data.modelName} · MutinyBIM`
  }, [waiting.length])

  const answer = useCallback(
    async (item: WaitingApproval, decision: ApprovalAnswer) => {
      setBusy(item.id)
      setResult(null)
      try {
        setResult(await answerApproval(item.id, decision))
      } catch (err) {
        console.error('[mutinybim-web] answering an approval request failed', err)
        setResult({ ok: false, words: err instanceof ApprovalsError ? err.message : "Your answer wasn't sent. Check your connection, then answer it on Approvals." })
      } finally {
        setBusy(null)
        void check()
      }
    },
    [check],
  )

  if (waiting.length === 0 && !problem && !result) return null
  return (
    <div role="region" aria-label="Waiting for your approval" data-testid="approval-notices" className="flex flex-none flex-col gap-1.5 border-b border-(--mutiny-border) bg-(--mutiny-accent-subtle) px-3 py-2 text-sm text-(--mutiny-text)">
      {waiting.slice(0, APPROVALS_SHOWN).map((item) => (
        <div key={item.id} role="status" className="flex flex-wrap items-center gap-2" data-testid="approval-notice">
          <span className="min-w-0 flex-1 basis-64 break-words">
            <strong>{item.assistant}</strong> is waiting for your approval{item.modelId === data.modelId ? ' to change this model' : ''}: {item.title}
          </span>
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void answer(item, 'approve')}>
            {busy === item.id ? <Spinner /> : null}
            Approve
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void answer(item, 'decline')}>
            Decline
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a href={item.href} target="_blank" rel="noopener noreferrer">
              See exactly what changes
            </a>
          </Button>
        </div>
      ))}
      {waiting.length > APPROVALS_SHOWN ? (
        <a className="underline" href="/approvals" target="_blank" rel="noopener noreferrer">
          And {waiting.length - APPROVALS_SHOWN} more waiting on Approvals
        </a>
      ) : null}
      {result ? (
        <p role="status" className={`flex flex-wrap items-center gap-2 ${result.ok ? '' : 'text-(--mutiny-danger)'}`}>
          {result.words}
          <Button type="button" variant="ghost" size="sm" onClick={() => setResult(null)}>
            Dismiss
          </Button>
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-(--mutiny-danger)">
          {problem}{' '}
          <a className="underline" href="/approvals" target="_blank" rel="noopener noreferrer">
            Open Approvals
          </a>
        </p>
      ) : null}
    </div>
  )
}

/** Menus, selects and dialogs mount inside the Mutiny root so they wear its palette. */
function Overlays({ children }: { children: ReactNode }) {
  const root = useMutinyPortalContainer()
  return <PortalContainerProvider container={root}>{children}</PortalContainerProvider>
}

const mount = document.getElementById('app')
if (!mount) throw new Error('[mutinybim-web] the page has no #app element')

createRoot(mount).render(
  <StrictMode>
    <MutinyThemeProvider presentation="standalone" theme={THEME} hostVars={mutinyToShadcnVars} colorSchemeAdapter={schemeAdapter} initialColorScheme={data.colorScheme} applyToDocument className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-(--mutiny-surface)" data-testid="mutiny-root">
      <TooltipProvider>
        <Overlays>
          <HostedBar />
          <ApprovalNotices />
          <EditorHostProvider host={host}>
            <BuildingModelSurface projectId={data.modelId} projectName={data.modelName} projectNumber="" userId={data.userId} userName={data.displayName} initialView={initialView} />
          </EditorHostProvider>
        </Overlays>
      </TooltipProvider>
      <Toaster />
    </MutinyThemeProvider>
  </StrictMode>,
)
