import { layoutField } from '../../layout';
import type { FieldEntity } from '../../types';
import { UNFILED_LABEL, byPlaylist } from '../byPlaylist';

const viewport = { width: 380, height: 800 };

function entity(id: string, tags: string[]): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs: Date.parse('2026-08-10T00:00:00Z'),
    tags,
  };
}

function groupsOf(entities: readonly FieldEntity[]) {
  return byPlaylist.group(entities);
}

describe('byPlaylist', () => {
  it('puts a song with no playlist in Unfiled', () => {
    const groups = groupsOf([entity('a', ['ambient'])]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNFILED_LABEL);
    expect(groups[0].entityKeys).toEqual(['node-a:a']);
  });

  it('gives a song in one playlist one group', () => {
    const groups = groupsOf([entity('a', ['p/Focus'])]);

    expect(groups.map(group => group.label)).toEqual(['Focus']);
  });

  it('puts a song in three playlists into three groups at once', () => {
    const groups = groupsOf([
      entity('a', ['p/Focus', 'p/Drive', 'p/Late night', 'ambient']),
    ]);

    expect(groups).toHaveLength(3);
    for (const group of groups) {
      expect(group.entityKeys).toEqual(['node-a:a']);
    }
  });

  it('emits one placement per membership, so the song is really in three places', () => {
    const song = entity('a', ['p/Focus', 'p/Drive', 'p/Late night']);
    const layout = layoutField({
      entities: [song],
      arrangement: byPlaylist,
      viewport,
    });

    expect(layout.placements).toHaveLength(3);
    // Three distinct placements of one entity, each in its own group.
    expect(new Set(layout.placements.map(p => p.key)).size).toBe(3);
    for (const placement of layout.placements) {
      expect(placement.entityKey).toBe(song.key);
    }
    expect(new Set(layout.placements.map(p => p.groupKey)).size).toBe(3);
  });

  it('counts placements as memberships plus unfiled entities', () => {
    const entities = [
      entity('a', ['p/Focus', 'p/Drive']), // 2
      entity('b', ['p/Focus']), // 1
      entity('c', ['ambient']), // unfiled: 1
      entity('d', []), // unfiled: 1
    ];

    const layout = layoutField({ entities, arrangement: byPlaylist, viewport });

    expect(layout.placements).toHaveLength(5);
    // And nothing is lost.
    expect(new Set(layout.placements.map(p => p.entityKey)).size).toBe(4);
  });

  it('merges playlists whose spelling differs only by case', () => {
    const groups = groupsOf([
      entity('a', ['p/Late night']),
      entity('b', ['p/LATE NIGHT']),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].entityKeys).toHaveLength(2);
    // The first spelling seen is the one shown.
    expect(groups[0].label).toBe('Late night');
  });

  it('merges the same playlist across two backends', () => {
    const studio = entity('a', ['p/Focus']);
    const laptop: FieldEntity = {
      ...entity('b', ['p/Focus']),
      key: 'node-b:b',
      nodePublicKey: 'node-b',
    };

    const groups = groupsOf([studio, laptop]);

    expect(groups).toHaveLength(1);
    expect(groups[0].entityKeys).toEqual(['node-a:a', 'node-b:b']);
  });

  it('counts a song that names one playlist twice as being in it once', () => {
    const groups = groupsOf([entity('a', ['p/Focus', 'p/focus'])]);

    expect(groups).toHaveLength(1);
    expect(groups[0].entityKeys).toEqual(['node-a:a']);
  });

  it('ignores plain tags entirely', () => {
    const groups = groupsOf([entity('a', ['ambient', 'drums', 'piano'])]);

    expect(groups.map(group => group.label)).toEqual([UNFILED_LABEL]);
  });

  it('puts Unfiled last, because it is not a playlist', () => {
    const groups = groupsOf([
      entity('a', []),
      entity('b', ['p/Zebra']),
      entity('c', ['p/Apple']),
    ]);

    expect(groups.map(group => group.label)).toEqual([
      'Apple',
      'Zebra',
      UNFILED_LABEL,
    ]);
  });

  it('has no Unfiled group when everything is filed', () => {
    const groups = groupsOf([entity('a', ['p/Focus'])]);

    expect(groups.some(group => group.label === UNFILED_LABEL)).toBe(false);
  });

  it('gives every group a unique key so placements cannot collide', () => {
    const groups = groupsOf([
      entity('a', ['p/Focus', 'p/Drive']),
      entity('b', []),
    ]);

    expect(new Set(groups.map(group => group.key)).size).toBe(groups.length);
  });

  it('lays out an empty library without inventing a group', () => {
    expect(groupsOf([])).toEqual([]);
  });
});
