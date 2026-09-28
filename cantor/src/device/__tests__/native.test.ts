import { NativeModules } from 'react-native';
import {
  decodeInspection,
  decodeLuma,
  decodeMediaRow,
  nativeMedia,
} from '../native';

// Taken from the Xiaomi (docs/import/log.md, I0 and I3).
const row = {
  mediaId: 1000000776,
  path: '/storage/emulated/0/Music/cantor-import-test/Test Artist/Fixture Album/01 - Tone MP3.mp3',
  title: 'Tone MP3',
  artist: 'Test Artist',
  album: 'Fixture Album',
  albumArtist: 'Test Artist',
  track: 1001,
  disc: '1/1',
  year: 2019,
  genre: 'Ambient',
  durationMs: 30041,
  mime: 'audio/mpeg',
  size: 730681,
  addedAtMs: 1790000000000,
  generation: 8994,
};

describe('decodeMediaRow', () => {
  it('passes raw values through, the MediaStore quirks included', () => {
    expect(decodeMediaRow(row)).toEqual(row);
    const untagged = decodeMediaRow({
      ...row,
      title: '07 - Untagged Tone',
      artist: '<unknown>',
      album: 'loose',
      albumArtist: null,
      track: null,
      disc: null,
      year: null,
      genre: null,
    });
    expect(untagged.artist).toBe('<unknown>');
    expect(untagged.album).toBe('loose');
  });

  it('reads columns missing before Android 11 as null', () => {
    const old: Record<string, unknown> = { ...row };
    for (const column of ['albumArtist', 'disc', 'genre', 'generation']) {
      delete old[column];
    }
    expect(decodeMediaRow(old)).toMatchObject({
      albumArtist: null,
      disc: null,
      genre: null,
      generation: null,
    });
  });

  it('rejects a row without a path or with a bad number', () => {
    expect(() => decodeMediaRow({ ...row, path: '' })).toThrow('path');
    expect(() => decodeMediaRow({ ...row, size: -1 })).toThrow('size');
    expect(() => decodeMediaRow({ ...row, durationMs: 1.5 })).toThrow(
      'durationMs',
    );
    expect(() => decodeMediaRow(null)).toThrow('not an object');
  });
});

describe('decodeInspection', () => {
  const inspection = {
    size: 730681,
    headSha256: 'c'.repeat(64),
    tags: { title: 'Tone MP3', date: '2019', album: null },
  };

  it('fills absent tags with null', () => {
    expect(decodeInspection(inspection).tags).toEqual({
      title: 'Tone MP3',
      artist: null,
      album: null,
      albumArtist: null,
      track: null,
      disc: null,
      year: null,
      date: '2019',
      genre: null,
    });
  });

  it('rejects a hash that is not sha256 hex', () => {
    expect(() =>
      decodeInspection({ ...inspection, headSha256: 'c74c0282eaa2' }),
    ).toThrow('headSha256');
  });
});

describe('nativeMedia', () => {
  type Mock = Record<string, jest.Mock>;
  afterEach(() => {
    delete (NativeModules as { CantorMedia?: Mock }).CantorMedia;
  });

  it('lists through the bridge and checks what comes back', async () => {
    const bridge: Mock = {
      list: jest.fn(async () => [row]),
      generation: jest.fn(async () => 9019),
      albumArt: jest.fn(async () => 'abc.jpg'),
    };
    (NativeModules as { CantorMedia?: Mock }).CantorMedia = bridge;
    expect(await nativeMedia.list(30000)).toEqual([row]);
    expect(bridge.list).toHaveBeenCalledWith(30000);
    expect(await nativeMedia.generation()).toBe(9019);
    expect(await nativeMedia.albumArt(1, 'abc')).toBe('abc.jpg');
  });

  it('treats no art as null and a mismatched file name as an error', async () => {
    const bridge: Mock = { albumArt: jest.fn(async () => null) };
    (NativeModules as { CantorMedia?: Mock }).CantorMedia = bridge;
    expect(await nativeMedia.albumArt(1, 'abc')).toBeNull();
    bridge.albumArt.mockResolvedValueOnce('other.jpg');
    await expect(nativeMedia.albumArt(1, 'abc')).rejects.toThrow('invalid');
  });

  it('says so when the module is missing', async () => {
    await expect(nativeMedia.generation()).rejects.toThrow('unavailable');
  });
});

describe('decodeLuma', () => {
  it('takes a full grid of brightness and nothing else', () => {
    expect(Array.from(decodeLuma([0, 0.5, 1, 0.25], 2))).toEqual([
      0, 0.5, 1, 0.25,
    ]);
    expect(() => decodeLuma([0, 0.5, 1], 2)).toThrow();
    expect(() => decodeLuma([0, 0.5, 1, 1.5], 2)).toThrow();
    expect(() => decodeLuma([0, 0.5, 1, Number.NaN], 2)).toThrow();
    expect(() => decodeLuma('grid', 2)).toThrow();
  });
});
