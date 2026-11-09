import type { Command } from "@permitzip/bim-kernel";
import type { PipeSystemSizing } from "./system-sizing";

/**
 * The set_pipe_sizes edit for a water, sanitary, vent or storm system's
 * sizing (plumbing.size_system), or why there is nothing to apply: the
 * pipes it would change, and the table or curve it sized from. Moved here
 * from the host's tool file in round 10; bim_size_pipes runs the calc and
 * sends this edit.
 */
export function pipeSizeCommandFrom(sizing: PipeSystemSizing, allowSmaller: boolean, key: string): { readonly ok: true; readonly command: Command } | { readonly ok: false; readonly message: string } {
  const blocking = sizing.findings.find((f) => f.code === "no_demand_curve" || f.code === "no_rainfall_rate");
  if (blocking) return { ok: false, message: blocking.message };
  const changes = sizing.proposals.filter((p) => p.change === "up" || (allowSmaller && p.change === "down"));
  if (changes.length === 0) {
    const down = sizing.proposals.filter((p) => p.change === "down").length;
    return { ok: false, message: `Nothing to resize on ${sizing.systemName}: every pipe carries its load${sizing.curve ? ` on ${sizing.curve.label}` : ""}.${down > 0 ? ` ${down} pipe${down === 1 ? " is" : "s are"} larger than needed; give allow_smaller to reduce ${down === 1 ? "it" : "them"}.` : ""}` };
  }
  const basis = sizing.service === "water" ? (sizing.curve?.label ?? "the demand curve") : sizing.service === "vent" ? "Table 906.1 and 906.2" : sizing.service === "storm" ? "Tables 1106.2(1) and 1106.3" : "the DFU tables";
  return {
    ok: true,
    command: {
      type: "set_pipe_sizes",
      idPrefix: `size-${key.replace(/^agent-/, "").slice(0, 16)}`,
      systemId: sizing.systemId,
      label: `Sized ${changes.length} pipe${changes.length === 1 ? "" : "s"} on ${sizing.systemName} from ${basis}`.slice(0, 160),
      sizes: changes.map((p) => ({ segmentId: p.segmentId, nominalIn: p.proposedIn })),
    },
  };
}
