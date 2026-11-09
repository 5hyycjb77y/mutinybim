/**
 * Appends `value` to the list under `key`, creating it (the kernel's own
 * helper, not on its public surface). Copying the list on every add is
 * quadratic in the group's size.
 */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
