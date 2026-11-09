/**
 * Cycle detection for formula graphs (library calculations that call each
 * other, formula columns that read other formula columns). Tarjan's strongly
 * connected components; deterministic output so a refusal always names the
 * same items in the same order.
 */

export function findCycles(graph: ReadonlyMap<string, readonly string[]>): readonly (readonly string[])[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let next = 0;

  const ids = [...new Set([...graph.keys(), ...[...graph.values()].flat()])].sort();

  // Iterative Tarjan so a long chain of calculations can't overflow the call stack.
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; edges: readonly string[]; i: number }[] = [];
    const enter = (id: string) => {
      index.set(id, next);
      low.set(id, next);
      next++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: [...(graph.get(id) ?? [])].sort(), i: 0 });
    };
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; edges: readonly string[]; i: number };
      if (frame.i < frame.edges.length) {
        const to = frame.edges[frame.i++] as string;
        if (!index.has(to)) enter(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(to) as number));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const id = stack.pop() as string;
          onStack.delete(id);
          component.push(id);
          if (id === frame.id) break;
        }
        const selfLoop = component.length === 1 && (graph.get(frame.id) ?? []).includes(frame.id);
        if (component.length > 1 || selfLoop) cycles.push(component.sort());
      }
    }
  }
  return cycles.sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : 1));
}
