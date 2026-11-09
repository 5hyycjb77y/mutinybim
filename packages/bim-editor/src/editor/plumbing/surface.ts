/** What the always-loaded Building Model surface takes from this add-on's screens. */
import type { Command, ModelState } from '@permitzip/bim-kernel'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useAutoSizeFrom } from './use-auto-size'

export { useRoutePipeTypes } from './route-pipe-types'

/** Auto-size after a routing command, with the codes the editor's host says the project adopted. */
export function useAutoSize(projectId: string | undefined, submit: (command: Command, undoLabel?: string) => string | null): (command: Command, model: ModelState) => void {
  return useAutoSizeFrom(useEditorHost().data.codeAdoption, projectId, submit)
}
