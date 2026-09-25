import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Store } from './store';

/**
 * Read part of a store, re-rendering only when that part changes.
 *
 * `selector` may be written inline: a new selector is re-run against the
 * current state, and its answer is kept whenever `isEqual` says it matches the
 * last one, so an inline selector costs a call and not a render.
 */
export function useStore<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  isEqual: (left: S, right: S) => boolean = Object.is,
): S {
  const memo = useRef<{
    state: T;
    selector: (state: T) => S;
    selection: S;
  } | null>(null);
  const read = () => {
    const state = store.get();
    const previous = memo.current;
    if (previous?.state === state && previous.selector === selector) {
      return previous.selection;
    }
    const next = selector(state);
    const selection =
      previous !== null && isEqual(previous.selection, next)
        ? previous.selection
        : next;
    memo.current = { state, selector, selection };
    return selection;
  };
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Every value in `left` and `right` is the same object, key for key. */
export function shallowEqual<V extends object>(left: V, right: V): boolean {
  if (Object.is(left, right)) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(key =>
    Object.is(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    ),
  );
}
