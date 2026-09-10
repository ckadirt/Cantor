import React from 'react';
import { buildFieldController } from '../../features/field/useFieldController';
import { allPlaylists } from '../../playlists';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { JobView } from '../../../../protocol/JobView';
import type { SongDetail } from '../../../../protocol/SongDetail';
import type { SongHeader } from '../../../../protocol/SongHeader';
import type { AppIdentity } from '../../identity/derive';
import type { LocalAudioStore } from '../../audio/localAudioStore';
import type { OutboxEntry } from '../../jobs/outbox';
import type {
  BackendRecord,
  ConnectionSnapshot,
  NodeInfo,
} from '../../backends/types';
import {
  type BackendRuntime,
  type BackendRuntimeConnection,
  type BackendRuntimeConnectionCallbacks,
  type BackendRuntimeDependencies,
  useBackendRuntime,
} from '../useBackendRuntime';

const identity: AppIdentity = {
  publicKey: 'app-key',
  secretKey: new Uint8Array(32),
};

const nodeInfo: NodeInfo = {
  name: 'Studio node',
  device_type: 'desktop',
  engine_version: 'test',
  models: [{ selector: 'light', family: 'ace-step', engine: 'native' }],
  limits: {
    max_concurrent_jobs: 1,
    max_queued_jobs_per_principal: 4,
    min_song_seconds: 1,
    max_song_seconds: 240,
    max_caption_bytes: 1_024,
    max_lyrics_bytes: 8_192,
    max_page_limit: 100,
  },
  load: { active_jobs: 0, queued_jobs: 0, accepting_jobs: true },
  features: {
    jobs_create: true,
    library_list: true,
    artifacts_transfer: true,
    secure_tunnel: true,
    job_controls: true,
  },
};

const backend: BackendRecord = {
  nodePubkey: 'node-a',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: nodeInfo,
};

const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 10,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};

function song(revision = 1, trashed = false): SongHeader {
  return {
    id: 'song-a',
    revision,
    title: 'Song',
    caption_summary: 'Caption',
    created_at: '2026-08-08T00:00:00Z',
    duration_ms: 1_000,
    model: 'light',
    favorite: false,
    tags: [],
    trashed,
    artifacts: [artifact],
  };
}

function job(id: string, revision = 1): JobView {
  return {
    id,
    revision,
    state: 'completed',
    model: 'light',
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:01:00Z',
  };
}

const detail: SongDetail = {
  song: song(),
  generation: { caption: 'Caption' },
  engine: 'native',
  component_digests: [],
  attempts: 1,
};

type FakeConnection = BackendRuntimeConnection & {
  start: jest.Mock;
  stop: jest.Mock;
  createJob: jest.Mock;
  controlJob: jest.Mock;
  patchSong: jest.Mock;
  getSong: jest.Mock;
  downloadArtifact: jest.Mock;
  trashSong: jest.Mock;
  restoreSong: jest.Mock;
  refreshLibrary: jest.Mock;
};

type Fixture = {
  dependencies: BackendRuntimeDependencies;
  callbacks: BackendRuntimeConnectionCallbacks[];
  connections: FakeConnection[];
  loadBackends: jest.Mock;
  saveBackends: jest.Mock;
  loadJobs: jest.Mock;
  mergeJobs: jest.Mock;
  loadLibrary: jest.Mock;
  commitLibrary: jest.Mock;
  loadOutbox: jest.Mock;
  putPending: jest.Mock;
  markAccepted: jest.Mock;
  markRejected: jest.Mock;
  inspectAudio: jest.Mock;
  appendAudioChunk: jest.Mock;
  finalizeAudio: jest.Mock;
  pinAudio: jest.Mock;
  unpinAudio: jest.Mock;
  removeAudio: jest.Mock;
};

function connection(): FakeConnection {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    createJob: jest.fn().mockResolvedValue(job('canonical-job')),
    controlJob: jest.fn().mockResolvedValue(job('controlled-job', 2)),
    patchSong: jest.fn().mockResolvedValue(song(2)),
    getSong: jest.fn().mockResolvedValue(detail),
    downloadArtifact: jest.fn().mockResolvedValue(undefined),
    trashSong: jest.fn().mockResolvedValue(song(2, true)),
    restoreSong: jest.fn().mockResolvedValue(song(2, false)),
    refreshLibrary: jest.fn(),
  };
}

