import {
  EMPTY_FILTER,
  applyTagFilter,
  tagCounts,
  type FieldEntity,
} from '..';

function entity(
  id: string,
  tags: readonly string[],
  kind: FieldEntity['kind'] = 'song',
): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind,
    createdAtMs: 0,
    durationMs: 60_000,
    tags,
  };
}

const rainy = entity('rainy', ['Rainy']);
const live = entity('live', ['live']);
const both = entity('both', ['rainy', 'Live', 'p/Late night']);
const listed = entity('listed', ['p/Rainy']);
const library = [rainy, live, both, listed];

const ids = (entities: readonly FieldEntity[]) =>
  entities.map(each => each.entityId);

describe('the tag filter', () => {
  it('returns the very same array when empty, so memos hold', () => {
    expect(applyTagFilter(library, EMPTY_FILTER)).toBe(library);
    expect(applyTagFilter(library, { tags: [], mode: 'all' })).toBe(library);
  });

  it('keeps a song with any of the tags, or only one with all of them', () => {
    const tags = ['rainy', 'live'];
    expect(ids(applyTagFilter(library, { tags, mode: 'any' }))).toEqual([
      'rainy',
      'live',
      'both',
    ]);
    expect(ids(applyTagFilter(library, { tags, mode: 'all' }))).toEqual([
      'both',
    ]);
  });

  it('folds case and spacing the way tags are compared', () => {
    expect(
      ids(applyTagFilter(library, { tags: ['  RAINY '], mode: 'any' })),
    ).toEqual(['rainy', 'both']);
  });

  it('ignores playlist tags, on both sides', () => {
    // A playlist called Rainy is not the tag rainy.
    expect(
      ids(applyTagFilter(library, { tags: ['Rainy'], mode: 'any' })),
    ).not.toContain('listed');
    expect(
      applyTagFilter(library, { tags: ['p/Late night'], mode: 'any' }),
    ).toEqual([]);
  });

  it('counts every song, keeping the first spelling and the tag order', () => {
    expect(tagCounts(library)).toEqual([
      { tag: 'live', count: 2 },
      { tag: 'Rainy', count: 2 },
    ]);
  });

  it('counts a tag once per song and leaves jobs out', () => {
    const twice = entity('twice', ['live', 'LIVE']);
    const job = entity('job', ['live'], 'job');
    expect(tagCounts([twice, job])).toEqual([{ tag: 'live', count: 1 }]);
    expect(tagCounts([])).toEqual([]);
  });
});
