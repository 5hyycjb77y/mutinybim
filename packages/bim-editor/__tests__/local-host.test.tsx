import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { EditorHostProvider, checkEditorHostConformance, sonnerNotifier, useEditorHost } from '../src/host'
import { createLocalEditorHost, historyRouter, memoryPreferences } from '../src/host/local'

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() } }))

const AUTHORITY = 'ws://127.0.0.1:3095/sync'

describe('the standalone editor host', () => {
  it('passes the host conformance check', async () => {
    expect(await checkEditorHostConformance(createLocalEditorHost({ authorityUrl: AUTHORITY }))).toEqual([])
  })

  it('opens any model on the local model server, with no references and no storage or agent', async () => {
    const host = createLocalEditorHost({ authorityUrl: AUTHORITY })
    await expect(host.session.openConfig('demo')).resolves.toEqual({ references: [], authority: { url: AUTHORITY, modelId: 'demo' } })
    expect(host.storage).toBeUndefined()
    expect(host.agent).toBeUndefined()
    expect(host.links.hrefFor({ kind: 'price_books' })).toBeNull()
  })

  it("signs in as the local person unless told it can't", async () => {
    await expect(createLocalEditorHost({ authorityUrl: AUTHORITY }).session.getAccessToken()).resolves.toBe('local')
    await expect(createLocalEditorHost({ authorityUrl: AUTHORITY, token: null }).session.getAccessToken()).resolves.toBeNull()
  })

  it('moves through the browser history and re-renders the location', () => {
    window.history.replaceState(null, '', '/m/demo')
    const { result } = renderHook(() => historyRouter.useLocation())
    expect(result.current).toEqual({ pathname: '/m/demo', search: '' })
    act(() => historyRouter.push('/m/demo?branch=b1'))
    expect(result.current).toEqual({ pathname: '/m/demo', search: 'branch=b1' })
    act(() => historyRouter.replace('/m/demo?schedule=s2'))
    expect(result.current).toEqual({ pathname: '/m/demo', search: 'schedule=s2' })
    expect(window.history.length).toBeGreaterThan(0)
  })

  it('keeps preferences for the tab, loaded at once, shared by every reader of the namespace', async () => {
    const preferences = memoryPreferences()
    const defaults = { hintShown: false }
    const first = renderHook(() => preferences.usePreferences('input', defaults))
    const second = renderHook(() => preferences.usePreferences('input', defaults))
    expect(first.result.current.values).toEqual({ hintShown: false })
    expect(first.result.current.loaded).toBe(true)
    await act(() => first.result.current.set('hintShown', true))
    expect(second.result.current.values).toEqual({ hintShown: true })
    const other = renderHook(() => preferences.usePreferences('layout', defaults))
    expect(other.result.current.values).toEqual({ hintShown: false })
  })

  it('shows messages through sonner with the same options', () => {
    const action = { label: 'Open here', onClick: () => {} }
    sonnerNotifier.info('Your browser blocked the new tab.', { action })
    sonnerNotifier.error("Couldn't save.", { description: 'Try again.', id: 'save' })
    expect(toast.info).toHaveBeenCalledWith('Your browser blocked the new tab.', { action, description: undefined, id: undefined })
    expect(toast.error).toHaveBeenCalledWith("Couldn't save.", { description: 'Try again.', id: 'save', action: undefined })
    sonnerNotifier.success('Saved')
    expect(toast.success).toHaveBeenCalledWith('Saved', undefined)
  })
})

describe('EditorHostProvider', () => {
  it('gives the editor its host', () => {
    const host = createLocalEditorHost({ authorityUrl: AUTHORITY })
    const wrapper = ({ children }: { children: ReactNode }) => <EditorHostProvider host={host}>{children}</EditorHostProvider>
    expect(renderHook(() => useEditorHost(), { wrapper }).result.current).toBe(host)
  })

  it('fails loudly when the editor is mounted without one', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useEditorHost())).toThrow('without an EditorHostProvider')
    quiet.mockRestore()
  })
})
