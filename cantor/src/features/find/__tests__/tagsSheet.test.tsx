import React from 'react';
import * as Renderer from 'react-test-renderer';
import type { TagFilter } from '../../../field';
import { TagsSheet } from '../TagsSheet';

const TAGS = [
  { tag: 'live', count: 4 },
  { tag: 'Rainy', count: 8 },
];

function sheet(
  filter: TagFilter,
  onChangeFilter = jest.fn(),
  tags: typeof TAGS = TAGS,
) {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <TagsSheet
        filter={filter}
        libraryCount={64}
        onChangeFilter={onChangeFilter}
        onClose={() => {}}
        shownCount={10}
        tags={tags}
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

describe('the tags page', () => {
  it('is an index: a running head, each tag with its count', () => {
    const { tree } = sheet({ tags: [], mode: 'any' });
    expect(words(tree)).toEqual(
      expect.arrayContaining([
        'ONLY SHOW',
        'Every song',
        '64 SONGS · 2 TAGS',
        'TAGS',
        'live',
        '4',
        'Rainy',
        '8',
      ]),
    );
    expect(words(tree)).not.toContain('ANY OF THEM');
    expect(words(tree)).not.toContain('Show every song');
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

  it('offers any or all from two tags, and shows every song again', () => {
    const filter: TagFilter = { tags: ['live', 'rainy'], mode: 'any' };
    const { tree, onChangeFilter } = sheet(filter);
    expect(words(tree)).toContain('Songs with');
    Renderer.act(() =>
      pressable(tree, 'Songs with all of these tags').props.onPress(),
    );
    expect(onChangeFilter).toHaveBeenLastCalledWith({ ...filter, mode: 'all' });
    Renderer.act(() =>
      pressable(
        tree,
        'Show every song, not only live or rainy',
      ).props.onPress(),
    );
    expect(onChangeFilter).toHaveBeenLastCalledWith({ tags: [], mode: 'any' });
  });

  it('says how to make a tag when there is none', () => {
    const { tree } = sheet({ tags: [], mode: 'any' }, jest.fn(), []);
    expect(words(tree)).toContain(
      'No song has a tag yet. Hold a song to give it one.',
    );
  });
});
