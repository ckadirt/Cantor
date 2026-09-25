/**
 * A value that changes over time, outside React.
 *
 * State that many screens read — the library, the runtime's connections, the
 * field's discrete UI — lives in one of these rather than in a component, so a
 * change re-renders only the components that selected the part that changed
 * (see `useStore`). An update that returns the same object is not a change:
 * nobody is told, which is what lets a writer answer "nothing new" by
 * returning `current`.
 */
export type Store<T> = Readonly<{
  get: () => T;
  set: (update: (current: T) => T) => void;
  subscribe: (listener: () => void) => () => void;
}>;

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: update => {
      const next = update(state);
      if (Object.is(next, state)) return;
      state = next;
      // A copy: a listener may unsubscribe itself, or another, while notified.
      for (const listener of [...listeners]) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Replace one entry of a record, keeping the record when nothing changed.
 *
 * The identity rule every store here follows: an unchanged entry keeps its
 * object and an unchanged record keeps its object, so selectors and memos
 * downstream see "the same" and do no work.
 */
export function withEntry<V>(
  record: Readonly<Record<string, V>>,
  key: string,
  value: V,
  isEqual: (left: V, right: V) => boolean = Object.is,
): Readonly<Record<string, V>> {
  const current = record[key];
  if (current !== undefined && isEqual(current, value)) return record;
  return { ...record, [key]: value };
}
