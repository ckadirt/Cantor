import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { ArtifactView } from '../../../../protocol/ArtifactView';
import type { JobView } from '../../../../protocol/JobView';
import type { NodeInfo } from '../../../../protocol/NodeInfo';
import type { SongHeader } from '../../../../protocol/SongHeader';
import { BackendConnection } from '../../backends/connection';
import { loadBackends, saveBackends } from '../../backends/storage';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import type { TransportDescriptor } from '../../security/types';
import { loadOutbox, markAccepted, markRejected } from '../../jobs/outbox';
import { loadJobs, mergeJobs } from '../../jobs/repository';
import { commitLibrary, loadLibrary } from '../../library/repository';
import { inspectAudio } from '../../audio/repository';
import { MainScreen } from '../MainScreen';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../backends/PairBackendModal', () => ({
  PairBackendModal: () => null,
}));
jest.mock('../../backends/connection', () => {
  return {
    BackendConnection: jest.fn(),
    NodeRequestError: Error,
  };
});
jest.mock('../../backends/storage', () => ({
  loadBackends: jest.fn(),
  saveBackends: jest.fn(),
}));
jest.mock('../../jobs/outbox', () => ({
  loadOutbox: jest.fn(),
  markAccepted: jest.fn(),
  markRejected: jest.fn(),
  putPending: jest.fn(),
}));
jest.mock('../../jobs/repository', () => {
  const actual = jest.requireActual('../../jobs/repository');
  return {
    ...actual,
    loadJobs: jest.fn(),
    mergeJobs: jest.fn(),
  };
});
jest.mock('../../library/repository', () => {
  const actual = jest.requireActual('../../library/repository');
  return {
    ...actual,
    loadLibrary: jest.fn(),
    commitLibrary: jest.fn(),
  };
});
jest.mock('../../audio/repository', () => {
  const actual = jest.requireActual('../../audio/repository');
  return {
    ...actual,
    inspectAudio: jest.fn(),
    appendAudioChunk: jest.fn(),
    finalizeAudio: jest.fn(),
    playAudio: jest.fn(),
    pinAudio: jest.fn(),
    unpinAudio: jest.fn(),
    removeAudio: jest.fn(),
  };
});

type RuntimeCallbacks = {
  onSnapshot: (snapshot: ConnectionSnapshot) => void;
  onNodeInfo: (nodeInfo: NodeInfo) => void;
  onPairTokenConsumed: () => void;
  onTransportConfirmed: (descriptor: TransportDescriptor) => void;
};

const nodeInfo: NodeInfo = {
  name: 'Studio node',
  device_type: 'desktop',
  engine_version: 'test',
  models: [{ selector: 'light', family: 'ace-step', engine: 'acestep.cpp' }],
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

const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 900,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};

