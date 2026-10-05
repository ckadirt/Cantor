import React from 'react';
import * as Renderer from 'react-test-renderer';
import { EmptyField, EmptyFilter } from '../EmptyField';
import { metaLine } from '../FieldOverlay';

describe('the empty field', () => {
  it('offers the phone first and a node second', () => {
    const onBringIn = jest.fn();
    const onPair = jest.fn();
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <EmptyField
          onBringIn={onBringIn}
          onPair={onPair}
          publicKey="9F2C41AB"
        />,
      );
    });
    // The composite `Text` and its host both hold the words: once each.
    const words = [
      ...new Set(
        tree.root
          .findAll(node => typeof node.props.children === 'string')
          .map(node => node.props.children),
      ),
    ];
    expect(words).toEqual([
      'Your music is already on this phone. Cantor can play it where it lies.',
      'Bring it in',
      'Pair a node',
    ]);
    const door = (label: string) =>
      tree.root.find(
        node =>
          typeof node.type !== 'string' &&
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === 'function',
      );
    Renderer.act(() => door('Bring it in').props.onPress());
    Renderer.act(() => door('Pair a node').props.onPress());
    expect(onBringIn).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledTimes(1);
  });

  it('says there are no songs yet, rather than counting none', () => {
    expect(metaLine('field', 0, 0, 'WEEK')).toBe('NO SONGS YET');
    expect(metaLine('field', 3, 1, 'WEEK')).toBe('3 SONGS · 1 WEEK');
  });
});

describe('the map a filter has emptied', () => {
  it('says which tags, and offers only the way back', () => {
    const onClear = jest.fn();
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <EmptyFilter
          filter={{ tags: ['rainy', 'live'], mode: 'all' }}
          onClear={onClear}
        />,
      );
    });
    const words = [
      ...new Set(
        tree.root
          .findAll(node => typeof node.props.children === 'string')
          .map(node => node.props.children),
      ),
    ];
    expect(words).toEqual(['No songs are rainy and live.', 'CLEAR']);
    const clear = tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        node.props.accessibilityLabel === 'Clear the filter' &&
        typeof node.props.onPress === 'function',
    );
    Renderer.act(() => clear.props.onPress());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('counts the map against the library, and drops the axis noun', () => {
    expect(metaLine('field', 10, 3, 'WEEK', 64)).toBe('10 OF 64');
    expect(metaLine('field', 0, 0, 'WEEK', 64)).toBe('0 OF 64');
    // Inside a shelf the line is the shelf's own.
    expect(metaLine('shelf', 4, 1, 'WEEK', 64)).toBe('4 SONGS');
  });
});
