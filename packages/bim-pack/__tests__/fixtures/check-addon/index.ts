/**
 * A TEST add-on with one check (round 8b lane K): it contributes a pipe run
 * check on `PIPE_RUN_CHECK_POINT` that flags any pipe smaller than its own
 * test minimum. Switched per model with `set_model_addon`, it proves that an
 * add-on's check is re-run on the next edit after it is switched on or off,
 * with zero kernel edits. Synthetic rule and words; no code text.
 *
 * It imports only the kernel's public entry points.
 */
import { PIPE_RUN_CHECK_POINT, type PipeRunCheckDef, type RunIssue, type RunSegment } from "@permitzip/bim-kernel";
import { contribute, definePack } from "@permitzip/bim-kernel/packs";

export const CHECK_ADDON_ID = "k8check";
export const CHECK_ADDON_VERSION = "1.0.0";
/** The test minimum: 1 in. nominal. */
export const CHECK_MIN_NOMINAL_MM = 25.4;
export const CHECK_MESSAGE_START = "Test check:";

function nominalMm(seg: RunSegment): number | null {
  return seg.size.shape === "pipe" ? seg.size.nominalMm : null;
}

export const CHECK_ADDON_RUN_CHECK: PipeRunCheckDef = {
  id: "k8check.minimum_size",
  segment: (_elements, seg): readonly RunIssue[] => {
    const size = nominalMm(seg);
    if (size === null || size >= CHECK_MIN_NOMINAL_MM) return [];
    return [{ code: "invalid_value", message: `${CHECK_MESSAGE_START} pipe ${seg.id} is smaller than the test minimum of 1 in.`, elementIds: [seg.id] }];
  },
};

export const CHECK_TEST_PACK = definePack({ id: CHECK_ADDON_ID, name: "Test pipe check", version: CHECK_ADDON_VERSION, kernel: "^1.5.0" }, [contribute(PIPE_RUN_CHECK_POINT, [CHECK_ADDON_RUN_CHECK])]);
