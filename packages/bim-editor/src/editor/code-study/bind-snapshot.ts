import { bindRequirementsSnapshot, unbindRequirementsSnapshot, type RequirementsSnapshot } from '@permitzip/bim-kernel'
import { PERMITZIP_CODE_STUDY_SOURCE_ID } from './code-study-source'

/** Hand the code-study snapshot to the kernel (lane G's graph/snapshots.ts), the way add-on sets are bound. */
export function bindCodeStudySnapshot(modelId: string, snapshot: RequirementsSnapshot): void {
  bindRequirementsSnapshot(modelId, snapshot)
}

/** Take our snapshot off a model that closed or was swapped; other sources' snapshots stay bound. */
export function unbindCodeStudySnapshot(modelId: string): void {
  unbindRequirementsSnapshot(modelId, PERMITZIP_CODE_STUDY_SOURCE_ID)
}
