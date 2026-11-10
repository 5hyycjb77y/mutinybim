import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EditorBlocksPort, EditorDataAnswer, EditorHost } from '@permitzip/bim-editor-host'
import { EditorHostProvider, useEditorHost } from '../src/host'
import { createLocalEditorHost } from '../src/host/local'
import { jsonAnswer } from '../src/host/local-data'
import type { SheetBlockReport } from '../src/contracts/bim/block-reports'
import { SheetBlockFreshnessChip } from '../src/editor/blocks/SheetBlockFreshnessChip'
import { useBlockFreshnessFrom } from '../src/editor/blocks/use-block-freshness'

function Freshness({ blockId }: { readonly blockId?: string }) {
  const host = useEditorHost()
  const freshness = useBlockFreshnessFrom(host.data.blocks, 'project-1', 'model-1', ['sheet-1'], 1)
  return <SheetBlockFreshnessChip freshness={freshness} blockId={blockId} />
}

function check(port?: EditorBlocksPort, blockId?: string) {
  const local = createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' })
  const host: EditorHost = port ? { ...local, data: { ...local.data, blocks: port } } : local
  return render(<EditorHostProvider host={host}><Freshness blockId={blockId} /></EditorHostProvider>)
}

function report(state: SheetBlockReport['freshness']['state']): SheetBlockReport {
  return {
    sheetId: 'sheet-1', blockId: 'block-1', title: 'Load summary',
    freshness: state === 'live' ? { state } : { state, issueLabel: 'SD' },
    label: state === 'live' ? 'Live' : state === 'frozen_current' ? 'Matches SD issue' : 'Changed since SD issue',
    text: 'Current loads', unresolved: [], issuedText: state === 'live' ? null : 'Issued loads',
    issuedAt: state === 'live' ? null : '2026-01-01T00:00:00Z',
    issuedAtRevision: state === 'live' ? null : 0,
  }
}

describe('sheet block issue checking', () => {
  it.each([undefined, 'block-1'])('shows nothing without a blocks service (block: %s)', (blockId) => {
    const { container } = check(undefined, blockId)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('block-freshness')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('still shows loading while a supported service is answering', () => {
    const freshness = jest.fn(() => new Promise<EditorDataAnswer>(() => {}))
    check({ freshness })
    expect(screen.getByTestId('block-freshness')).toHaveTextContent('Checking the last issue…')
    expect(freshness).toHaveBeenCalledWith(
      { projectId: 'project-1', modelId: 'model-1', sheets: 'sheet-1' },
      { signal: expect.any(AbortSignal) },
    )
  })

  it.each(['live', 'frozen_current', 'changed_since'] as const)('keeps the supported %s status', async (state) => {
    const block = report(state)
    check({ freshness: jest.fn(async () => jsonAnswer({ revision: 1, blocks: [block] })) })
    await waitFor(() => expect(screen.getByTestId('block-freshness')).toHaveAttribute('data-state', state))
    expect(screen.getByTestId('block-freshness')).toHaveTextContent(block.label)
  })

  it.each(['offline', 'server error'])('keeps genuine %s failures visible and retries them', async (failure) => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const freshness = jest.fn<ReturnType<EditorBlocksPort['freshness']>, Parameters<EditorBlocksPort['freshness']>>()
    if (failure === 'offline') freshness.mockRejectedValueOnce(new Error('Connection lost'))
    else freshness.mockResolvedValueOnce(jsonAnswer({ error: 'Issue storage is unavailable' }, 503))
    freshness.mockResolvedValueOnce(jsonAnswer({ revision: 1, blocks: [report('live')] }))
    check({ freshness })
    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent("Couldn't check the last issue")
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry).toHaveAttribute('title', failure === 'offline' ? 'Connection lost' : 'Issue storage is unavailable')
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByTestId('block-freshness')).toHaveAttribute('data-state', 'live'))
    expect(freshness).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
