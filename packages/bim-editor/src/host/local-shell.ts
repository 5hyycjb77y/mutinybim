import type { EditorShellHost } from '@permitzip/bim-editor-host'

/** The open-source MutinyBIM repository. */
export const MUTINYBIM_REPOSITORY_URL = 'https://github.com/permitzip/mutinybim'

/** The guide to connecting your own AI to a model, in the open repository. */
export const CONNECT_AGENT_DOC_HREF = `${MUTINYBIM_REPOSITORY_URL}/blob/main/docs/CONNECT-AN-AGENT.md`

export interface LocalShellHostOptions {
  /** Where "Connect your own AI" points; defaults to the open repository's guide. Null hides the link. */
  readonly connectAgentHref?: string | null
}

/**
 * The standalone app's frame around the editor. It publishes no issued
 * sheets, so the editor shows its plain line where a host would list them.
 */
export function createLocalShellHost(options: LocalShellHostOptions = {}): EditorShellHost {
  return { connectAgentHref: options.connectAgentHref === undefined ? CONNECT_AGENT_DOC_HREF : options.connectAgentHref }
}
