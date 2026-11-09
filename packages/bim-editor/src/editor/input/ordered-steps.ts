/**
 * Steps that run one after another in the order they were given, each once the
 * one before it (and anything it awaited) is done. A step that fails is logged
 * and the next still runs. The Route tool's clicks wait for the surface under
 * the pointer; its Finish and Enter queue behind them, so a quick click, click,
 * Enter never finishes before the points it was given.
 */
export function orderedSteps(label: string): (step: () => void | Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (step) => {
    tail = tail.then(step).catch((err: unknown) => console.error(`[${label}] a step failed`, err))
    return tail
  }
}
