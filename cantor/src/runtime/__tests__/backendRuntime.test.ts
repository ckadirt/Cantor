import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { JobView } from '../../../../protocol/JobView';
import type { SongHeader } from '../../../../protocol/SongHeader';
import type { LocalAudioStore } from '../../audio/localAudioStore';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import type { AppIdentity } from '../../identity/derive';
import type { OutboxEntry } from '../../jobs/outbox';
import {
  BackendRuntime,
  type BackendRuntimeConnection,
  type BackendRuntimeConnectionCallbacks,
} from '../backendRuntime';

const identity: AppIdentity = {
  publicKey: 'app-key',
  secretKey: new Uint8Array(32),
};

const backend: BackendRecord = {
  nodePubkey: 'node-a',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: null,
};

function artifact(digest: string): ArtifactView {
  return {
    kind: 'delivery',
    profile: 'opus-stereo-160k-v1',
    media_type: 'audio/ogg; codecs=opus',
    byte_length: 10,
    sha256: digest.repeat(64),
    sample_rate: 48_000,
    channels: 2,
  };
}

function song(id: string, digest: string): SongHeader {
  return {
    id,
    revision: 1,
    title: id,
    caption_summary: '',
    created_at: '2026-08-08T00:00:00Z',
    duration_ms: 1_000,
    model: 'light',
    favorite: false,
    tags: [],
    trashed: false,
    artifacts: [artifact(digest)],
  };
}

