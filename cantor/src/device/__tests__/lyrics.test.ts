import { cleanLyrics, lyricsFor, searchesFor, type LyricsQuery } from '../lyrics';

const song: LyricsQuery = {
  path: '/storage/emulated/0/Music/runaway.flac',
  title: 'Runaway',
  titleFromTag: true,
  artist: 'Kanye West;Pusha T',
  album: 'My Beautiful Dark Twisted Fantasy',
  durationMs: 547_733,
};

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

describe('cleanLyrics', () => {
  it('drops LRC timestamps, header tags and word stamps', () => {
    const lrc = [
      '[ar:HAVEN]',
      '[offset:+120]',
      '[00:31.20]I run <00:31.90>to you',
      '[00:35.00][01:35.00]  hold on  ',
      '',
      '',
      '',
      '[00:40.10]',
      '[00:41.00]still here',
    ].join('\r\n');
    expect(cleanLyrics(lrc)).toBe('I run to you\nhold on\n\nstill here');
  });

  it('keeps section tags, which are words to the model', () => {
    expect(cleanLyrics('[Verse 1]\nfirst line\n\n[Chorus]\nsecond')).toBe(
      '[Verse 1]\nfirst line\n\n[Chorus]\nsecond',
    );
  });

  it('is null for nothing, or only an instrumental marker', () => {
    expect(cleanLyrics('  \n\n')).toBeNull();
    expect(cleanLyrics('[00:01.00]\n[00:02.00]')).toBeNull();
    expect(cleanLyrics('[Instrumental]')).toBeNull();
    expect(cleanLyrics('instrumental')).toBeNull();
  });
});

describe('searchesFor', () => {
  it('adds a bare search when the tags carry features', () => {
    expect(
      searchesFor({ title: 'It’s Only (feat. Zyra)', artist: 'ODESZA' }),
    ).toEqual([
      { title: 'It’s Only (feat. Zyra)', artist: 'ODESZA' },
      { title: "It's Only", artist: 'ODESZA' },
    ]);
    expect(searchesFor({ title: 'I Run', artist: 'Haven., Kaitlin Aragon' })[1]).toEqual(
      { title: 'I Run', artist: 'Haven.' },
    );
  });

  it('searches once when there is nothing to strip', () => {
    expect(searchesFor({ title: 'Nightlight', artist: 'ILLENIUM' })).toEqual([
      { title: 'Nightlight', artist: 'ILLENIUM' },
    ]);
  });
});

describe('lyricsFor', () => {
  it('takes the tags first and never asks LRCLIB', async () => {
    const fetchFn = jest.fn();
    const words = await lyricsFor(song, {
      tags: () => Promise.resolve('[00:30.00]line one\n[00:33.00]line two'),
      fetch: fetchFn,
    });
    expect(words).toBe('line one\nline two');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asks LRCLIB by title and artist, and takes the hit of the same length', async () => {
    const fetchFn = jest.fn((url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        'User-Agent': 'Cantor (https://github.com/ckadirt/Cantor)',
      });
      return url.includes('Pusha')
        ? respond([])
        : respond([
            { duration: 240, plainLyrics: 'the radio edit' },
            { duration: 548, instrumental: true, plainLyrics: null },
            { duration: 548.0, plainLyrics: 'the album cut', syncedLyrics: '[00:01.00]x' },
          ]);
    });
    expect(
      await lyricsFor(song, { tags: () => Promise.resolve(null), fetch: fetchFn as never }),
    ).toBe('the album cut');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe(
      'https://lrclib.net/api/search?track_name=Runaway&artist_name=Kanye%20West',
    );
  });

  it('reads synced lyrics when a hit has no plain ones', async () => {
    const words = await lyricsFor(song, {
      tags: () => Promise.resolve(null),
      fetch: (() => respond([{ duration: 547, syncedLyrics: '[00:10.00]look at ya' }])) as never,
    });
    expect(words).toBe('look at ya');
  });

  it('is null when nothing matches the length, or anything fails', async () => {
    const none = { tags: () => Promise.resolve(null) };
    expect(
      await lyricsFor(song, { ...none, fetch: (() => respond([{ duration: 300, plainLyrics: 'x' }])) as never }),
    ).toBeNull();
    expect(await lyricsFor(song, { ...none, fetch: (() => respond({}, false)) as never })).toBeNull();
    expect(
      await lyricsFor(song, { ...none, fetch: (() => Promise.reject(new Error('offline'))) as never }),
    ).toBeNull();
    expect(
      await lyricsFor(song, {
        tags: () => Promise.reject(new Error('unreadable')),
        fetch: (() => respond([{ duration: 548, plainLyrics: 'still found' }])) as never,
      }),
    ).toBe('still found');
  });

  it('never searches by a file name, or without an artist', async () => {
    const fetchFn = jest.fn();
    const sources = { tags: () => Promise.resolve(null), fetch: fetchFn };
    expect(await lyricsFor({ ...song, titleFromTag: false }, sources)).toBeNull();
    expect(await lyricsFor({ ...song, artist: null }, sources)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
