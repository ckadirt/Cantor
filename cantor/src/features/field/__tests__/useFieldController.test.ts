import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { JobView } from '../../../../../protocol/JobView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
import { buildFieldController } from '../useFieldController';

const artifact: ArtifactView = {
  kind: 'delivery',
  profile: 'opus-stereo-160k-v1',
  media_type: 'audio/ogg; codecs=opus',
  byte_length: 900,
  sha256: 'a'.repeat(64),
  sample_rate: 48_000,
  channels: 2,
};

function backend(nodePubkey: string, petname: string): BackendRecord {
  return {
    nodePubkey,
    relayUrl: 'wss://relay.example',
    petname,
    lastNodeInfo: null,
  };
}

function song(id: string, createdAt: string, trashed = false): SongHeader {
  return {
    id,
    revision: 1,
    title: id,
    caption_summary: 'A test song',
    created_at: createdAt,
    duration_ms: 11_000,
    model: 'light',
    favorite: false,
    tags: ['ambient'],
    trashed,
    artifacts: [artifact],
  };
}

function snapshot(
  songs: SongHeader[],
  phase: ConnectionSnapshot['phase'],
  jobs: JobView[] = [],
) {
  return {
    phase,
    error: null,
    jobs,
    songs,
    libraryRevision: 1,
    librarySyncing: false,
  } satisfies ConnectionSnapshot;
}

function job(id: string, state: JobView['state']): JobView {
  return {
    id,
    revision: 1,
    state,
    model: 'light',
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
  };
}

function outboxEntry(nodePublicKey: string, jobId: string, caption: string) {
  return {
    [`${nodePublicKey}:${jobId}`]: {
      clientRequestId: 'req-1',
      nodePublicKey,
      model: 'light',
      generation: { caption },
      requestHash: 'hash',
      state: 'accepted' as const,
      canonicalJobId: jobId,
      createdAt: '2026-08-10T00:00:00Z',
      updatedAt: '2026-08-10T00:00:00Z',
    },
  };
}

describe('buildFieldController', () => {
  it('keeps loading and empty runtime states spatially empty', () => {
    expect(
      buildFieldController({
        backends: null,
        snapshots: {},
        localAudio: {},
        outbox: {},
      }),
    ).toEqual({ entities: [], presentations: new Map(), jobs: new Map() });
  });

  it('normalises real snapshots, excludes trash, and isolates same song ids by node', () => {
    const studio = backend('node-studio', 'Studio');
    const laptop = backend('node-laptop', 'Laptop');
    const model = buildFieldController({
      backends: [studio, laptop],
      snapshots: {
        'node-studio': snapshot(
          [
            song('shared', '2026-08-08T00:00:00Z'),
            song('trash', '2026-08-09T00:00:00Z', true),
          ],
          'ready',
        ),
        'node-laptop': snapshot(
          [song('shared', '2026-08-10T00:00:00Z')],
          'disconnected',
        ),
      },
      localAudio: {
        [`node-studio:shared:${artifact.sha256}`]: {
          state: 'pinned',
          bytes: artifact.byte_length,
        },
      },
      outbox: {},
    });

    expect(model.entities.map(entity => entity.key)).toEqual([
      'node-laptop:shared',
      'node-studio:shared',
    ]);
    expect(model.presentations.get('node-studio:shared')).toMatchObject({
      ready: true,
      localAudio: { state: 'pinned', bytes: artifact.byte_length },
      nodeLabels: ['Studio', 'node-studio'],
    });
    expect(model.presentations.get('node-laptop:shared')).toMatchObject({
      ready: false,
      localAudio: { state: 'remote', bytes: 0 },
      nodeLabels: ['Laptop', 'node-laptop'],
    });
    expect(model.presentations.has('node-studio:trash')).toBe(false);
  });
});

describe('generation as marks', () => {
  const node = backend('node-a', 'Studio');

  function build(jobs: JobView[], songs: SongHeader[] = [], outbox = {}) {
    return buildFieldController({
      backends: [node],
      snapshots: { 'node-a': snapshot(songs, 'ready', jobs) },
      localAudio: {},
      outbox,
    });
  }

  it('places a running job in the field as its own entity', () => {
    const model = build([job('job-1', 'running')]);

    expect(model.entities.map(entity => entity.key)).toEqual(['node-a:job-1']);
    expect(model.entities[0].kind).toBe('job');
    expect(model.jobs.get('node-a:job-1')?.job.state).toBe('running');
  });

  it.each([
    'queued',
    'preparing',
    'running',
    'pause_requested',
    'paused',
    'cancel_requested',
    'recovering',
    'finalizing',
    'failed',
  ] as const)('draws a %s job', state => {
    expect(build([job('job-1', state)]).jobs.size).toBe(1);
  });

  it('draws nothing for a cancelled job, which was withdrawn', () => {
    expect(build([job('job-1', 'cancelled')]).jobs.size).toBe(0);
  });

  it('hands the placement to the song once the song exists', () => {
    const model = build(
      [job('job-1', 'completed')],
      [song('job-1', '2026-08-10T00:00:00Z')],
    );

    // Same key, one entity: the mark does not blink or duplicate at hand-off.
    expect(model.entities.map(entity => entity.key)).toEqual(['node-a:job-1']);
    expect(model.jobs.size).toBe(0);
    expect(model.presentations.get('node-a:job-1')?.song.id).toBe('job-1');
  });

  it('keeps drawing a completed job until its song is observed', () => {
    const model = build([job('job-1', 'completed')]);

    expect(model.jobs.get('node-a:job-1')).toBeDefined();
  });

  it('reads the caption back off the persisted outbox', () => {
    const model = build(
      [job('job-1', 'running')],
      [],
      outboxEntry('node-a', 'job-1', 'a slow piano piece'),
    );

    expect(model.jobs.get('node-a:job-1')?.caption).toBe('a slow piano piece');
  });

  it('admits it has no caption rather than inventing one', () => {
    expect(build([job('job-1', 'running')]).jobs.get('node-a:job-1')?.caption)
      .toBeNull();
  });
});
