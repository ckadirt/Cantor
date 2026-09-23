import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  byTime,
  layoutField,
  orderByKey,
  type FieldEntity,
  type FieldLayout,
  type QueueStep,
} from '../../../field';
import {
  FakePlayer,
  usePlayer,
  type AfterSong,
  type PlayerController,
} from '../../../player';
import type { FieldPresentation } from '../useFieldController';
import { useShelfQueue, type ShelfQueueController } from '../useShelfQueue';

const viewport = { width: 412, height: 892 };
const day = 24 * 60 * 60 * 1000;
const monday = Date.parse('2026-08-24T12:00:00Z');

function entity(id: string, index: number): FieldEntity {
  return {
    key: `node-a:${id}`,
    nodePublicKey: 'node-a',
    entityId: id,
    kind: 'song',
    createdAtMs: monday + index * day,
    durationMs: 60_000,
    tags: [],
  };
}

const ENTITIES = ['a', 'b', 'c', 'd'].map(entity);
const LAYOUT: FieldLayout = layoutField({
  entities: ENTITIES,
  arrangement: byTime,
  viewport,
  order: orderByKey('date'),
});
/** The seating the screen draws, which is the order the queue must follow. */
const ORDER = LAYOUT.groups[0].entityKeys;

function presentation(
  item: FieldEntity,
  options: { silent?: boolean; state?: 'cached' | 'remote' } = {},
): FieldPresentation {
  return {
    entity: item,
    song: { id: item.entityId, title: `Song ${item.entityId}` },
    nodeLabels: ['node'],
    delivery: options.silent ? undefined : { sha256: item.entityId.repeat(64) },
    localAudio: { state: options.state ?? 'cached' },
  } as unknown as FieldPresentation;
}

function presentationsWith(
  overrides: Record<string, Parameters<typeof presentation>[1]> = {},
): ReadonlyMap<string, FieldPresentation> {
  return new Map(
    ENTITIES.map(item => [item.key, presentation(item, overrides[item.key])]),
  );
}

const pathOf = (p: FieldPresentation) => `/audio/${p.entity.entityId}.opus`;
const placementOf = (entityKey: string) => {
  const found = LAYOUT.placements.find(p => p.entityKey === entityKey);
  if (found === undefined) throw new Error(`no mark for ${entityKey}`);
  return found;
};

type Setup = {
  afterSong?: AfterSong;
  presentations?: ReadonlyMap<string, FieldPresentation>;
  fetchPath?: (p: FieldPresentation) => Promise<string>;
};

function mount(player: FakePlayer, setup: Setup = {}) {
  const moves: [string, QueueStep][] = [];
  const errors: (string | null)[] = [];
  const prefetched: string[] = [];
  let transport!: PlayerController;
  let queue!: ShelfQueueController;
  function Probe({ afterSong }: { afterSong: AfterSong }) {
    transport = usePlayer(player);
    queue = useShelfQueue({
      player,
      transport,
      afterSong,
      layout: LAYOUT,
      presentations: setup.presentations ?? presentationsWith(),
      fetchPath: setup.fetchPath ?? (async p => pathOf(p)),
      prefetch: async p => {
        prefetched.push(p.entity.key);
      },
      onMove: (from, to) => moves.push([from, to]),
      onError: message => errors.push(message),
    });
    return null;
  }
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <Probe afterSong={setup.afterSong ?? 'continue'} />,
    );
  });
  return {
    moves,
    errors,
    prefetched,
    get transport() {
      return transport;
    },
    get queue() {
      return queue;
    },
    setAfterSong(mode: AfterSong) {
      ReactTestRenderer.act(() => {
        renderer.update(<Probe afterSong={mode} />);
      });
    },
  };
}

const playing = (player: FakePlayer) => player.snapshot().track?.songId;
const idOf = (entityKey: string) => entityKey.split(':')[1];

async function start(probe: ReturnType<typeof mount>, entityKey: string) {
  await ReactTestRenderer.act(async () => {
    await probe.queue.start(
      presentationsWith().get(entityKey)!,
      placementOf(entityKey),
    );
  });
}

/** Run the current song off its end and let the advance settle. */
async function runOut(player: FakePlayer) {
  await ReactTestRenderer.act(async () => {
    await player.advance(61_000);
  });
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
  });
}

