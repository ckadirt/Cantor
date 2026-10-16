import {
  LYRICS_KNOBS,
  cleanLyrics,
  lrclibLyrics,
  retryAfter,
  searchesFor,
  tagLyrics,
  type LyricsQuery,
} from '../lyrics';

const song: LyricsQuery = {
  title: 'Runaway',
  titleFromTag: true,
  artist: 'Kanye West;Pusha T',
  album: 'My Beautiful Dark Twisted Fantasy',
  durationMs: 547_733,
};

function respond(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response);
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

describe('tagLyrics', () => {
  it("cleans the file's own words", async () => {
    expect(
      await tagLyrics('/a.flac', () =>
        Promise.resolve('[00:30.00]line one\n[00:33.00]line two'),
      ),
    ).toEqual({ status: 'found', value: 'line one\nline two' });
  });

  it('is none for no tag, an instrumental tag, or a file it cannot read', async () => {
    expect(await tagLyrics('/a.flac', () => Promise.resolve(null))).toEqual({
      status: 'none',
    });
    expect(
      await tagLyrics('/a.flac', () => Promise.resolve('[Instrumental]')),
    ).toEqual({
      status: 'none',
    });
    expect(
      await tagLyrics('/a.flac', () => Promise.reject(new Error('unreadable'))),
    ).toEqual({ status: 'none' });
  });
});

describe('lrclibLyrics', () => {
  it('asks by title and artist, and takes the hit of the same length', async () => {
    const fetchFn = jest.fn((url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        'User-Agent': 'Cantor (https://github.com/ckadirt/Cantor)',
      });
      return url.includes('Pusha')
        ? respond([])
        : respond([
            { duration: 240, plainLyrics: 'the radio edit' },
            { duration: 548, instrumental: true, plainLyrics: null },
            {
              duration: 548.0,
              plainLyrics: 'the album cut',
              syncedLyrics: '[00:01.00]x',
            },
          ]);
    });
    expect(await lrclibLyrics(song, fetchFn as never)).toEqual({
      status: 'found',
      value: 'the album cut',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1]![0]).toBe(
      'https://lrclib.net/api/search?track_name=Runaway&artist_name=Kanye%20West',
    );
  });

  it('reads synced lyrics when a hit has no plain ones', async () => {
    expect(
      await lrclibLyrics(song, (() =>
        respond([
          { duration: 547, syncedLyrics: '[00:10.00]look at ya' },
        ])) as never),
    ).toEqual({ status: 'found', value: 'look at ya' });
  });

  it('says why there are none: nothing of that length, or listed instrumental', async () => {
    expect(
      await lrclibLyrics(song, (() =>
        respond([{ duration: 300, plainLyrics: 'x' }])) as never),
    ).toEqual({ status: 'none', reason: 'not-found' });
    expect(await lrclibLyrics(song, (() => respond({}, 404)) as never)).toEqual(
      {
        status: 'none',
        reason: 'not-found',
      },
    );
    expect(
      await lrclibLyrics(song, (() =>
        respond([
          { duration: 300, plainLyrics: 'another cut' },
          { duration: 548, instrumental: true, plainLyrics: null },
        ])) as never),
    ).toEqual({ status: 'none', reason: 'instrumental' });
  });

  it('asks a busy LRCLIB again, resting between, and takes the answer', async () => {
    const rests: number[] = [];
    let calls = 0;
    const fetchFn = () => {
      calls += 1;
      return calls <= 2
        ? respond({ message: 'The server is busy' }, 503)
        : respond([{ duration: 548, plainLyrics: 'third time' }]);
    };
    const found = await lrclibLyrics(
      song,
      fetchFn as never,
      undefined,
      async ms => {
        rests.push(ms);
      },
    );
    expect(found).toEqual({ status: 'found', value: 'third time' });
    expect(rests).toEqual(LYRICS_KNOBS.RETRY_DELAYS_MS.slice(0, 2));
  });

  it('is busy when LRCLIB stays busy, and offline when nothing answers', async () => {
    const rests: number[] = [];
    const wait = async (ms: number) => {
      rests.push(ms);
    };
    expect(
      await lrclibLyrics(
        song,
        (() => respond({}, 503)) as never,
        undefined,
        wait,
      ),
    ).toEqual({ status: 'unreachable', reason: 'busy' });
    // Every search is asked once and again after each rest.
    expect(rests).toEqual([
      ...LYRICS_KNOBS.RETRY_DELAYS_MS,
      ...LYRICS_KNOBS.RETRY_DELAYS_MS,
    ]);
    expect(
      await lrclibLyrics(
        song,
        (() => Promise.reject(new Error('offline'))) as never,
        undefined,
        async () => {},
      ),
    ).toEqual({ status: 'unreachable', reason: 'offline' });
  });

  it('rests as long as Retry-After asks, and stops when it asks too long', async () => {
    const rests: number[] = [];
    let calls = 0;
    const fetchFn = () => {
      calls += 1;
      return calls === 1
        ? respond({}, 429, { 'Retry-After': '2' })
        : respond([{ duration: 548, plainLyrics: 'after the wait' }]);
    };
    expect(
      await lrclibLyrics(song, fetchFn as never, undefined, async ms => {
        rests.push(ms);
      }),
    ).toEqual({ status: 'found', value: 'after the wait' });
    expect(rests).toEqual([2000]);

    const never = jest.fn(async () => {});
    expect(
      await lrclibLyrics(
        { ...song, artist: 'Hugo Kant' },
        (() => respond({}, 429, { 'Retry-After': '600' })) as never,
        undefined,
        never,
      ),
    ).toEqual({ status: 'unreachable', reason: 'busy', retryAfterMs: 600_000 });
    expect(never).not.toHaveBeenCalled();
  });

  it('takes a found answer over a search that could not be reached', async () => {
    const fetchFn = (url: string) =>
      url.includes('Pusha')
        ? Promise.reject(new Error('reset'))
        : respond([{ duration: 548, plainLyrics: 'still found' }]);
    expect(
      await lrclibLyrics(song, fetchFn as never, undefined, async () => {}),
    ).toEqual({
      status: 'found',
      value: 'still found',
    });
  });

  it('never searches by a file name, or without an artist', async () => {
    const fetchFn = jest.fn();
    expect(
      await lrclibLyrics({ ...song, titleFromTag: false }, fetchFn),
    ).toEqual({
      status: 'none',
      reason: 'untagged',
    });
    expect(await lrclibLyrics({ ...song, artist: null }, fetchFn)).toEqual({
      status: 'none',
      reason: 'untagged',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('retryAfter', () => {
  it('reads seconds or an HTTP date', () => {
    expect(retryAfter('30', 0)).toBe(30_000);
    expect(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0)).toBe(60_000);
    expect(retryAfter(null)).toBeUndefined();
    expect(retryAfter('soon')).toBeUndefined();
  });
});