function song(revision = 3): SongHeader {
  return {
    id: '019fe1cb-a56a-7591-a7c1-2d577c1d01fc',
    revision,
    title: 'Cached song',
    caption_summary: 'Quiet piano',
    created_at: '2026-08-08T00:00:00Z',
    duration_ms: 8_000,
    model: 'light',
    favorite: false,
    tags: ['calm'],
    trashed: false,
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

const backend: BackendRecord = {
  nodePubkey: 'node-a',
  relayUrl: 'wss://relay.example',
  petname: 'Studio',
  lastNodeInfo: nodeInfo,
};

const identity = {
  publicKey: 'app-public-key',
  secretKey: new Uint8Array(32),
};

const connectionConstructor = BackendConnection as unknown as jest.Mock;
const mockLoadBackends = loadBackends as jest.MockedFunction<
  typeof loadBackends
>;
const mockSaveBackends = saveBackends as jest.MockedFunction<
  typeof saveBackends
>;
const mockLoadJobs = loadJobs as jest.MockedFunction<typeof loadJobs>;
const mockMergeJobs = mergeJobs as jest.MockedFunction<typeof mergeJobs>;
const mockLoadLibrary = loadLibrary as jest.MockedFunction<typeof loadLibrary>;
const mockCommitLibrary = commitLibrary as jest.MockedFunction<
  typeof commitLibrary
>;
const mockLoadOutbox = loadOutbox as jest.MockedFunction<typeof loadOutbox>;
const mockMarkAccepted = markAccepted as jest.MockedFunction<
  typeof markAccepted
>;
const mockMarkRejected = markRejected as jest.MockedFunction<
  typeof markRejected
>;
const mockInspectAudio = inspectAudio as jest.MockedFunction<
  typeof inspectAudio
>;

async function settleEffects(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function textContent(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return Array.isArray(value) ? value.map(textContent).join('') : '';
}

describe('MainScreen runtime characterization', () => {
  let callbacks: RuntimeCallbacks;
  let connection: {
    start: jest.Mock;
    stop: jest.Mock;
    createJob: jest.Mock;
    refreshLibrary: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    callbacks = undefined as unknown as RuntimeCallbacks;
    connection = {
      start: jest.fn(),
      stop: jest.fn(),
      createJob: jest.fn().mockResolvedValue(job('canonical-job')),
      refreshLibrary: jest.fn(),
    };
    connectionConstructor.mockImplementation(
      (
        _backend: BackendRecord,
        _identity: unknown,
        _pairToken: string | undefined,
        received: RuntimeCallbacks,
      ) => {
        callbacks = received;
        return connection;
      },
    );
    mockLoadBackends.mockResolvedValue([backend]);
    mockSaveBackends.mockResolvedValue();
    mockLoadJobs.mockResolvedValue([job('cached-job')]);
    mockMergeJobs.mockImplementation(async (_node, jobs) => jobs);
    mockLoadLibrary.mockResolvedValue({
      revision: 4,
      songs: [song()],
      lastSyncedAt: '2026-08-08T00:02:00Z',
    });
    mockCommitLibrary.mockImplementation(async (_node, revision, songs) => ({
      revision,
      songs,
      lastSyncedAt: '2026-08-08T00:03:00Z',
    }));
    mockLoadOutbox.mockResolvedValue([]);
    mockMarkAccepted.mockResolvedValue();
    mockMarkRejected.mockResolvedValue();
    mockInspectAudio.mockResolvedValue({ state: 'pinned', bytes: 900 });
  });

  it('hydrates offline jobs/library, asks native audio for truth, and starts one client', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(<MainScreen identity={identity} />);
    });
    await settleEffects();

    expect(mockLoadJobs).toHaveBeenCalledWith('node-a');
    expect(mockLoadLibrary).toHaveBeenCalledWith('node-a');
    expect(connectionConstructor).toHaveBeenCalledTimes(1);
    expect(connection.start).toHaveBeenCalledTimes(1);
    expect(mockInspectAudio).toHaveBeenCalledWith(
      'node-a',
      song().id,
      artifact.sha256,
    );

    const rendered = renderer.root
      .findAllByType(Text)
      .map(instance => textContent(instance.props.children))
      .join('\n');
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Song title' }).props
        .value,
    ).toBe('Cached song');
    expect(rendered).toContain('PINNED');
    expect(rendered).toContain('Generation complete');
  });

  it('persists a ready canonical snapshot and sends only this node pending outbox entries', async () => {
    mockLoadOutbox.mockResolvedValue([
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
      {
        clientRequestId: 'already-accepted',
        nodePublicKey: 'node-a',
        model: 'light',
        generation: { caption: 'C' },
        requestHash: 'hash-c',
        state: 'accepted',
        canonicalJobId: 'old-job',
        createdAt: '2026-08-08T00:00:00Z',
        updatedAt: '2026-08-08T00:00:00Z',
      },
    ]);

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(<MainScreen identity={identity} />);
    });
    await settleEffects();

    const canonicalJobs = [job('remote-job', 2)];
    const canonicalSongs = [song(5)];
    await ReactTestRenderer.act(async () => {
      callbacks.onSnapshot({
        phase: 'ready',
        error: null,
        jobs: canonicalJobs,
        songs: canonicalSongs,
        libraryRevision: 7,
        librarySyncing: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await settleEffects();

    expect(mockMergeJobs).toHaveBeenCalledWith('node-a', canonicalJobs);
    expect(mockCommitLibrary).toHaveBeenCalledWith('node-a', 7, canonicalSongs);
    expect(connection.createJob).toHaveBeenCalledTimes(1);
    expect(connection.createJob).toHaveBeenCalledWith('pending-a', 'light', {
      caption: 'A',
    });
    expect(mockMarkAccepted).toHaveBeenCalledWith('pending-a', 'canonical-job');
    expect(mockMarkRejected).not.toHaveBeenCalled();
  });
});
