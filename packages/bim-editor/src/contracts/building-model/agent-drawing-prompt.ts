/**
 * The words "Make sheets, views and schedules with the agent" puts in Cmd+J
 * (product decision, Nov 6 review: "write a script to basically one shot the creation of
 * the sheets", asked six times). It points the agent at the sealed scripting
 * kit that already builds a drawing set (the "Sheets per level" recipe) and
 * says, in the person's words, that nothing changes until they approve. The
 * person reads and edits it before pressing Send.
 */

export interface AgentDrawingPromptInput {
  readonly projectNumber: string | null
  readonly projectName: string
  /** The model's levels, lowest first. */
  readonly levels: readonly string[]
  readonly sheetCount: number
  readonly scheduleCount: number
}

/** The tools the prompt names: the scripting kit's reference, its preview run, and the one step that saves. */
export const AGENT_DRAWING_SCRIPT_TOOLS = ['bim_script_reference', 'bim_run_script', 'bim_apply_output'] as const

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function agentDrawingPrompt(input: AgentDrawingPromptInput): string {
  const project = [input.projectNumber, input.projectName].filter((s) => s && s.trim()).join(' ')
  const levels = input.levels.length > 0 ? `the levels (${listOf(input.levels)})` : 'every level (there are none yet: say so and stop)'
  const existing =
    input.sheetCount > 0 || input.scheduleCount > 0
      ? ` It already has ${input.sheetCount} sheet${input.sheetCount === 1 ? '' : 's'} and ${input.scheduleCount} schedule${input.scheduleCount === 1 ? '' : 's'}: keep them, and don't make a second sheet with a number already in use.`
      : ''
  return [
    `Make the drawing set for the Building Model of ${project || 'this project'} with one script.${existing}`,
    '',
    `- One sheet per level for ${levels}, each with its floor plan placed on it, numbered in order.`,
    '- A ceiling plan for each level, placed on its own sheet after the floor plans.',
    '- A schedule sheet with the schedules this model needs, then every new sheet in one sheet set, in order.',
    '',
    `Use the scripting tools: find the "Sheets per level" recipe with ${AGENT_DRAWING_SCRIPT_TOOLS[0]}, preview the script with ${AGENT_DRAWING_SCRIPT_TOOLS[1]} and show me the sheets, views and schedules it would add. Save it with ${AGENT_DRAWING_SCRIPT_TOOLS[2]} only after I approve. Don't print or issue the set.`,
  ].join('\n')
}
