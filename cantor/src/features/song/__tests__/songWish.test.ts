import type { SongHeader } from '../../../core/protocol';
import {
  foldWish,
  pendingLookup,
  pendingNames,
  settleWish,
  wishedSong,
} from '../songWish';

const song = (over: Partial<SongHeader> = {}): SongHeader =>
  ({
    id: '1f2e3d4c-5b6a-4978-8765-4321abcdef00',
    title: 'Lanterns',
    revision: 7,
    tags: ['p/Dog walk', 'ambient'],
    favorite: false,
    trashed: false,
    artifacts: [],
    ...over,
  }) as SongHeader;

describe('songWish', () => {
  it('lets the last ask win per field, and leaves the others alone', () => {
    const folded = foldWish({ title: 'One', favorite: true }, { title: 'Two' });
    expect(folded).toEqual({ title: 'Two', favorite: true });
  });

  it('draws the ask over the truth without inventing a revision', () => {
    const drawn = wishedSong(song(), { tags: ['ambient'], favorite: true });
    expect(drawn.tags).toEqual(['ambient']);
    expect(drawn.favorite).toBe(true);
    // The guard on the wire is the node's number, and nothing here is allowed
    // to be a source of it.
    expect(drawn.revision).toBe(song().revision);
    expect(drawn.title).toBe('Lanterns');
  });

  it('drops a field only once the node already agrees with it', () => {
    const wish = { title: 'Harbour', favorite: true };
    // Nothing has landed: the same object comes back, because a fresh one
    // would look like a fresh ask and put the same patch on the wire forever.
    expect(settleWish(wish, song())).toBe(wish);
    expect(settleWish(wish, song({ title: 'Harbour' }))).toEqual({
      favorite: true,
    });
    expect(
      settleWish(wish, song({ title: 'Harbour', favorite: true })),
    ).toBeNull();
  });

  it('settles a tag list by membership, not by the order it is stored in', () => {
    const wish = { tags: ['ambient', 'p/Dog walk'] };
    expect(settleWish(wish, song({ tags: ['p/Dog walk', 'ambient'] }))).toBeNull();
    expect(settleWish(wish, song({ tags: ['p/DOG WALK', 'Ambient'] }))).toBeNull();
    expect(settleWish(wish, song({ tags: ['ambient'] }))).toBe(wish);
  });

  it('names what is unconfirmed on each side of the one tag array', () => {
    const known = song({ tags: ['p/Dog walk', 'ambient'] });
    const wish = { tags: ['p/Dog walk', 'p/Focus', 'loud'] };
    expect([...pendingNames(known, wish, 'playlist')]).toEqual(['focus']);
    expect([...pendingNames(known, wish, 'tag')].sort()).toEqual([
      'ambient',
      'loud',
    ]);
  });

  it('reads a pending name the way the tag namespace compares one', () => {
    const known = song({ tags: [] });
    const waiting = pendingLookup(
      pendingNames(known, { tags: ['p/Dog walk'] }, 'playlist'),
    );
    expect(waiting('Dog walk')).toBe(true);
    expect(waiting('  dog WALK ')).toBe(true);
    expect(waiting('Birthday')).toBe(false);
  });

  it('has nothing pending when the ask does not touch the tags', () => {
    expect(pendingNames(song(), { title: 'Harbour' }, 'tag').size).toBe(0);
    expect(pendingNames(song(), null, 'playlist').size).toBe(0);
  });
});