function job(revision: number, state: JobView['state'] = 'running'): JobView {
  return {
    id: 'job-a',
    revision,
    state,
    model: 'light',
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:01:00Z',
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function setup() {
  const callbacks: BackendRuntimeConnectionCallbacks[] = [];
  const inspect = jest.fn().mockResolvedValue({ state: 'remote', bytes: 0 });
  const audioStore: LocalAudioStore = {
    inspect,
    localPath: jest.fn(),
    createSink: () => ({
      offset: async () => 0,
      append: async () => 10,
      finalize: async () => undefined,
    }),
    pin: jest.fn(),
    unpin: jest.fn().mockResolvedValue({ state: 'cached', bytes: 10 }),
    remove: jest.fn(),
  };
  const connection: BackendRuntimeConnection = {
    start: jest.fn(),
    stop: jest.fn(),
    createJob: jest.fn(),
    controlJob: jest.fn(),
    forgetJob: jest.fn(),
    patchSong: jest.fn(),
    getSong: jest.fn(),
    downloadArtifact: jest.fn(async (_id, _artifact, _sink, progress) => {
      progress?.(10, 10);
    }),
    trashSong: jest.fn(),
    restoreSong: jest.fn(),
    refreshLibrary: jest.fn(),
  };
  const mergeJobs = jest.fn(async (_node: string, jobs: JobView[]) => jobs);
  const commitLibrary = jest.fn().mockResolvedValue(undefined);
  const loadOutbox = jest.fn().mockResolvedValue([] as OutboxEntry[]);
  const runtime = new BackendRuntime(identity, {
    createConnection: (_backend, _identity, _token, received) => {
      callbacks.push(received);
      return connection;
    },
    loadBackends: jest.fn().mockResolvedValue([backend]),
    saveBackends: jest.fn().mockResolvedValue(undefined),
    loadJobs: jest.fn().mockResolvedValue([]),
    mergeJobs,
    forgetJobs: jest.fn(),
    loadLibrary: jest.fn().mockResolvedValue({ revision: null, songs: [] }),
    loadLibraries: jest.fn().mockResolvedValue({}),
    commitLibrary,
    loadOutbox,
    forgetSubmission: jest.fn(),
    putPending: jest.fn(),
    markAccepted: jest.fn(),
    markRejected: jest.fn(),
    audioStore,
  });
  return {
    runtime,
    callbacks,
    inspect,
    connection,
    mergeJobs,
    commitLibrary,
    loadOutbox,
  };
}

function snapshot(songs: SongHeader[], jobs: JobView[]): ConnectionSnapshot {
  return {
    phase: 'connecting',
    error: null,
    songs,
    jobs,
    libraryRevision: 7,
    librarySyncing: true,
  };
}

describe('BackendRuntime', () => {
  it('leaves the songs and their audio alone when only a job moves', async () => {
    const { runtime, callbacks, inspect } = setup();
    runtime.start();
    await flush();
    const library = [song('song-a', 'a'), song('song-b', 'b')];

    callbacks[0].onSnapshot(snapshot(library, [job(1)]));
    await flush();
    expect(inspect).toHaveBeenCalledTimes(2);
    const songs = runtime.store.get().snapshots['node-a'].songs;
    const localAudio = runtime.store.get().localAudio;

    // A progress tick: the same song objects in a fresh array, a newer job.
    callbacks[0].onSnapshot(snapshot([...library], [job(2)]));
    await flush();

    const after = runtime.store.get();
    expect(after.snapshots['node-a'].songs).toBe(songs);
    expect(after.snapshots['node-a'].jobs[0].revision).toBe(2);
    expect(after.localAudio).toBe(localAudio);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('publishes nothing for a snapshot that changes nothing', async () => {
    const { runtime, callbacks } = setup();
    runtime.start();
    await flush();
    const library = [song('song-a', 'a')];
    callbacks[0].onSnapshot(snapshot(library, [job(1)]));
    await flush();

    const listener = jest.fn();
    runtime.store.subscribe(listener);
    callbacks[0].onSnapshot(snapshot([...library], [job(1)]));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('inspects a new song once, and every song again after an eviction', async () => {
    const { runtime, callbacks, inspect } = setup();
    runtime.start();
    await flush();
    const first = song('song-a', 'a');
    callbacks[0].onSnapshot(snapshot([first], []));
    await flush();
    expect(inspect).toHaveBeenCalledTimes(1);

    const second = song('song-b', 'b');
    callbacks[0].onSnapshot(snapshot([first, second], []));
    await flush();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenLastCalledWith(
      expect.objectContaining({ songId: 'song-b' }),
    );

    // Finishing a download runs the cache budget, which may take the others.
    inspect.mockClear();
    await runtime.commands.audio('node-a', second, artifact('b'), 'download');
    await flush();
    const asked = inspect.mock.calls.map(([ref]) => ref.songId).sort();
    expect(asked).toEqual(['song-a', 'song-b', 'song-b', 'song-b']);
  });

  it('stops its connections on dispose and drops work from before it', async () => {
    const { runtime, callbacks } = setup();
    runtime.start();
    runtime.dispose();
    await flush();
    expect(runtime.store.get().backends).toBeNull();
    expect(callbacks).toHaveLength(0);
  });

  /*
   * What a running job's progress is allowed to cost: nothing durable changes
   * between two progress updates, so nothing is written. Each update used to
   * rewrite the library cache and every job and re-read the outbox (rewrite
   * log, phase 4).
   */
  describe('writes only what changed', () => {
    function ready(
      jobs: JobView[],
      revision = 7,
      songs: SongHeader[] = [],
    ): ConnectionSnapshot {
      return {
        phase: 'ready',
        error: null,
        songs,
        jobs,
        libraryRevision: revision,
        librarySyncing: false,
      };
    }

    it('commits the library once per revision', async () => {
      const f = setup();
      f.runtime.start();
      await flush();
      f.callbacks[0].onSnapshot(ready([job(1)]));
      f.callbacks[0].onSnapshot(ready([job(2)]));
      f.callbacks[0].onSnapshot(ready([job(3)]));
      await flush();
      expect(f.commitLibrary).toHaveBeenCalledTimes(1);
      f.callbacks[0].onSnapshot(ready([job(3)], 8));
      await flush();
      expect(f.commitLibrary).toHaveBeenCalledTimes(2);
      expect(f.commitLibrary).toHaveBeenLastCalledWith('node-a', 8, []);
    });

    it('tries a library write again when it failed', async () => {
      const f = setup();
      f.commitLibrary.mockRejectedValueOnce(new Error('disk full'));
      f.runtime.start();
      await flush();
      f.callbacks[0].onSnapshot(ready([]));
      await flush();
      f.callbacks[0].onSnapshot(ready([]));
      await flush();
      expect(f.commitLibrary).toHaveBeenCalledTimes(2);
    });

    it('persists a job when it appears or its state moves, not its progress', async () => {
      const f = setup();
      f.runtime.start();
      await flush();
      f.callbacks[0].onSnapshot(ready([job(1)]));
      f.callbacks[0].onSnapshot(ready([job(2)]));
      f.callbacks[0].onSnapshot(ready([job(3)]));
      await flush();
      expect(f.mergeJobs).toHaveBeenCalledTimes(1);
      // The live view still has the latest progress.
      expect(f.runtime.store.get().snapshots['node-a'].jobs[0].revision).toBe(
        3,
      );
      f.callbacks[0].onSnapshot(ready([job(4, 'completed')]));
      await flush();
      expect(f.mergeJobs).toHaveBeenCalledTimes(2);
      expect(f.mergeJobs).toHaveBeenLastCalledWith('node-a', [
        job(4, 'completed'),
      ]);
    });

    it('reads the outbox when the node becomes ready, not on every snapshot', async () => {
      const f = setup();
      f.runtime.start();
      await flush();
      const before = f.loadOutbox.mock.calls.length;
      f.callbacks[0].onSnapshot(ready([job(1)]));
      f.callbacks[0].onSnapshot(ready([job(2)]));
      f.callbacks[0].onSnapshot(ready([job(3)]));
      await flush();
      expect(f.loadOutbox.mock.calls.length - before).toBe(1);
    });

    it('keeps retrying a pending submission until a read finds it sent', async () => {
      const f = setup();
      const pending: OutboxEntry = {
        clientRequestId: 'request-a',
        nodePublicKey: 'node-a',
        model: 'light',
        generation: { caption: 'A' },
        requestHash: 'hash',
        state: 'pending',
        createdAt: '2026-08-08T00:00:00Z',
        updatedAt: '2026-08-08T00:00:00Z',
      };
      f.loadOutbox.mockResolvedValue([pending]);
      (f.connection.createJob as jest.Mock).mockRejectedValue(
        new Error('socket hiccup'),
      );
      f.runtime.start();
      await flush();
      f.callbacks[0].onSnapshot(ready([job(1)]));
      await flush();
      f.callbacks[0].onSnapshot(ready([job(2)]));
      await flush();
      expect(f.connection.createJob).toHaveBeenCalledTimes(2);

      // Sent: the next read finds nothing pending, and the reads stop.
      f.loadOutbox.mockResolvedValue([{ ...pending, state: 'accepted' }]);
      f.callbacks[0].onSnapshot(ready([job(3)]));
      await flush();
      const reads = f.loadOutbox.mock.calls.length;
      f.callbacks[0].onSnapshot(ready([job(4)]));
      await flush();
      expect(f.loadOutbox.mock.calls.length).toBe(reads);
    });
  });
});
