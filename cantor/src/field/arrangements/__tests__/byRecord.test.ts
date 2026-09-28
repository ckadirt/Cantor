import { layoutField } from '../../layout';
import { orderByKey } from '../../order';
import type { FieldEntity, FieldRecord } from '../../types';
import {
  GENERATED_LABEL,
  UNKNOWN_ARTIST_LABEL,
  byAlbum,
  byArtist,
} from '../byRecord';

const viewport = { width: 380, height: 800 };
const ARRIVED = Date.parse('2026-09-21T10:00:00Z');

function imported(id: string, record: FieldRecord): FieldEntity {
  return {
    key: `device:${id}`,
    nodePublicKey: 'device',
    entityId: id,
    kind: 'song',
    createdAtMs: ARRIVED,
    durationMs: 30_000,
    tags: [],
    record,
  };
}

function generated(id: string): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs: ARRIVED - 1,
    durationMs: 30_000,
    tags: [],
  };
}

const kind = (track: number | null, artist: string | null = 'Miles Davis') => ({
  albumKey: 'miles davis|kind of blue|/Music/Kind of Blue',
  album: 'Kind of Blue',
  artist,
  track,
  arrivedMs: ARRIVED,
});
const hits = (folder: string) => ({
  albumKey: `|greatest hits|${folder}`,
  album: 'Greatest Hits',
  artist: 'miles davis',
  track: 1001,
  arrivedMs: ARRIVED,
});

describe('byAlbum', () => {
  it('groups by album key, keeps two same-named albums apart, and puts generated songs last', () => {
    const groups = byAlbum.group([
      generated('g'),
      imported('b', kind(1002)),
      imported('a', kind(1001)),
      imported('h1', hits('/Music/A')),
      imported('h2', hits('/Music/B')),
    ]);
    expect(groups.map(group => group.label)).toEqual([
      'Greatest Hits',
      'Greatest Hits',
      'Kind of Blue',
      GENERATED_LABEL,
    ]);
    expect(new Set(groups.map(group => group.key)).size).toBe(4);
    expect(groups[3].entityKeys).toEqual(['node-a:g']);
  });

  it('seats an album in its track order, however its files straddled the clock', () => {
    const late = (entity: FieldEntity, byMs: number) => ({
      ...entity,
      createdAtMs: entity.createdAtMs + byMs,
    });
    const entities = [
      imported('z', kind(1001)),
      late(imported('a', kind(2001)), -500),
      late(imported('m', kind(1003)), 1_000),
      imported('q', kind(null)),
    ];
    const layout = layoutField({
      entities,
      arrangement: byAlbum,
      viewport,
      order: orderByKey('date'),
    });
    const seated = [...layout.placements]
      .sort((left, right) => left.y - right.y)
      .map(placement => placement.entityKey);
    expect(seated).toEqual(['device:z', 'device:m', 'device:a', 'device:q']);
  });
});

describe('byArtist', () => {
  it('merges spellings, names untagged files, and puts generated songs last', () => {
    const groups = byArtist.group([
      generated('g'),
      imported('a', kind(1001)),
      imported('h', hits('/Music/A')),
      imported('u', kind(1002, null)),
    ]);
    expect(groups.map(group => group.label)).toEqual([
      'Miles Davis',
      UNKNOWN_ARTIST_LABEL,
      GENERATED_LABEL,
    ]);
    expect(groups[0].entityKeys).toEqual(['device:a', 'device:h']);
  });
});
