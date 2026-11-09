import { createLocalEditorHost, createLocalShellHost } from '../src/host/local'
import { CONNECT_AGENT_DOC_HREF } from '../src/host/local-shell'

jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() } }))

describe("the standalone app's frame around the editor", () => {
  it('lists no issued sheets, so the editor shows its plain line instead', () => {
    expect(createLocalShellHost().IssuedSheetLinks).toBeUndefined()
  })

  it("points Connect your own AI at the open repository's guide", () => {
    expect(CONNECT_AGENT_DOC_HREF).toMatch(/^https:\/\/.+\/docs\/CONNECT-AN-AGENT\.md$/)
    expect(createLocalShellHost().connectAgentHref).toBe(CONNECT_AGENT_DOC_HREF)
  })

  it('lets the app point it elsewhere, or hide it', () => {
    expect(createLocalShellHost({ connectAgentHref: '/guide' }).connectAgentHref).toBe('/guide')
    expect(createLocalShellHost({ connectAgentHref: null }).connectAgentHref).toBeNull()
  })

  it('is the frame the standalone host gives the editor', () => {
    expect(createLocalEditorHost({ authorityUrl: 'ws://127.0.0.1:3095/sync' }).shell).toEqual(createLocalShellHost())
  })
})
