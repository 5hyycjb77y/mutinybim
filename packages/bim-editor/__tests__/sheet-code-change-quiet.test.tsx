import { render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_SETTINGS, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { EditorHostProvider } from '../src/host'
import { createLocalEditorHost } from '../src/host/local'
import { SheetCodeChangeBanner } from '../src/editor/code-change/SheetCodeChangeBanner'

const MODEL: ModelState = { modelId: 'demo', revision: 0 as ModelState['revision'], elements: {}, connections: [], settings: DEFAULT_SETTINGS }
const SHEET = { id: 'sheet-1' as ElementId, number: 'M-101' }

function banner(host: ReturnType<typeof createLocalEditorHost>) {
  return render(
    <EditorHostProvider host={host}>
      <SheetCodeChangeBanner projectId="p" modelId="demo" model={MODEL} sheet={SHEET} viewerId="sam" onRecheck={() => {}} />
    </EditorHostProvider>,
  )
}

describe('a sheet where the host keeps no sign-off log', () => {
  it('shows nothing: no error, no spinner, nothing asked', () => {
    const host = createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' })
    expect(host.data.codeChange).toBeUndefined()
    const { container } = banner(host)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('code-change-banner-error')).toBeNull()
  })

  it('still checks the approvals where the host has the log', async () => {
    const local = createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' })
    const signoffs = jest.fn(async () => new Response(JSON.stringify({ modelId: 'demo', records: [], dispositions: [], departed: [] }), { status: 200 }))
    const host = { ...local, data: { ...local.data, codeChange: { notices: jest.fn(), markRead: jest.fn(), signoffs, record: jest.fn(), override: jest.fn() } } } as unknown as ReturnType<typeof createLocalEditorHost>
    banner(host)
    await waitFor(() => expect(signoffs).toHaveBeenCalledWith({ projectId: 'p', modelId: 'demo' }, expect.anything()))
  })
})
