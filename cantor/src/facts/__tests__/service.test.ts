import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { DEVICE_MIGRATIONS } from '../../device/schema';
import {
  FACT_KNOBS,
  createFactRepository,
  createFacts,
  lyricsProviders,
  readingOf,
  type DeviceSubject,
  type FactProvider,
  type Lookup,
  type NodeSubject,
} from '..';
import type { SongDetail } from '../../../../protocol/SongDetail';

const device: DeviceSubject = {
  kind: 'device',
  key: 'device:d0123456789abcdef',
  path: '/Music/runaway.flac',
  title: 'Runaway',
  titleFromTag: true,
  artist: 'Kanye West',
  album: null,
  durationMs: 547_733,
};

async function database() {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  return db;
}

/** A provider that answers what a test tells it, counting the asks. */
function scripted(source: string, ...answers: Lookup[]) {
  const asked: string[] = [];
  const provider: FactProvider = {
    source,
    lookup: async subject => {
      asked.push(subject.key);
      return answers.shift() ?? { status: 'none' };
    },
  };
  return { provider, asked };
}

async function setup(
  providers: readonly FactProvider[],
  db?: Awaited<ReturnType<typeof database>>,
) {
  const store = db ?? (await database());
  let now = 1_000_000;
  const facts = createFacts({
    openRepository: async () => createFactRepository(store),
    providers: { lyrics: providers },
    now: () => now,
  });
  return {
    facts,
    db: store,
    read: () => readingOf(facts.store.get(), device.key, 'lyrics'),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('song facts', () => {
  it('asks providers in order: the first found wins, with its source', async () => {
    const tags = scripted('file-tags', { status: 'none' });
    const lrclib = scripted('lrclib', {
      status: 'found',
      value: 'the album cut',
    });
    const after = scripted('later', { status: 'found', value: 'never asked' });
    const { facts, read } = await setup([
      tags.provider,
      lrclib.provider,
      after.provider,
    ]);

    await facts.ensure(device, 'lyrics');

    expect(read()).toMatchObject({
      status: 'found',
      value: 'the album cut',
      source: 'lrclib',
      retryAtMs: null,
    });
    expect(after.asked).toEqual([]);
  });

  it('remembers a final answer on the phone, and never asks again', async () => {
    const first = scripted('file-tags', { status: 'none' });
    const { facts, db } = await setup([first.provider]);
    await facts.ensure(device, 'lyrics');

    const again = scripted('file-tags', { status: 'found', value: 'late' });
    const next = await setup([again.provider], db);
    await next.facts.ensure(device, 'lyrics');
    await next.facts.retry(device, 'lyrics');

    expect(next.read()).toMatchObject({ status: 'none', source: null });
    expect(again.asked).toEqual([]);
  });

  it('is unreachable, not none, when nothing was found and a service could not be asked', async () => {
    const lrclib = scripted('lrclib', { status: 'unreachable' });
    const tags = scripted('file-tags', { status: 'none' });
    const { facts, read } = await setup([tags.provider, lrclib.provider]);

    await facts.ensure(device, 'lyrics');

    expect(read()).toMatchObject({
      status: 'unreachable',
      source: 'lrclib',
      retryAtMs: 1_000_000 + FACT_KNOBS.BACKOFF_MS[0],
    });
  });

  it("keeps why: the last provider's none, the first unreachable's reason", async () => {
    const none = await setup([
      scripted('file-tags', { status: 'none' }).provider,
      scripted('lrclib', { status: 'none', reason: 'instrumental' }).provider,
    ]);
    await none.facts.ensure(device, 'lyrics');
    expect(none.read()).toMatchObject({
      status: 'none',
      reason: 'instrumental',
    });

    const busy = await setup([
      scripted('lrclib', { status: 'unreachable', reason: 'busy' }).provider,
    ]);
    await busy.facts.ensure(device, 'lyrics');
    expect(busy.read()).toMatchObject({
      status: 'unreachable',
      source: 'lrclib',
      reason: 'busy',
    });
    // And the phone remembers it.
    const again = await setup([], busy.db);
    await again.facts.ensure(device, 'lyrics');
    expect(again.read()).toMatchObject({ reason: 'busy' });
  });

  it('rests an unreachable fact, backing off, and honours Retry-After', async () => {
    const lrclib = scripted(
      'lrclib',
      { status: 'unreachable' },
      { status: 'unreachable' },
      { status: 'unreachable', retryAfterMs: 5_000 },
      { status: 'found', value: 'at last' },
    );
    const { facts, read, advance } = await setup([lrclib.provider]);
    await facts.ensure(device, 'lyrics');
    // Resting: an opening before the retry time asks nothing.
    await facts.ensure(device, 'lyrics');
    expect(lrclib.asked).toHaveLength(1);

    advance(FACT_KNOBS.BACKOFF_MS[0]);
    await facts.ensure(device, 'lyrics');
    expect(lrclib.asked).toHaveLength(2);
    expect(read()).toMatchObject({ status: 'unreachable' });
    const second = read() as { checkedAtMs: number; retryAtMs: number };
    expect(second.retryAtMs - second.checkedAtMs).toBe(
      FACT_KNOBS.BACKOFF_MS[1],
    );

    // TRY AGAIN asks at once, rest or not.
    await facts.retry(device, 'lyrics');
    const third = read() as { checkedAtMs: number; retryAtMs: number };
    expect(third.retryAtMs - third.checkedAtMs).toBe(5_000);

    await facts.retry(device, 'lyrics');
    expect(read()).toMatchObject({ status: 'found', value: 'at last' });
  });

  it('shows the lookup while it runs, with what was known before', async () => {
    let answer!: (lookup: Lookup) => void;
    const slow: FactProvider = {
      source: 'lrclib',
      lookup: () => new Promise(resolve => (answer = resolve)),
    };
    const { facts, read } = await setup([slow]);
    const running = facts.ensure(device, 'lyrics');
    // Twice while running is one lookup.
    const twice = facts.ensure(device, 'lyrics');
    await new Promise<void>(resolve => setImmediate(() => resolve()));

    expect(read()).toEqual({ status: 'looking', previous: null });
    answer({ status: 'found', value: 'words' });
    await Promise.all([running, twice]);
    expect(read()).toMatchObject({ status: 'found', value: 'words' });
  });

  it('runs one lookup at a time per provider', async () => {
    let inFlight = 0;
    let most = 0;
    const counted: FactProvider = {
      source: 'lrclib',
      lookup: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise<void>(resolve => setImmediate(() => resolve()));
        inFlight -= 1;
        return { status: 'none' };
      },
    };
    const { facts } = await setup([counted]);
    await Promise.all(
      ['a', 'b', 'c'].map(id =>
        facts.ensure({ ...device, key: `device:${id}` }, 'lyrics'),
      ),
    );
    expect(most).toBe(1);
  });

  it('still looks words up when the phone database cannot be opened', async () => {
    const errors: unknown[] = [];
    const facts = createFacts({
      openRepository: () => Promise.reject(new Error('no database')),
      providers: {
        lyrics: [
          scripted('file-tags', { status: 'found', value: 'w' }).provider,
        ],
      },
      now: () => 0,
      onError: error => errors.push(error),
    });
    await facts.ensure(device, 'lyrics');
    expect(readingOf(facts.store.get(), device.key, 'lyrics')).toMatchObject({
      status: 'found',
    });
    expect(errors).toHaveLength(1);
  });
});

describe('lyrics providers', () => {
  const detail = (
    generation: Partial<SongDetail['generation']>,
    written?: string,
  ) =>
    ({
      generation: { caption: 'c', ...generation },
      ...(written === undefined ? {} : { written_lyrics: written }),
    } as unknown as SongDetail);
  const made = (song: () => Promise<SongDetail>): NodeSubject => ({
    kind: 'node',
    key: 'node:song',
    detail: song,
    instrumentalLyrics: '[Instrumental]',
  });

  function providers(
    overrides: { tags?: string | null; fetch?: jest.Mock } = {},
  ) {
    const fetchFn = overrides.fetch ?? jest.fn();
    return {
      fetchFn,
      list: lyricsProviders({
        readTags: () => Promise.resolve(overrides.tags ?? null),
        fetch: fetchFn as never,
      }),
    };
  }

  async function lookUp(
    subject: DeviceSubject | NodeSubject,
    list: readonly FactProvider[],
  ) {
    const facts = createFacts({
      openRepository: () => Promise.reject(new Error('none here')),
      providers: { lyrics: list },
      now: () => 0,
    });
    await facts.ensure(subject, 'lyrics');
    return readingOf(facts.store.get(), subject.key, 'lyrics');
  }

  it('reads a made song from its recipe, and asks no service', async () => {
    const { list, fetchFn } = providers();
    expect(
      await lookUp(
        made(() => Promise.resolve(detail({ lyrics: 'given words' }))),
        list,
      ),
    ).toMatchObject({
      status: 'found',
      value: 'given words',
      source: 'recipe',
    });
    expect(
      await lookUp(
        made(() => Promise.resolve(detail({ lyrics: '[Instrumental]' }))),
        list,
      ),
    ).toMatchObject({ status: 'none' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says a made song whose node cannot be reached is unreachable, not wordless', async () => {
    const { list } = providers();
    expect(
      await lookUp(
        made(() => Promise.reject(new Error('offline'))),
        list,
      ),
    ).toMatchObject({ status: 'unreachable', source: 'recipe' });
  });

  it('reads an imported song from its tags before LRCLIB', async () => {
    const { list, fetchFn } = providers({ tags: 'tagged words' });
    expect(await lookUp(device, list)).toMatchObject({
      status: 'found',
      value: 'tagged words',
      source: 'file-tags',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
