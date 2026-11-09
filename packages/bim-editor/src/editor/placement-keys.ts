type KeyLike = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey'>

const plain = (e: KeyLike) => !e.metaKey && !e.ctrlKey && !e.altKey

/** R or Space (Revit's) turns what is being placed by 90°; a held Space doesn't spin it. */
export function isTurnKey(e: KeyLike): boolean {
  return plain(e) && (e.key === 'r' || e.key === 'R' || (e.key === ' ' && !e.repeat))
}

/** L locks or unlocks the work plane while placing or routing. */
export function isPlaneLockKey(e: KeyLike): boolean {
  return plain(e) && !e.repeat && (e.key === 'l' || e.key === 'L')
}
