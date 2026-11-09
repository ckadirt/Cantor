import { nodeTagOf, readMarker, writeMarker } from '../marker';
import { copyFromMarker, formatOfPath, withoutKnownCopies } from '../scan';
import type { MediaRow } from '../../device/native';

const SONG = '0B6F9C1E-6A3D-4C55-9A3E-2F4B8D7C1A90';
const DIGEST = 'e'.repeat(64);

describe('the export marker', () => {
  it('reads back what it writes, without the node key in it', () => {
    const key = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ';
    const raw = writeMarker(key, SONG, DIGEST);
    expect(raw).not.toContain(key);
    expect(raw.split(';')).toHaveLength(4);
    expect(readMarker(raw)).toEqual({
      nodeTag: nodeTagOf(key),
      songId: SONG.toLowerCase(),
      digest: DIGEST,
    });
  });

  it('reads nothing it does not know', () => {
    const tag = nodeTagOf('rtx');
    for (const raw of [
      null,
      undefined,
      '',
      `v2;${tag};${SONG};${DIGEST}`,
      `v1;${tag};${SONG}`,
      `v1;${tag};not-a-song;${DIGEST}`,
      `v1;${tag};${SONG};${DIGEST.slice(1)}`,
      `v1;xyz;${SONG};${DIGEST}`,
      `v1;${tag};${SONG};${DIGEST};extra`,
    ]) {
      expect(readMarker(raw)).toBeNull();
    }
  });
});

describe('copies in a scan', () => {
  const row = (mediaId: number, path: string): MediaRow => ({
    mediaId,
    path,
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    durationMs: 60_000,
    mime: null,
    size: 10,
    addedAtMs: 0,
    generation: null,
  });

  it('drops rows a known copy has, by path or by MediaStore id', () => {
    const rows = [row(1, '/a.opus'), row(2, '/b.opus'), row(3, '/c.mp3')];
    const copy = {
      nodeKey: 'rtx',
      songId: SONG,
      format: 'opus' as const,
      digest: DIGEST,
      savedAtMs: 0,
      bytes: 1,
      uri: 'content://x',
    };
    expect(
      withoutKnownCopies(rows, [
        { ...copy, path: '/a.opus', mediaId: null },
        { ...copy, path: null, mediaId: 3 },
      ]).map(r => r.mediaId),
    ).toEqual([2]);
  });

  it('knows a format by its extension', () => {
    expect(formatOfPath('/x/Song.OPUS')).toBe('opus');
    expect(formatOfPath('/x/Song.ogg')).toBe('opus');
    expect(formatOfPath('/x/Song.mp3')).toBe('mp3');
    expect(formatOfPath('/x/Song.wav')).toBe('wav');
    expect(formatOfPath('/x/Song.flac')).toBeNull();
  });

  it('makes no copy of a file in a format Cantor does not save', () => {
    const inspection = {
      size: 5,
      headSha256: '0'.repeat(64),
      tags: {} as never,
      marker: writeMarker('rtx', SONG, DIGEST),
    };
    expect(
      copyFromMarker(row(4, '/d.flac'), inspection, () => 'rtx', 1),
    ).toBeNull();
    expect(
      copyFromMarker(row(4, '/d.opus'), inspection, () => 'rtx', 1),
    ).toMatchObject({ nodeKey: 'rtx', format: 'opus', mediaId: 4, bytes: 5 });
  });
});
