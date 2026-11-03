import { useRef } from 'react';

/**
 * Whether two values of plain data — numbers, strings, arrays and plain
 * objects of them — say the same thing. Anything else (a path, a font) is
 * the same only if it is the same object.
 */
export function samePlainData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!samePlainData(a[index], b[index])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const protoA = Object.getPrototypeOf(a);
  if (protoA !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) {
    return false;
  }
  const keysA = Object.keys(a);
  const recordB = b as Record<string, unknown>;
  if (keysA.length !== Object.keys(recordB).length) return false;
  const recordA = a as Record<string, unknown>;
  for (const key of keysA) {
    if (!(key in recordB) || !samePlainData(recordA[key], recordB[key])) {
      return false;
    }
  }
  return true;
}

/**
 * `value`, or the one before it when it says the same thing.
 *
 * What goes to the UI thread is copied there whole unless it is an object
 * already sent: Worklets keeps what it made of each object it has sent. A
 * plan made anew every render, saying what the last one said, was copied anew
 * every time — the map's names, ~100 ms of the Xiaomi's JS thread on every
 * letter typed into find.
 */
export function useStableData<T>(value: T): T {
  const kept = useRef(value);
  if (kept.current !== value && !samePlainData(kept.current, value)) {
    kept.current = value;
  }
  return kept.current;
}

/**
 * `list`, with every element that says what an element of the list before
 * said replaced by that element: what crosses to the UI thread is then the
 * few that changed, the rest copied from what Worklets kept of them. Elements
 * are matched by `keyOf` (by place when absent), so one coming or going does
 * not make every one after it new. The list itself is the one before when
 * every element is.
 */
export function useStableList<T>(
  list: readonly T[],
  keyOf?: (item: T) => string,
): readonly T[] {
  const kept = useRef(list);
  const before = kept.current;
  if (before === list) return list;
  const byKey = new Map<string, T[]>();
  if (keyOf !== undefined) {
    for (const item of before) {
      const key = keyOf(item);
      const bucket = byKey.get(key);
      if (bucket === undefined) byKey.set(key, [item]);
      else bucket.push(item);
    }
  }
  let same = before.length === list.length;
  const next = list.map((item, index) => {
    let old: T | undefined;
    if (keyOf === undefined) {
      old = before[index];
    } else {
      const bucket = byKey.get(keyOf(item));
      const at =
        bucket === undefined
          ? -1
          : bucket.findIndex(candidate => candidate === item || samePlainData(candidate, item));
      if (bucket !== undefined && at >= 0) {
        old = bucket[at];
        bucket.splice(at, 1);
      }
    }
    if (old !== undefined && (old === item || samePlainData(old, item))) {
      if (old !== before[index]) same = false;
      return old;
    }
    same = false;
    return item;
  });
  kept.current = same ? before : next;
  return kept.current;
}