describe('useShelfQueue', () => {
  it('plays on down the shelf when a song ends', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[0]);
    expect(playing(player)).toBe(idOf(ORDER[0]));

    await runOut(player);

    expect(playing(player)).toBe(idOf(ORDER[1]));
    expect(player.snapshot().state).toBe('playing');
    expect(probe.moves.map(([from, to]) => [from, to.entityKey])).toEqual([
      [ORDER[0], ORDER[1]],
    ]);
  });

  it('stops at the end of the shelf', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[ORDER.length - 1]);

    await runOut(player);

    expect(player.snapshot().state).toBe('ended');
    expect(playing(player)).toBe(idOf(ORDER[ORDER.length - 1]));
  });

  it('holds at ended when the mode is stop', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, { afterSong: 'stop' });
    await start(probe, ORDER[0]);

    await runOut(player);

    expect(player.snapshot().state).toBe('ended');
    expect(playing(player)).toBe(idOf(ORDER[0]));
  });

  it('plays the same song again when the mode is repeat', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, { afterSong: 'repeat' });
    await start(probe, ORDER[0]);

    await runOut(player);

    expect(player.snapshot().state).toBe('playing');
    expect(playing(player)).toBe(idOf(ORDER[0]));
    expect(player.snapshot().positionSeconds).toBeLessThan(1);
  });

  it('reads the mode at the moment the song ends', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, { afterSong: 'continue' });
    await start(probe, ORDER[0]);
    probe.setAfterSong('stop');

    await runOut(player);

    expect(player.snapshot().state).toBe('ended');
  });

  it('steps over songs that have no audio', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, {
      presentations: presentationsWith({ [ORDER[1]]: { silent: true } }),
    });
    await start(probe, ORDER[0]);

    await runOut(player);

    expect(playing(player)).toBe(idOf(ORDER[2]));
  });

  it('steps over a song that refuses to arrive, and says nothing once one plays', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, {
      fetchPath: async p => {
        if (p.entity.key === ORDER[1]) throw new Error('Song node is not connected.');
        return pathOf(p);
      },
    });
    await start(probe, ORDER[0]);

    await runOut(player);

    expect(playing(player)).toBe(idOf(ORDER[2]));
    expect(probe.errors[probe.errors.length - 1]).toBeNull();
  });

  it('never lands a slow advance on top of a song chosen meanwhile', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    let release!: () => void;
    const slow = new Promise<void>(resolve => {
      release = resolve;
    });
    const probe = mount(player, {
      fetchPath: async p => {
        if (p.entity.key === ORDER[1]) await slow;
        return pathOf(p);
      },
    });
    await start(probe, ORDER[0]);
    await runOut(player);
    // The advance is waiting on ORDER[1]; the person taps ORDER[3].
    await start(probe, ORDER[3]);

    await ReactTestRenderer.act(async () => {
      release();
      await slow;
    });

    expect(playing(player)).toBe(idOf(ORDER[3]));
  });

  it('steps next from the lock screen regardless of the mode', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, { afterSong: 'repeat' });
    await start(probe, ORDER[1]);

    await ReactTestRenderer.act(async () => {
      await probe.queue.skip(1);
    });

    expect(playing(player)).toBe(idOf(ORDER[2]));
  });

  it('steps back to the song before when pressed at the top of a song', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[2]);
    await ReactTestRenderer.act(async () => {
      await player.advance(1_000);
    });

    await ReactTestRenderer.act(async () => {
      await probe.queue.skip(-1);
    });

    expect(playing(player)).toBe(idOf(ORDER[1]));
  });

  it('steps back to the top of the song when pressed well into it', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[2]);
    await ReactTestRenderer.act(async () => {
      await player.advance(30_000);
    });

    await ReactTestRenderer.act(async () => {
      await probe.queue.skip(-1);
    });

    expect(playing(player)).toBe(idOf(ORDER[2]));
    expect(player.snapshot().positionSeconds).toBe(0);
  });

  it('back from the first song on the shelf is the top of that song', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[0]);

    await ReactTestRenderer.act(async () => {
      await probe.queue.skip(-1);
    });

    expect(playing(player)).toBe(idOf(ORDER[0]));
    expect(player.snapshot().positionSeconds).toBe(0);
  });

  it('a step pressed on another song makes that song’s shelf the queue', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player);
    await start(probe, ORDER[0]);

    await ReactTestRenderer.act(async () => {
      await probe.queue.skip(1, placementOf(ORDER[2]));
    });

    expect(playing(player)).toBe(idOf(ORDER[3]));
  });

  it('fetches the next song ahead while one plays on continue', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, {
      presentations: presentationsWith({ [ORDER[1]]: { state: 'remote' } }),
    });

    await start(probe, ORDER[0]);

    expect(probe.prefetched).toEqual([ORDER[1]]);
  });

  it('fetches nothing ahead when the song will not be followed', async () => {
    const player = new FakePlayer({ durationOf: () => 60 });
    const probe = mount(player, {
      afterSong: 'stop',
      presentations: presentationsWith({ [ORDER[1]]: { state: 'remote' } }),
    });

    await start(probe, ORDER[0]);

    expect(probe.prefetched).toEqual([]);
  });
});
