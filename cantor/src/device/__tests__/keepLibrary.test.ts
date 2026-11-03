import { keepLibrary } from '../keepLibrary';
import type { DeviceAlbum, DeviceLibrary, DeviceSong } from '../repository';

function song(id: string, title = `Song ${id}`): DeviceSong {
  return {
    id,
    mediaId: 1,
    path: `/music/${id}.mp3`,
    size: 100,
    headSha256: 'ab',
    durationMs: 1000,
    mime: 'audio/mpeg',
    title,
    titleFromTag: true,
    artist: null,
    albumArtist: null,
    disc: null,
    track: null,
    year: null,
    date: null,
    genre: null,
    albumKey: 'album',
    addedAtMs: 1,
    importedAtMs: 2,
    missingSinceMs: null,
  };
}

const album: DeviceAlbum = {
  key: 'album',
  title: 'Album',
  artist: null,
  year: null,
  folder: '/music',
  artwork: null,
};

function library(songs: DeviceSong[], tags: [string, string[]][] = []): DeviceLibrary {
  return {
    songs,
    albums: [{ ...album }],
    tags: new Map(tags),
    generations: new Map([['external', 4]]),
    excludedFolders: ['/junk'],
  };
}

describe('keepLibrary', () => {
  it('hands back the last read when nothing changed', () => {
    const before = library([song('a'), song('b')], [['a', ['x']]]);
    const read = library([song('a'), song('b')], [['a', ['x']]]);
    expect(keepLibrary(before, read)).toBe(before);
  });

  it('keeps every unchanged song and replaces only the changed one', () => {
    const before = library([song('a'), song('b'), song('c')]);
    const read = library([song('a'), song('b', 'Retitled'), song('c')]);
    const kept = keepLibrary(before, read);
    expect(kept).not.toBe(before);
    expect(kept.songs[0]).toBe(before.songs[0]);
    expect(kept.songs[1]).toBe(read.songs[1]);
    expect(kept.songs[2]).toBe(before.songs[2]);
    expect(kept.albums).toBe(before.albums);
    expect(kept.tags).toBe(before.tags);
  });

  it('takes the new list when songs arrive or go, keeping the old objects', () => {
    const before = library([song('a'), song('b')]);
    const read = library([song('a'), song('b'), song('c')]);
    const kept = keepLibrary(before, read);
    expect(kept.songs).toHaveLength(3);
    expect(kept.songs[0]).toBe(before.songs[0]);
    expect(kept.songs[2]).toBe(read.songs[2]);
    const fewer = keepLibrary(before, library([song('b')]));
    expect(fewer.songs).toEqual([before.songs[1]]);
    expect(fewer.songs[0]).toBe(before.songs[1]);
  });

  it('keeps a song\'s tags while they read the same', () => {
    const before = library([song('a'), song('b')], [['a', ['x']], ['b', ['y']]]);
    const read = library([song('a'), song('b')], [['a', ['x']], ['b', ['z']]]);
    const kept = keepLibrary(before, read);
    expect(kept.tags).not.toBe(before.tags);
    expect(kept.tags.get('a')).toBe(before.tags.get('a'));
    expect(kept.tags.get('b')).toEqual(['z']);
    expect(kept.songs).toBe(before.songs);
  });
});