function fixture(backends: BackendRecord[] = [backend]): Fixture {
  const callbacks: BackendRuntimeConnectionCallbacks[] = [];
  const connections: FakeConnection[] = [];
  const loadBackendsMock = jest.fn().mockResolvedValue(backends);
  const saveBackendsMock = jest.fn().mockResolvedValue(undefined);
  const loadJobsMock = jest.fn().mockResolvedValue([job('cached-job')]);
  const mergeJobsMock = jest.fn(async (_node, jobs) => jobs);
  const loadLibraryMock = jest.fn().mockResolvedValue({
    revision: 4,
    songs: [song()],
    lastSyncedAt: '2026-08-08T00:02:00Z',
  });
  const commitLibraryMock = jest.fn(async (_node, revision, songs) => ({
    revision,
    songs,
    lastSyncedAt: '2026-08-08T00:03:00Z',
  }));
  const loadOutboxMock = jest.fn().mockResolvedValue([]);
  const putPendingMock = jest.fn(
    async (
      nodePublicKey: string,
      model: string,
      generation: { caption: string },
    ): Promise<OutboxEntry> => ({
      clientRequestId: 'request-a',
      nodePublicKey,
      model,
      generation,
      requestHash: 'hash',
      state: 'pending',
      createdAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:00Z',
    }),
  );
  const markAcceptedMock = jest.fn().mockResolvedValue(undefined);
  const markRejectedMock = jest.fn().mockResolvedValue(undefined);
  const inspectAudioMock = jest
    .fn()
    .mockResolvedValue({ state: 'pinned', bytes: 10 });
  const appendAudioChunkMock = jest.fn().mockResolvedValue(10);
  const finalizeAudioMock = jest.fn().mockResolvedValue(undefined);
  const pinAudioMock = jest
    .fn()
    .mockResolvedValue({ state: 'pinned', bytes: 10 });
  const unpinAudioMock = jest
    .fn()
    .mockResolvedValue({ state: 'cached', bytes: 10 });
  const removeAudioMock = jest
    .fn()
    .mockResolvedValue({ state: 'remote', bytes: 0 });
  const localPathMock = jest
    .fn()
    .mockResolvedValue('/data/cantor-audio/cache/fixture.opus');
  const audioStore: LocalAudioStore = {
    inspect: ref => inspectAudioMock(ref.nodeKey, ref.songId, ref.digest),
    localPath: ref => localPathMock(ref.nodeKey, ref.songId, ref.digest),
    createSink: ref => ({
      offset: async () => {
        const local = await inspectAudioMock(
          ref.nodeKey,
          ref.songId,
          ref.digest,
        );
        return local.state === 'partial' ? local.bytes : 0;
      },
      append: (offset, encoded) =>
        appendAudioChunkMock(
          ref.nodeKey,
          ref.songId,
          ref.digest,
          offset,
          encoded,
        ),
      finalize: byteLength =>
        finalizeAudioMock(ref.nodeKey, ref.songId, ref.digest, byteLength),
    }),
    pin: ref => pinAudioMock(ref.nodeKey, ref.songId, ref.digest),
    unpin: ref => unpinAudioMock(ref.nodeKey, ref.songId, ref.digest),
    remove: ref => removeAudioMock(ref.nodeKey, ref.songId, ref.digest),
  };
  return {
    dependencies: {
      createConnection: (_backend, _identity, _pairToken, received) => {
        const created = connection();
        callbacks.push(received);
        connections.push(created);
        return created;
      },
      loadBackends: loadBackendsMock,
      saveBackends: saveBackendsMock,
      loadJobs: loadJobsMock,
      mergeJobs: mergeJobsMock,
      loadLibrary: loadLibraryMock,
      loadLibraries: jest.fn().mockResolvedValue({}),
      commitLibrary: commitLibraryMock,
      loadOutbox: loadOutboxMock,
      putPending: putPendingMock,
      markAccepted: markAcceptedMock,
      markRejected: markRejectedMock,
      audioStore,
    },
    callbacks,
    connections,
    loadBackends: loadBackendsMock,
    saveBackends: saveBackendsMock,
    loadJobs: loadJobsMock,
    mergeJobs: mergeJobsMock,
    loadLibrary: loadLibraryMock,
    commitLibrary: commitLibraryMock,
    loadOutbox: loadOutboxMock,
    putPending: putPendingMock,
    markAccepted: markAcceptedMock,
    markRejected: markRejectedMock,
    inspectAudio: inspectAudioMock,
    appendAudioChunk: appendAudioChunkMock,
    finalizeAudio: finalizeAudioMock,
    pinAudio: pinAudioMock,
    unpinAudio: unpinAudioMock,
    removeAudio: removeAudioMock,
  };
}

