import { LEVELS_STARTER_FEATURE, needsStarterLevel, type Command, type ModelState } from '@permitzip/bim-kernel'

/**
 * The starter Level 1 for an empty model: the command to send on opening it,
 * or null. Asked once per opened model, only by someone who can edit, and only
 * when the model server stores starter levels. The kernel gives the level a
 * fixed id and refuses when any level exists, so two people opening the same
 * empty model, or a reconnect, still make one level.
 */
export function starterLevelCommand(model: ModelState | null, serverFeatures: readonly string[], canEdit: boolean): Extract<Command, { type: 'ensure_starter_level' }> | null {
  if (!model || !canEdit || !serverFeatures.includes(LEVELS_STARTER_FEATURE)) return null
  return needsStarterLevel(model) ? { type: 'ensure_starter_level' } : null
}

/** A starter refused because the level is already there (someone else's open made it first): nothing to tell anyone. */
export function isStarterLevelRace(command: { readonly type: string }, code: string): boolean {
  return command.type === 'ensure_starter_level' && code === 'already_exists'
}
