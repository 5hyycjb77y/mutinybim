/**
 * Appends `value` to the list under `key`, creating it. Building a grouped
 * map by copying the list on every add (`map.set(k, [...(map.get(k) ?? []), v])`)
 * is quadratic in the group's size: a level of 35,892 members took 28 s.
 */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