async function settle(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(fixtureValue: Fixture): Promise<{
  current: () => BackendRuntime;
  renderer: ReactTestRenderer.ReactTestRenderer;
}> {
  let value: BackendRuntime | undefined;
  function Harness() {
    value = useBackendRuntime(identity, fixtureValue.dependencies);
    return null;
  }
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<Harness />);
  });
  await settle();
  return {
    current: () => {
      if (value === undefined) throw new Error('Hook did not render.');
      return value;
    },
    renderer,
  };
}

describe('useBackendRuntime', () => {
  /**
   * Forgetting keeps what you kept.
   *
   * A pin is the only state this phone can still honour with the node gone:
   * a cached copy is a loan `enforceCacheBudget` may call in at any download,
   * and a part-transfer cannot resume without the engine that was sending it.
   * Keeping either would leave marks in the field standing on files that can
   * disappear with nothing left to fetch them back from.
   */
  it('keeps pinned songs after forgetting, releases the loans, and recovers everything on re-pair', async () => {
    const f = fixture();
    const songs = [
      { ...song(), id: 'cached', tags: ['p/Drive'] },
      { ...song(), id: 'pinned', tags: ['p/Dusk'] },
      { ...song(), id: 'remote', tags: ['p/Remote playlist'] },
      { ...song(), id: 'partial', tags: [] },
    ];
    const library = { revision: 22, songs, lastSyncedAt: '2026-09-10T00:00:00Z' };
    f.loadLibrary.mockResolvedValue(library);
    // Deletion has to be visible to the next inspect, or the restart below
    // would assert against files the fixture pretends are still there.
    const released = new Set<string>();
    f.inspectAudio.mockImplementation(async (_node, id) =>
      released.has(id)
        ? { state: 'remote', bytes: 0 }
        : { state: id, bytes: id === 'remote' ? 0 : 10 },
    );
    f.removeAudio.mockImplementation(async (_node, id) => {
      released.add(id);
      return { state: 'remote', bytes: 0 };
    });
    let mounted = await mount(f);
    expect(buildFieldController(mounted.current().state).presentations.size).toBe(4);
    await ReactTestRenderer.act(async () => {
      await mounted.current().commands.forgetBackend('node-a');
    });
    // The loans, and only the loans. A pin is not touched, and a song that was
    // never here has no file to delete.
    expect(f.removeAudio.mock.calls.map(call => call[1]).sort()).toEqual([
      'cached',
      'partial',
    ]);
    expect(f.saveBackends).toHaveBeenLastCalledWith([]);
    expect(f.connections[0].stop).toHaveBeenCalled();
    let field = buildFieldController(mounted.current().state);
    expect([...field.presentations.values()].map(p => p.song.id)).toEqual(['pinned']);
    expect([...field.presentations.values()].every(p => !p.ready)).toBe(true);
    await expect(mounted.current().commands.audioPath('node-a', songs[1], artifact)).resolves.toContain('fixture.opus');
    // A stopped connection must not revive remote content or flush an outbox.
    await ReactTestRenderer.act(async () => {
      f.callbacks[0].onSnapshot({ phase: 'ready', error: null, jobs: [], songs: [], libraryRevision: 99, librarySyncing: false });
    });
    expect(f.commitLibrary).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => mounted.renderer.unmount());
    f.loadBackends.mockResolvedValue([]);
    f.dependencies.loadLibraries = jest.fn().mockResolvedValue({ 'node-a': library });
    mounted = await mount(f);
    field = buildFieldController(mounted.current().state);
    expect([...field.presentations.values()].map(p => p.song.id)).toEqual(['pinned']);
    expect(f.connections).toHaveLength(1);
    await ReactTestRenderer.act(async () => {
      mounted.current().commands.pairBackend({ backend, pairToken: 'fresh-token' });
    });
    await ReactTestRenderer.act(async () => {
      f.callbacks[1].onSnapshot({ phase: 'ready', error: null, jobs: [], songs, libraryRevision: 22, librarySyncing: false });
    });
    // Pairing again brings the whole library back, released audio included:
    // nothing was ever deleted on the node.
    field = buildFieldController(mounted.current().state);
    expect(field.presentations.size).toBe(4);
    expect(allPlaylists([...field.presentations.values()].map(p => p.song.tags))).toEqual(['Drive', 'Dusk', 'Remote playlist']);
    expect(f.commitLibrary).toHaveBeenLastCalledWith('node-a', 22, songs);
    await ReactTestRenderer.act(async () => mounted.renderer.unmount());
  });

  it('hydrates caches, starts one connection, persists snapshots, flushes the owner outbox, and stops on unmount', async () => {
    const f = fixture();
    f.loadOutbox.mockResolvedValue([
      {
        clientRequestId: 'pending-a',
        nodePublicKey: 'node-a',
        model: 'light',
        generation: { caption: 'A' },
        requestHash: 'hash-a',
        state: 'pending',
        createdAt: '2026-08-08T00:00:00Z',
        updatedAt: '2026-08-08T00:00:00Z',
      },
      {
        clientRequestId: 'pending-other',
        nodePublicKey: 'node-b',
        model: 'light',
        generation: { caption: 'B' },
        requestHash: 'hash-b',
        state: 'pending',
        createdAt: '2026-08-08T00:00:00Z',
        updatedAt: '2026-08-08T00:00:00Z',
      },
    ]);
    const mounted = await mount(f);

    expect(f.loadJobs).toHaveBeenCalledWith('node-a');
    expect(f.loadLibrary).toHaveBeenCalledWith('node-a');
    expect(f.connections).toHaveLength(1);
    expect(f.connections[0].start).toHaveBeenCalledTimes(1);
    expect(mounted.current().state.snapshots['node-a'].jobs).toEqual([
      job('cached-job'),
    ]);
    expect(mounted.current().state.snapshots['node-a'].songs).toEqual([song()]);
    expect(f.inspectAudio).toHaveBeenCalledWith(
      'node-a',
      'song-a',
      artifact.sha256,
    );

    const remoteSnapshot: ConnectionSnapshot = {
      phase: 'ready',
      error: null,
      jobs: [job('remote-job', 2)],
      songs: [song(3)],
      libraryRevision: 7,
      librarySyncing: false,
    };
    await ReactTestRenderer.act(async () => {
      f.callbacks[0].onSnapshot(remoteSnapshot);
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    expect(f.mergeJobs).toHaveBeenCalledWith('node-a', remoteSnapshot.jobs);
    expect(f.commitLibrary).toHaveBeenCalledWith(
      'node-a',
      7,
      remoteSnapshot.songs,
    );
    expect(f.connections[0].createJob).toHaveBeenCalledWith(
      'pending-a',
      'light',
      { caption: 'A' },
    );
    expect(f.markAccepted).toHaveBeenCalledWith('pending-a', 'canonical-job');

    await ReactTestRenderer.act(async () => mounted.renderer.unmount());
    expect(f.connections[0].stop).toHaveBeenCalledTimes(1);
  });

  it('re-pairs with the one-time token, preserves node info, and refreshes the replacement connection', async () => {
    const f = fixture();
    const createdWith: Array<{
      backend: BackendRecord;
      token: string | undefined;
    }> = [];
    f.dependencies.createConnection = (
      createdBackend,
      _identity,
      pairToken,
      callbacks,
    ) => {
      const created = connection();
      createdWith.push({ backend: createdBackend, token: pairToken });
      f.callbacks.push(callbacks);
      f.connections.push(created);
      return created;
    };
    const mounted = await mount(f);

    await ReactTestRenderer.act(async () => {
      mounted.current().commands.pairBackend({
        backend: {
          nodePubkey: 'node-a',
          relayUrl: 'wss://new-relay.example',
          petname: 'Re-paired',
          lastNodeInfo: null,
        },
        pairToken: 'one-time-token',
      });
    });
    await settle();

    expect(f.connections[0].stop).toHaveBeenCalledTimes(1);
    expect(createdWith[1]).toEqual({
      backend: {
        nodePubkey: 'node-a',
        relayUrl: 'wss://new-relay.example',
        petname: 'Re-paired',
        lastNodeInfo: nodeInfo,
      },
      token: 'one-time-token',
    });
    expect(f.saveBackends).toHaveBeenLastCalledWith([createdWith[1].backend]);

    mounted.current().commands.refreshLibraries();
    expect(f.connections[1].refreshLibrary).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => mounted.renderer.unmount());
    expect(f.connections[1].stop).toHaveBeenCalledTimes(1);
  });

  it('preserves command errors and resumable audio download sequencing', async () => {
    const f = fixture();
    f.loadLibrary.mockResolvedValue({
      revision: null,
      songs: [],
      lastSyncedAt: null,
    });
    const mounted = await mount(f);
    const live = f.connections[0];

    await mounted.current().commands.submit('node-a', 'light', {
      caption: 'New song',
    });
    expect(f.putPending).toHaveBeenCalledWith('node-a', 'light', {
      caption: 'New song',
    });
    expect(live.createJob).toHaveBeenCalledWith('request-a', 'light', {
      caption: 'New song',
    });
    expect(f.markAccepted).toHaveBeenCalledWith('request-a', 'canonical-job');

    await mounted
      .current()
      .commands.controlJob('node-a', job('job-a', 3), 'pause');
    expect(live.controlJob).toHaveBeenCalledWith('pause', 'job-a', 3);
    await mounted.current().commands.patchSong('node-a', song(4), {
      title: 'Edited',
    });
    expect(live.patchSong).toHaveBeenCalledWith('song-a', 4, {
      title: 'Edited',
    });
    await mounted.current().commands.changeSongPresence('node-a', song(5));
    expect(live.trashSong).toHaveBeenCalledWith('song-a', 5);
    await expect(
      mounted.current().commands.getSongDetail('node-a', 'song-a'),
    ).resolves.toEqual(detail);

    f.inspectAudio
      .mockReset()
      .mockResolvedValueOnce({ state: 'partial', bytes: 4 })
      .mockResolvedValueOnce({ state: 'partial', bytes: 4 })
      .mockResolvedValueOnce({ state: 'cached', bytes: 10 });
    live.downloadArtifact.mockImplementation(
      async (
        _songId: string,
        _artifact: ArtifactView,
        sink: {
          offset: () => Promise<number>;
          append: (offset: number, data: string) => Promise<number>;
          finalize: (bytes: number) => Promise<void>;
        },
        progress: (bytes: number, total: number) => void,
      ) => {
        expect(await sink.offset()).toBe(4);
        progress(4, 10);
        expect(await sink.append(4, 'encoded')).toBe(10);
        progress(10, 10);
        await sink.finalize(10);
      },
    );
    await ReactTestRenderer.act(async () => {
      await mounted
        .current()
        .commands.audio('node-a', song(), artifact, 'download');
    });

    expect(f.appendAudioChunk).toHaveBeenCalledWith(
      'node-a',
      'song-a',
      artifact.sha256,
      4,
      'encoded',
    );
    expect(f.finalizeAudio).toHaveBeenCalledWith(
      'node-a',
      'song-a',
      artifact.sha256,
      10,
    );
    expect(
      mounted.current().state.localAudio[`node-a:song-a:${artifact.sha256}`],
    ).toEqual({ state: 'cached', bytes: 10 });

    await ReactTestRenderer.act(async () => mounted.renderer.unmount());
    const offline = await mount(fixture([]));
    await expect(
      offline.current().commands.submit('node-a', 'light', {
        caption: 'Offline',
      }),
    ).rejects.toThrow('Backend is not connected.');
    await expect(
      offline.current().commands.controlJob('node-a', job('job-a'), 'pause'),
    ).rejects.toThrow('Job node is not connected.');
    await expect(
      offline.current().commands.getSongDetail('node-a', 'song-a'),
    ).rejects.toThrow('Song node is not connected.');

    await ReactTestRenderer.act(async () => offline.renderer.unmount());
  });
});
