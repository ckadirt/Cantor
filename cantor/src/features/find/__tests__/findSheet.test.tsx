import React from 'react';
import * as Renderer from 'react-test-renderer';
import type { TagFilter } from '../../../field';
import { FindSheet } from '../FindSheet';

const TAGS = [
  { tag: 'live', count: 4 },
  { tag: 'Rainy', count: 8 },
];

function sheet(filter: TagFilter, onChangeFilter = jest.fn()) {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <FindSheet
        filter={filter}
        libraryCount={64}
        onChangeFilter={onChangeFilter}
        onClose={() => {}}
        open
        scopeLabel={null}
        shownCount={10}
        tags={TAGS}
      />,
    );
  });
  return { tree, onChangeFilter };
}

const words = (tree: Renderer.ReactTestRenderer) => [
  ...new Set(
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string),
  ),
];

const pressable = (tree: Renderer.ReactTestRenderer, label: string) =>
  tree.root.find(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );

describe('the find blind', () => {
  it('lists the tags with nothing typed, and no mode for one tag', () => {
    const { tree } = sheet({ tags: [], mode: 'any' });
    expect(words(tree)).toEqual(
      expect.arrayContaining(['FIND', '64 SONGS', 'OR ONLY SHOW', 'live']),
    );
    expect(words(tree)).not.toContain('ANY');
    expect(words(tree)).not.toContain('CLEAR');
  });

  it('chooses a tag, and says what the map would show', () => {
    const { tree, onChangeFilter } = sheet({ tags: ['live'], mode: 'any' });
    expect(words(tree)).toContain('10 OF 64 SONGS WOULD SHOW');
    Renderer.act(() => pressable(tree, 'Rainy, 8 songs').props.onPress());
    expect(onChangeFilter).toHaveBeenLastCalledWith({
      tags: ['live', 'Rainy'],
      mode: 'any',
    });
    // Pressing a chosen tag lets it go, and one tag has no mode.
    Renderer.act(() => pressable(tree, 'live, 4 songs').props.onPress());
    expect(onChangeFilter).toHaveBeenLastCalledWith({ tags: [], mode: 'any' });
  });

  it('offers any or all from two tags, and clears', () => {
    const filter: TagFilter = { tags: ['live', 'rainy'], mode: 'any' };
    const { tree, onChangeFilter } = sheet(filter);
    Renderer.act(() =>
      pressable(tree, 'Songs with all of these tags').props.onPress(),
    );
    expect(onChangeFilter).toHaveBeenLastCalledWith({ ...filter, mode: 'all' });
    Renderer.act(() =>
      pressable(tree, 'Clear the filter, live or rainy').props.onPress(),
    );
    expect(onChangeFilter).toHaveBeenLastCalledWith({ tags: [], mode: 'any' });
  });

  it('gives the page to results once something is typed', () => {
    const { tree } = sheet({ tags: [], mode: 'any' });
    const input = tree.root.find(
      node => node.props.accessibilityLabel === 'Find a song' &&
        typeof node.props.onChangeText === 'function',
    );
    Renderer.act(() => input.props.onChangeText('lo'));
    expect(words(tree)).not.toContain('OR ONLY SHOW');
  });

  it('names the shelf it was opened in', () => {
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <FindSheet
          filter={{ tags: [], mode: 'any' }}
          libraryCount={64}
          onChangeFilter={() => {}}
          onClose={() => {}}
          open
          scopeLabel="Sep 21 – 27"
          shownCount={64}
          tags={TAGS}
        />,
      );
    });
    expect(words(tree)).toContain('FIND IN SEP 21 – 27');
  });
});
