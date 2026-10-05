import { AudioApiPlayer } from '../audioApiPlayer';
import type { AudioRef } from '../../audio/localAudioStore';

const TRACK: AudioRef = { nodeKey: 'node', songId: 'song', digest: 'a'.repeat(64) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

it('Stop cancels duration inspection and ignores late native events', async () => {
  const duration = deferred<number>();
  const player = new AudioApiPlayer({ getDuration: () => duration.promise });
  const load = player.load(TRACK, '/music/song.opus');
  await player.stop();
  duration.resolve(120);
  await load;
  player.binding.onLoad();
  player.binding.onEnded();
  player.binding.onPositionChange(30);
  player.binding.onError(new Error('late decoder error'));
  await player.play();
  expect(player.snapshot()).toMatchObject({ state: 'empty', track: null, positionSeconds: 0, error: null });
  expect(player.binding.source).toBeNull();
});

it('Stop settles an element load without waiting for an onLoad that will never arrive', async () => {
  const player = new AudioApiPlayer({ getDuration: async () => 120 });
  const load = player.load(TRACK, '/music/song.opus');
  await Promise.resolve();
  expect(player.binding.source).toBe('file:///music/song.opus');
  await player.stop();
  await load;
  expect(player.snapshot().state).toBe('empty');
});

it('a download from before Stop stays cancelled even if the user starts a new session', async () => {
  const download = deferred<string>();
  const player = new AudioApiPlayer({ getDuration: async () => 120 });
  const oldPath = player.resolvePath(() => download.promise).catch(error => error);
  await player.stop();
  player.beginSession();
  download.resolve('/music/old.opus');
  expect(await oldPath).toEqual(new Error('Playback was stopped or replaced.'));
  await expect(player.resolvePath(async () => '/music/new.opus')).resolves.toBe('/music/new.opus');
  const load = player.load(TRACK, '/music/new.opus');
  await Promise.resolve();
  player.binding.onLoad();
  await load;
  await player.play();
  expect(player.snapshot().state).toBe('playing');
});

it('Stop hides only after in-flight notification work and then releases the retained session', async () => {
  const showing = deferred<void>();
  const started = deferred<void>();
  const events: string[] = [];
  const player = new AudioApiPlayer({
    getDuration: async () => 120,
    showNowPlaying: async () => {
      events.push('show');
      started.resolve();
      await showing.promise;
    },
    hideNowPlaying: async () => { events.push('hide'); },
    setSessionActive: async active => { events.push(active ? 'retain' : 'release'); },
  });
  const load = player.load(TRACK, '/music/song.opus');
  await Promise.resolve();
  player.binding.onLoad();
  await load;
  player.setNowPlaying({ title: 'Song', artist: 'Artist' });
  await started.promise;
  const stop = player.stop();
  showing.resolve();
  await stop;
  expect(events.slice(-2)).toEqual(['hide', 'release']);
  expect(events.lastIndexOf('show')).toBeLessThan(events.lastIndexOf('hide'));
  expect(player.snapshot().state).toBe('empty');
});
