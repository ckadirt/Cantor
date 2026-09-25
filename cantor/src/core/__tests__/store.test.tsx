import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { createStore, withEntry } from '../store';
import { shallowEqual, useStore } from '../useStore';

describe('createStore', () => {
  it('notifies on change and stays quiet when an update returns the same state', () => {
    const store = createStore({ count: 0 });
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(current => current);
    expect(listener).not.toHaveBeenCalled();

    store.set(current => ({ count: current.count + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().count).toBe(1);

    unsubscribe();
    store.set(current => ({ count: current.count + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps a record whose entry did not change', () => {
    const record = { a: 1 };
    expect(withEntry(record, 'a', 1)).toBe(record);
    expect(withEntry(record, 'a', 2)).toEqual({ a: 2 });
    expect(withEntry(record, 'b', 1)).toEqual({ a: 1, b: 1 });
  });
});

describe('useStore', () => {
  it('re-renders a reader only when its selection changes', async () => {
    const store = createStore({ song: 'a', progress: 0 });
    const renders = { song: 0, both: 0 };
    function SongReader() {
      useStore(store, state => state.song);
      renders.song += 1;
      return null;
    }
    function BothReader() {
      useStore(
        store,
        state => ({ song: state.song, progress: state.progress }),
        shallowEqual,
      );
      renders.both += 1;
      return null;
    }
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <>
          <SongReader />
          <BothReader />
        </>,
      );
    });
    expect(renders).toEqual({ song: 1, both: 1 });

    await ReactTestRenderer.act(async () => {
      store.set(current => ({ ...current, progress: 0.5 }));
    });
    expect(renders).toEqual({ song: 1, both: 2 });

    // A fresh object with the same members is not a change for either.
    await ReactTestRenderer.act(async () => {
      store.set(current => ({ ...current }));
    });
    expect(renders).toEqual({ song: 1, both: 2 });

    await ReactTestRenderer.act(async () => {
      store.set(current => ({ ...current, song: 'b' }));
    });
    expect(renders).toEqual({ song: 2, both: 3 });
  });
});
