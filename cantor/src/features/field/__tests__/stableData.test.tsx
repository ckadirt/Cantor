import React from 'react';
import * as Renderer from 'react-test-renderer';
import { samePlainData, useStableData, useStableList } from '../stableData';

describe('samePlainData', () => {
  it('compares plain data by what it says', () => {
    expect(samePlainData({ a: [1, 'x', { b: null }] }, { a: [1, 'x', { b: null }] })).toBe(true);
    expect(samePlainData({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
    expect(samePlainData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(samePlainData([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(samePlainData(NaN, NaN)).toBe(true);
  });

  it('compares anything that is not plain data by identity', () => {
    class Path {}
    const path = new Path();
    expect(samePlainData({ p: path }, { p: path })).toBe(true);
    expect(samePlainData({ p: new Path() }, { p: new Path() })).toBe(false);
  });
});

describe('useStableData', () => {
  it('keeps the value before while the new one says the same', () => {
    const seen: unknown[] = [];
    function Probe({ value }: { value: unknown }) {
      seen.push(useStableData(value));
      return null;
    }
    const first = [{ x: 1 }];
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(<Probe value={first} />);
    });
    Renderer.act(() => tree.update(<Probe value={[{ x: 1 }]} />));
    expect(seen[seen.length - 1]).toBe(first);
    const changed = [{ x: 2 }];
    Renderer.act(() => tree.update(<Probe value={changed} />));
    expect(seen[seen.length - 1]).toBe(changed);
    Renderer.act(() => tree.unmount());
  });
});

describe('useStableList', () => {
  it('keeps every element that says the same, and the list when all do', () => {
    const seen: (readonly unknown[])[] = [];
    function Probe({ list }: { list: readonly unknown[] }) {
      seen.push(useStableList(list));
      return null;
    }
    const a = { x: 1 };
    const b = { x: 2 };
    const first = [a, b];
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(<Probe list={first} />);
    });
    Renderer.act(() => tree.update(<Probe list={[{ x: 1 }, { x: 2 }]} />));
    expect(seen[seen.length - 1]).toBe(first);
    Renderer.act(() => tree.update(<Probe list={[{ x: 1 }, { x: 3 }]} />));
    const changed = seen[seen.length - 1];
    expect(changed).not.toBe(first);
    expect(changed[0]).toBe(a);
    expect(changed[1]).toEqual({ x: 3 });
    Renderer.act(() => tree.unmount());
  });
});

describe('useStableList, by key', () => {
  it('keeps the elements after one that arrived', () => {
    const seen: (readonly { k: string; v: number }[])[] = [];
    function Probe({ list }: { list: readonly { k: string; v: number }[] }) {
      seen.push(useStableList(list, item => item.k));
      return null;
    }
    const a = { k: 'a', v: 1 };
    const b = { k: 'b', v: 2 };
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(<Probe list={[a, b]} />);
    });
    Renderer.act(() =>
      tree.update(<Probe list={[{ k: 'new', v: 0 }, { k: 'a', v: 1 }, { k: 'b', v: 2 }]} />),
    );
    const next = seen[seen.length - 1];
    expect(next[1]).toBe(a);
    expect(next[2]).toBe(b);
    Renderer.act(() => tree.unmount());
  });
});
