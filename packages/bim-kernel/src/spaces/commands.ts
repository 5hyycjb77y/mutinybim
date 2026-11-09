import type { ExecuteResult } from "../command-core";
import type { ModelState } from "../types";
import { executeSpaceDesignCommand, isSpaceDesignCommand, spaceCommandSchemas, type SpaceDesignCommand } from "./space-commands";

/** Space, zone and drawing-underlay commands (space-commands.ts): create, trace, edit, make from rooms, zones, calibrate. Wired into commands.ts. */
export { spaceCommandSchemas };

export type SpaceCommand = SpaceDesignCommand;

export function isSpaceCommand(command: { readonly type: string }): command is SpaceCommand {
  return isSpaceDesignCommand(command);
}

export function executeSpaceCommand(model: ModelState, command: SpaceCommand): ExecuteResult {
  return executeSpaceDesignCommand(model, command);
}
