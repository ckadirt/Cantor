import { LAYOUT_KNOBS, layoutField } from '../../layout';
import { BROWSE_KNOBS } from '../../browse';
import { orderByKey } from '../../order';
import type { FieldEntity, FieldRecord } from '../../types';
import {
  ENGINE_SUBTITLE,
  GENERATED_LABEL,
  SECTION_GENERATED,
  SECTION_IMPORTED,
  UNKNOWN_ARTIST_LABEL,
  UNKNOWN_MODEL_LABEL,
  VARIOUS_ARTISTS_LABEL,
  byAlbum,
  byArtist,
  modelLabel,
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

function generated(
  id: string,
  model: string | null = 'acestep:1.5-fast',
  node = 'node-a',
): FieldEntity {
  return {
    key: `${node}:${id}`,
    nodePublicKey: node,
    entityId: id,
    kind: 'song',
    createdAtMs: ARRIVED - 1,
    durationMs: 30_000,
    tags: [],
    ...(model === null ? {} : { model }),
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
    // The artist is what tells the two Greatest Hits apart on screen, and
    // every album keeps its middle for its cover; the songs with no album
    // have no cover to keep it for.
    expect(groups.map(group => group.subtitle)).toEqual([
      'miles davis',
      'miles davis',
      'Miles Davis',
      undefined,
    ]);
    expect(groups.map(group => group.hub === true)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('names an album by its artist, or says when its files disagree or say nothing', () => {
    const [mixed] = byAlbum.group([
      imported('a', kind(1001)),
      imported('b', kind(1002, 'Bill Evans')),
    ]);
    expect(mixed.subtitle).toBe(VARIOUS_ARTISTS_LABEL);
    const [folded] = byAlbum.group([
      imported('a', kind(1001)),
      imported('b', kind(1002, 'MILES DAVIS')),
      imported('c', kind(1003, null)),
    ]);
    expect(folded.subtitle).toBe('Miles Davis');
    const [nobody] = byAlbum.group([imported('a', kind(1001, null))]);
    expect(nobody.subtitle).toBe(UNKNOWN_ARTIST_LABEL);
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
  it('merges spellings, names untagged files, and credits generated songs to their model first', () => {
    const groups = byArtist.group([
      generated('g'),
      imported('a', kind(1001)),
      imported('h', hits('/Music/A')),
      imported('u', kind(1002, null)),
    ]);
    expect(groups.map(group => group.label)).toEqual([
      'acestep 1.5 fast',
      'Miles Davis',
      UNKNOWN_ARTIST_LABEL,
    ]);
    expect(groups[1].entityKeys).toEqual(['device:a', 'device:h']);
    expect(groups[0].subtitle).toBe(ENGINE_SUBTITLE);
    expect(groups[1].subtitle).toBeUndefined();
    expect(groups.map(group => group.section)).toEqual([
      SECTION_GENERATED,
      SECTION_IMPORTED,
      SECTION_IMPORTED,
    ]);
  });

  it('keeps one model on two nodes as one artist, and names a song with none', () => {
    const groups = byArtist.group([
      generated('a', 'acestep:1.5-quality', 'node-a'),
      generated('b', 'acestep:1.5-quality', 'node-b'),
      generated('c', 'acestep:1.5-fast'),
      generated('d', null),
    ]);
    expect(groups.map(group => [group.label, group.entityKeys.length])).toEqual(
      [
        ['acestep 1.5 fast', 1],
        ['acestep 1.5 quality', 2],
        [UNKNOWN_MODEL_LABEL, 1],
      ],
    );
    // One kind of song alone is not two parts: no hairline to draw.
    expect(groups.every(group => group.section === undefined)).toBe(true);
  });

  it('starts the imported artists on a row of their own, under a hairline', () => {
    const layout = layoutField({
      entities: [
        generated('g'),
        imported('a', kind(1001)),
        imported('b', kind(1002, 'Bill Evans')),
      ],
      arrangement: byArtist,
      viewport,
    });
    const [engine, bill, miles] = layout.groups;
    expect(layout.groups.map(group => group.section)).toEqual([
      SECTION_GENERATED,
      SECTION_IMPORTED,
      SECTION_IMPORTED,
    ]);
    // The engine sits alone in its row rather than beside an artist.
    expect(engine.cx).toBe(0);
    expect(bill.top).toBe(miles.top);
    // Past the engine's own cluster and the gap between rows, the hairline's
    // room besides.
    const engineBottom = Math.max(
      ...layout.placements
        .filter(placement => placement.groupKey === engine.key)
        .map(placement => placement.y + placement.bloomY),
    );
    expect((bill.top - engineBottom) * layout.fitScale).toBeGreaterThanOrEqual(
      BROWSE_KNOBS.GROUP_GAP_PX + LAYOUT_KNOBS.SECTION_GAP_PX - 0.01,
    );
  });
});

describe('modelLabel', () => {
  it('reads a selector as words', () => {
    expect(modelLabel('acestep:1.5-fast')).toBe('acestep 1.5 fast');
    expect(modelLabel('acestep-xl')).toBe('acestep xl');
  });
});
