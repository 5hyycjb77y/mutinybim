import { definitionTypes, type Command, type PartTypeDefinition, type Vec2 } from '@permitzip/bim-kernel'

/**
 * Model in place: the part editor opened for a new part at a spot clicked in
 * the project. The first save adds its types to the project and places one
 * at that spot, as one edit (one revision, one undo). Later saves in the same
 * window only update the type; Save to library in the editor makes it a
 * reusable part.
 */
export interface InPlaceSpot {
  readonly levelId: string
  /** The level's name, for the words ("Level 1"). */
  readonly levelName: string
  /** Plan point on that level, model mm. */
  readonly at: Vec2
}

/** Where the part goes, in words for the editor and the hint bar. */
export function inPlaceWords(spot: InPlaceSpot): string {
  return `the spot you clicked on ${spot.levelName}`
}

/** The edit that saves the part and places it at the spot; a refusal in words when it can't be built. */
export function modelInPlaceCommand(definition: PartTypeDefinition, spot: InPlaceSpot, partId: string): Command | string {
  let types: ReturnType<typeof definitionTypes>
  try {
    types = definitionTypes(definition)
  } catch (err) {
    console.error('[model-in-place] the sizes table cannot be saved', err)
    return err instanceof Error ? err.message : 'The sizes table can’t be saved'
  }
  const first = types[0]
  if (!first) return 'The part has no type to place. Give it a type name and save again.'
  const name = definition.familyName.trim() || first.definition.typeName
  return {
    type: 'batch_edits',
    label: `Model ${name} in place`,
    commands: [
      { type: 'save_part_types', label: `Save ${name}`, types },
      { type: 'place_part', partId, typeId: first.typeId, levelId: spot.levelId, position: { x: spot.at.x, y: spot.at.y } },
    ],
  }
}
