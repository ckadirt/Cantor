import { sha256 } from '@noble/hashes/sha2.js';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { JobView } from '../../core/protocol';
import type { SongHeader } from '../../../../protocol/SongHeader';
import type { LocalAudioStore } from '../../audio/localAudioStore';
import {
  waitingKey,
  type WaitingDownload,
  type WaitingQueue,
} from '../../audio/waiting';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { NodeRequestError } from '../../backends/connection';
import { deriveWork, derivedJobId } from '../../work';
import type { AppIdentity } from '../../identity/derive';
import type { OutboxEntry } from '../../jobs/outbox';
import {
  BackendRuntime,
  type BackendRuntimeConnection,
  type BackendRuntimeConnectionCallbacks,
} from '../backendRuntime';

const identity: AppIdentity = {
  publicKey: '11111111111111111111111111111111',
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
  const pin = jest.fn().mockResolvedValue(undefined);
  const audioStore: LocalAudioStore = {
    inspect,
    localPath: jest.fn(),
    createSink: () => ({
      offset: async () => 0,
      append: async () => 10,
      finalize: async () => undefined,
    }),
    pin,
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
    uploadPort: jest.fn(),
  };
  const mergeJobs = jest.fn(async (_node: string, jobs: JobView[]) => jobs);
  const commitLibrary = jest.fn().mockResolvedValue(undefined);
  let entries: OutboxEntry[] = [];
  const loadOutbox = jest.fn(async () => entries);
  const putPending = jest.fn(async (nodePublicKey: string, model: string, generation: OutboxEntry['generation'], source?: OutboxEntry['source']) => {
    const entry: OutboxEntry = { clientRequestId: 'request-a', nodePublicKey, model, generation, requestHash: 'hash', state: 'pending', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', ...(source ? { source } : {}) };
    entries = [...entries, entry];
    return entry;
  });
  const markAccepted = jest.fn(async (id: string, canonicalJobId: string) => {
    entries = entries.map(entry => entry.clientRequestId === id ? { ...entry, state: 'accepted', canonicalJobId } : entry);
  });
  const markRejected = jest.fn(async (id: string, lastError: string) => {
    entries = entries.map(entry => entry.clientRequestId === id ? { ...entry, state: 'rejected', lastError } : entry);
  });
  const markSourceSent = jest.fn(async (id: string, uploadId: string) => ({
    clientRequestId: id,
    nodePublicKey: 'node-a',
    model: 'light',
    generation: {
      caption: 'A',
      audio: { source: { kind: 'upload' as const, upload_id: uploadId }, act: 'cover' as const },
    },
    requestHash: 'hash-2',
    state: 'pending' as const,
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
  }));
  const readSourceSlice = jest.fn(async (_path: string, offset: number, length: number) =>
    'x'.repeat(Math.min(length, 10 - offset)),
  );
  // The waiting queue, in memory: the real one is AsyncStorage.
  let queue: WaitingQueue = {};
  const putWaiting = jest.fn(async (entry: WaitingDownload) => {
    queue = { ...queue, [waitingKey(entry)]: entry };
    return queue;
  });
  const dropWaiting = jest.fn(async (key: string) => {
    const next = { ...queue };
    delete next[key];
    queue = next;
    return queue;
  });
  const runtime = new BackendRuntime(identity, {
    loadWaiting: jest.fn(async () => queue),
    putWaiting,
    dropWaiting,
    dropWaitingFor: jest.fn(async () => queue),
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
    putPending,
    markAccepted,
    markRejected,
    markSourceSent,
    readSourceSlice,
    audioStore,
  });
  return {
    runtime,
    callbacks,
    inspect,
    pin,
    putWaiting,
    dropWaiting,
    connection,
    mergeJobs,
    commitLibrary,
    loadOutbox,
    markSourceSent,
    readSourceSlice,
    putPending,
    markAccepted,
    markRejected,
  };
}

function snapshot(songs: SongHeader[], jobs: JobView[]): ConnectionSnapshot {
  return {
    // Ready: a download is only attempted on a ready node; one that is not
    // waits for it (`audio/waiting.ts`).
    phase: 'ready',
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
   * `GET` is one act. Published as download-then-pin, the song read "cached"
   * for a beat between its arc (or its filling-in seal) and its filled mark.
   */
  it('keeps a song without ever publishing it as merely cached', async () => {
    const f = setup();
    f.runtime.start();
    await flush();
    const target = song('song-a', 'a');
    f.callbacks[0].onSnapshot(snapshot([target], []));
    await flush();
    f.inspect.mockReset();
    f.inspect.mockResolvedValueOnce({ state: 'remote', bytes: 0 });
    f.inspect.mockResolvedValue({ state: 'pinned', bytes: 10 });
    const seen: string[] = [];
    f.runtime.store.subscribe(() => {
      const audio = Object.values(f.runtime.store.get().localAudio);
      for (const entry of audio) seen.push(entry.state);
    });

    await f.runtime.commands.audio('node-a', target, artifact('a'), 'keep');
    await flush();

    expect(seen).toContain('partial');
    expect(seen).not.toContain('cached');
    expect(seen[seen.length - 1]).toBe('pinned');
    expect(f.pin).toHaveBeenCalledTimes(1);
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

  describe('a submission that starts from a local file', () => {
    it('sends the file, says how far it got, then submits a request naming the upload', async () => {
      const f = setup();
      const pending: OutboxEntry = {
        clientRequestId: 'request-tune',
        nodePublicKey: 'node-a',
        model: 'light',
        generation: {
          caption: 'A',
          audio: { source: { kind: 'upload', upload_id: 'local' }, act: 'cover', tune: true },
        },
        requestHash: 'hash',
        state: 'pending',
        createdAt: '2026-10-14T00:00:00Z',
        updatedAt: '2026-10-14T00:00:00Z',
        source: { path: '/takes/tune.wav', mediaType: 'audio/wav', sha256: 'a'.repeat(64), bytes: 10 },
      };
      f.loadOutbox.mockResolvedValue([pending]);
      const seen: Array<Record<string, { sent: number; total: number }>> = [];
      f.runtime.store.subscribe(() => seen.push(f.runtime.store.get().sending));
      let received = 0;
      (f.connection.uploadPort as jest.Mock).mockReturnValue({
        open: async () => ({ uploadId: 'up-1', acceptedOffset: received, chunkBytes: 4 }),
        chunk: async (_id: string, offset: number, data: string) => {
          received = offset + data.length;
          return received;
        },
        commit: async () => ({ uploadId: 'up-1', sha256: 'a'.repeat(64), bytes: 10, seconds: 9.5 }),
      });
      (f.connection.createJob as jest.Mock).mockResolvedValue(job(1));
      f.runtime.start();
      await flush();
      f.callbacks[0].onSnapshot(snapshot([], [job(1)]));
      await flush();
      await flush();

      expect(f.readSourceSlice).toHaveBeenCalledWith('/takes/tune.wav', 0, 4);
      expect(f.markSourceSent).toHaveBeenCalledWith('request-tune', 'up-1');
      const sent = (f.connection.createJob as jest.Mock).mock.calls[0][2];
      expect(sent.audio.source).toEqual({ kind: 'upload', upload_id: 'up-1' });
      expect(seen.some(sending => sending['request-tune']?.sent === 8)).toBe(true);
      expect(f.runtime.store.get().sending).toEqual({});
    });
  });

  /*
   * A GET on a node that is away promises instead of failing, a transfer cut
   * off half way waits with its bytes, and both run when the node is back.
   */
  describe('downloads that wait for their node', () => {
    it('promises a GET on a node that is away, and keeps it when the node is back', async () => {
      const f = setup();
      f.runtime.start();
      await flush();
      const target = song('song-a', 'a');
      f.callbacks[0].onSnapshot({
        ...snapshot([target], []),
        phase: 'attached',
      });
      await flush();
      await f.runtime.commands.audio('node-a', target, artifact('a'), 'keep');
      await flush();
      expect(f.connection.downloadArtifact).not.toHaveBeenCalled();
      const key = waitingKey({
        nodePublicKey: 'node-a',
        songId: 'song-a',
        digest: artifact('a').sha256,
      });
      expect(f.runtime.store.get().waiting[key]).toMatchObject({
        state: 'waiting',
        action: 'keep',
      });

      f.callbacks[0].onSnapshot(snapshot([target], []));
      await flush();
      await flush();
      expect(f.connection.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(f.runtime.store.get().waiting[key]).toBeUndefined();
    });

    it('waits with its bytes when the connection cuts a transfer, and stops for a changed file', async () => {
      const f = setup();
      f.runtime.start();
      await flush();
      const target = song('song-a', 'a');
      f.callbacks[0].onSnapshot(snapshot([target], []));
      await flush();
      const key = waitingKey({
        nodePublicKey: 'node-a',
        songId: 'song-a',
        digest: artifact('a').sha256,
      });
      (f.connection.downloadArtifact as jest.Mock).mockRejectedValueOnce(
        new Error('The connection to the node stopped.'),
      );
      await expect(
        f.runtime.commands.audio('node-a', target, artifact('a'), 'keep'),
      ).resolves.toBeUndefined();
      expect(f.runtime.store.get().waiting[key]?.state).toBe('waiting');

      (f.connection.downloadArtifact as jest.Mock).mockRejectedValueOnce(
        Object.assign(new Error('raw'), {
          code: 'artifact_changed',
          retryable: false,
        }),
      );
      await expect(
        f.runtime.commands.audio('node-a', target, artifact('a'), 'keep'),
      ).rejects.toThrow('raw');
      expect(f.runtime.store.get().waiting[key]?.state).toBe('changed');

      f.runtime.commands.cancelWaiting(
        'node-a',
        'song-a',
        artifact('a').sha256,
      );
      await flush();
      expect(f.runtime.store.get().waiting[key]).toBeUndefined();
    });
  });
});


describe('saving work before a node answers', () => {
  it('returns the work key while away, and the field has it before acceptance', async () => {
    const f = setup();
    f.runtime.start();
    await flush();
    await expect(f.runtime.commands.submit('node-a', 'light', { caption: 'Rain' })).resolves.toBe('node-a:pending:request-a');
    expect(f.connection.createJob).not.toHaveBeenCalled();
    const state = f.runtime.store.get();
    const work = deriveWork({ ...state, backends: state.backends!, outbox: Object.values(state.outbox) });
    expect(work.get('node-a:pending:request-a')).toMatchObject({ caption: 'Rain', phase: { kind: 'waiting' }, job: null });
    expect(state.principal).toEqual(sha256(new Uint8Array(32)));
    f.runtime.dispose();
  });

  it('returns a derived key and counts the source while its upload is still open', async () => {
    const f = setup();
    f.runtime.start();
    await flush();
    const nodeInfo = require('../../../../protocol/fixtures/v2/node-info.json').node;
    f.callbacks[0].onNodeInfo({ ...nodeInfo, features: { ...nodeInfo.features, derived_job_ids: true } });
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    let finish!: (value: { uploadId: string; acceptedOffset: number; chunkBytes: number }) => void;
    (f.connection.uploadPort as jest.Mock).mockReturnValue({
      open: () => new Promise(resolve => { finish = resolve; }),
      commit: async () => ({ uploadId: 'up', sha256: 'a'.repeat(64), bytes: 10, seconds: 1 }),
    });
    (f.connection.createJob as jest.Mock).mockResolvedValue(job(1));
    const source = { path: '/source.wav', mediaType: 'audio/wav', sha256: 'a'.repeat(64), bytes: 10 };
    const key = await f.runtime.commands.submit('node-a', 'light', { caption: 'Rain', audio: { source: { kind: 'upload', upload_id: 'local' }, act: 'cover' } }, source);
    expect(key).toBe(`node-a:${derivedJobId(f.runtime.store.get().principal, 'request-a')}`);
    expect(f.runtime.store.get().sending['request-a']).toEqual({ sent: 0, total: 10 });
    expect(f.connection.createJob).not.toHaveBeenCalled();
    // A ready snapshot during the upload cannot start a second send.
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    expect(f.connection.uploadPort).toHaveBeenCalledTimes(1);
    finish({ uploadId: 'up', acceptedOffset: 10, chunkBytes: 4 });
    await flush();
    await flush();
    expect(f.connection.createJob).toHaveBeenCalledTimes(1);
    f.runtime.dispose();
  });

  it.each([new Error('Request timed out'), new NodeRequestError('Busy', 'temporarily_unavailable', true)])('keeps a lost or retryable answer pending and retries with the same request id: %s', async error => {
    const f = setup();
    (f.connection.createJob as jest.Mock).mockRejectedValueOnce(error).mockResolvedValue(job(1));
    f.runtime.start();
    await flush();
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    await f.runtime.commands.submit('node-a', 'light', { caption: 'Rain' });
    await flush();
    expect(f.runtime.store.get().outbox['request-a'].state).toBe('pending');
    expect(f.runtime.store.get().submissionFailure).toBeNull();
    expect(f.markRejected).not.toHaveBeenCalled();
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    await flush();
    expect(f.connection.createJob).toHaveBeenCalledTimes(2);
    expect((f.connection.createJob as jest.Mock).mock.calls.map(args => args[0])).toEqual(['request-a', 'request-a']);
    expect(f.runtime.store.get().outbox['request-a'].state).toBe('accepted');
    f.runtime.dispose();
  });

  it('rejects only a non-retryable node refusal and publishes it for failureWords', async () => {
    const f = setup();
    const error = new NodeRequestError('No model', 'model_not_installed', false);
    (f.connection.createJob as jest.Mock).mockRejectedValue(error);
    f.runtime.start();
    await flush();
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    await expect(f.runtime.commands.submit('node-a', 'light', { caption: 'Rain' })).resolves.toBe('node-a:pending:request-a');
    await flush();
    expect(f.markRejected).toHaveBeenCalledWith('request-a', 'No model');
    expect(f.runtime.store.get().outbox['request-a'].state).toBe('rejected');
    expect(f.runtime.store.get().submissionFailure).toEqual({ nodePublicKey: 'node-a', workKey: 'node-a:pending:request-a', error });
    f.callbacks[0].onSnapshot(snapshot([], []));
    await flush();
    expect(f.connection.createJob).toHaveBeenCalledTimes(1);
    f.runtime.dispose();
  });

  it('throws when the submission cannot be saved', async () => {
    const f = setup();
    f.putPending.mockRejectedValueOnce(new Error('Disk full'));
    await expect(f.runtime.commands.submit('node-a', 'light', { caption: 'Rain' })).rejects.toThrow('Disk full');
    expect(f.connection.createJob).not.toHaveBeenCalled();
  });
});
