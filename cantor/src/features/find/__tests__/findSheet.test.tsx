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
      expect.arrayContaining(['FIND', '64 SONGS', 'ONLY SHOW', 'live']),
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

  it('offers any or all from two tags, and clears', () => {
    const filter: TagFilter = { tags: ['live', 'rainy'], mode: 'any' };
    const { tree, onChangeFilter } = sheet(filter);
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

  it('gives the page to results once something is typed', () => {
    const { tree } = sheet({ tags: [], mode: 'any' });
    const input = tree.root.find(
      node =>
        node.props.accessibilityLabel === 'Find a song' &&
        typeof node.props.onChangeText === 'function',
    );
    Renderer.act(() => input.props.onChangeText('lo'));
    expect(words(tree)).not.toContain('ONLY SHOW');
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
          scopeKey="week-39"
          scopeLabel="Sep 21 – 27"
          shownCount={64}
          tags={TAGS}
        />,
      );
    });
    expect(words(tree)).toContain('FIND IN SEP 21 – 27');
  });
});

describe('the find blind, typed into', () => {
  const { byTime, layoutField } = jest.requireActual('../../../field');
  const { buildFindIndex } = jest.requireActual('../../../library/find');
  const monday = Date.parse('2026-08-24T12:00:00Z');
  const day = 24 * 3600 * 1000;
  const titles: Record<string, string> = {
    a: 'Lovely Rain',
    b: 'Glove Box',
    c: 'Love Theme',
  };
  const entities = [
    ['a', 0],
    ['b', 1],
    ['c', 9],
  ].map(([id, days]) => ({
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs: monday + (days as number) * day,
    durationMs: 60_000,
    tags: [],
  }));
  const layout = layoutField({
    entities,
    arrangement: byTime,
    viewport: { width: 392, height: 852 },
  });
  const index = buildFindIndex(
    entities.map(entity => [
      entity.key,
      [
        titles[entity.entityId],
        entity.entityId === 'b' ? 'a quiet harbour' : null,
      ],
    ]),
  );

  function typed(query: string, scopeKey: string | null, onArrive = jest.fn()) {
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <FindSheet
          filter={{ tags: [], mode: 'any' }}
          libraryCount={3}
          onChangeFilter={() => {}}
          onClose={() => {}}
          open
          scopeKey={scopeKey}
          scopeLabel={scopeKey === null ? null : 'This week'}
          shownCount={3}
          source={{
            layout,
            index,
            describe: placement => ({
              title: titles[placement.entityKey.slice('node-a:'.length)],
              line: 'Model',
              caption:
                placement.entityKey === 'node-a:b' ? 'a quiet harbour' : null,
              clef: {
                id: placement.entityKey,
                seed: 1,
                model: 'm',
                durationMs: 60_000,
                audioState: 'remote',
              },
            }),
            groupName: label => `week ${label}`,
            noun: 'WEEK',
            lens: jest.requireActual('../../../lenses').nameLens,
            onArrive,
          }}
          tags={TAGS}
        />,
      );
    });
    const input = tree.root.find(
      node =>
        node.props.accessibilityLabel === 'Find a song' &&
        typeof node.props.onChangeText === 'function',
    );
    Renderer.act(() => input.props.onChangeText(query));
    return { tree, onArrive };
  }

  it('lists word-start matches by group, and arrives at the one tapped', () => {
    const { tree, onArrive } = typed('love', null);
    const found = tree.root.findAll(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.endsWith('. Go to the song') &&
        typeof node.props.onPress === 'function',
    );
    // Each layer of the door carries the same label and handler: one each.
    const rows = found.filter(
      (node, position) =>
        found.findIndex(other => other.props.onPress === node.props.onPress) ===
        position,
    );
    expect(rows.map(row => row.props.accessibilityLabel.split(',')[0])).toEqual(
      layout.placements
        .filter((placement: { entityKey: string }) =>
          ['node-a:a', 'node-a:c'].includes(placement.entityKey),
        )
        .map(
          (placement: { entityKey: string }) =>
            titles[placement.entityKey.slice('node-a:'.length)],
        ),
    );
    expect(words(tree)).toContain('2 SONGS');
    Renderer.act(() => rows[0].props.onPress());
    expect(onArrive).toHaveBeenCalledTimes(1);
  });

  it('inside a shelf, finds there first and offers the rest', () => {
    const week = layout.placements.find(
      (placement: { entityKey: string }) => placement.entityKey === 'node-a:a',
    ).groupKey;
    const { tree } = typed('love', week);
    expect(words(tree)).toContain('FIND IN THIS WEEK');
    expect(words(tree)).toContain('1 more in other weeks');
    Renderer.act(() =>
      pressable(tree, '1 more in other weeks').props.onPress(),
    );
    expect(words(tree)).toContain('FIND');
    expect(words(tree)).toContain('2 SONGS');
  });

  it('says the caption when that is what matched', () => {
    const { tree } = typed('harb', null);
    expect(words(tree)).toContain('“a quiet harbour”');
  });

  it('says when nothing matches', () => {
    const { tree } = typed('zebra', null);
    expect(words(tree)).toContain('No song begins a word with “zebra”.');
  });
});
