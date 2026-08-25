import {
  allPlaylists,
  isPlaylistTag,
  normalise,
  plainTagsOf,
  playlistsOf,
  rename,
  toTag,
  toggle,
} from '../playlists';

describe('the p/ namespace', () => {
  it('separates playlists from a song\'s own tags', () => {
    const tags = ['p/Late night', 'ambient', 'p/Focus', 'drums'];

    expect(playlistsOf(tags)).toEqual(['Late night', 'Focus']);
    expect(plainTagsOf(tags)).toEqual(['ambient', 'drums']);
  });

  it('treats an empty playlist name as not a playlist at all', () => {
    expect(playlistsOf(['p/', 'p/   '])).toEqual([]);
    expect(isPlaylistTag('p/')).toBe(true);
    expect(normalise(['p/', 'p/  '])).toEqual([]);
  });

  it('stores the canonical form and keeps the display spelling', () => {
    expect(toTag('  Late Night ')).toBe('p/Late Night');
    expect(playlistsOf([toTag('Late Night')])).toEqual(['Late Night']);
  });
});

describe('normalise', () => {
  it('drops blanks and case-insensitive duplicates, keeping the first spelling', () => {
    expect(normalise(['Ambient', ' ambient ', '', '   ', 'AMBIENT'])).toEqual([
      'Ambient',
    ]);
  });

  it('preserves order, so a patch does not look like a change it is not', () => {
    expect(normalise(['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

describe('toggle', () => {
  it('adds a membership without disturbing the other tags', () => {
    expect(toggle(['ambient', 'p/Focus'], 'Late night', true)).toEqual([
      'ambient',
      'p/Focus',
      'p/Late night',
    ]);
  });

  it('removes a membership regardless of the spelling asked for', () => {
    expect(toggle(['ambient', 'p/Late Night'], 'late night', false)).toEqual([
      'ambient',
    ]);
  });

  it('does not add the same playlist twice', () => {
    const once = toggle(['p/Focus'], 'focus', true);

    expect(playlistsOf(once)).toHaveLength(1);
  });

  it('ignores a blank name rather than storing an unnameable playlist', () => {
    expect(toggle(['ambient'], '   ', true)).toEqual(['ambient']);
  });
});

describe('allPlaylists', () => {
  it('collects every playlist across a library, once, in display order', () => {
    const library = [
      ['p/Late night', 'ambient'],
      ['p/Focus'],
      ['p/late NIGHT', 'p/Drive'],
    ];

    expect(allPlaylists(library)).toEqual(['Drive', 'Focus', 'Late night']);
  });

  it('is empty for a library with no playlists', () => {
    expect(allPlaylists([['ambient'], []])).toEqual([]);
  });
});

describe('rename', () => {
  it('renames only the matching playlist', () => {
    expect(rename(['p/Focus', 'p/Drive', 'ambient'], 'focus', 'Deep work')).toEqual(
      ['p/Deep work', 'p/Drive', 'ambient'],
    );
  });

  it('leaves a song that is not a member untouched', () => {
    expect(rename(['p/Drive'], 'Focus', 'Deep work')).toEqual(['p/Drive']);
  });

  it('merges when renaming onto a playlist the song already has', () => {
    const result = rename(['p/Focus', 'p/Deep work'], 'Focus', 'Deep work');

    expect(playlistsOf(result)).toEqual(['Deep work']);
  });
});
