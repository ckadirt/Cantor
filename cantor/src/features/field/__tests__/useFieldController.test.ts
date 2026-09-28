import type { ArtifactView } from '../../../../../protocol/ArtifactView';
import type { JobView } from '../../../../../protocol/JobView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
import type { DeviceSong } from '../../../device/repository';
import { audioRefOf, buildFieldController } from '../useFieldController';

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
    expect(model.presentations.get('node-a:job-1')?.recipe.id).toBe('job-1');
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
    expect(
      build([job('job-1', 'running')]).jobs.get('node-a:job-1')?.caption,
    ).toBeNull();
  });

  it('takes the words from the node when it sends them, outbox or not', () => {
    // A job submitted from another phone, or by an app since reinstalled: the
    // outbox holds nothing, and the node's copy is the only one there is.
    const fromNode = { ...job('job-1', 'failed'), caption: 'una cumbia lenta' };
    expect(build([fromNode]).jobs.get('node-a:job-1')?.caption).toBe(
      'una cumbia lenta',
    );
    // With both, the node wins: it is the same on every device.
    expect(
      build(
        [fromNode],
        [],
        outboxEntry('node-a', 'job-1', 'stale local copy'),
      ).jobs.get('node-a:job-1')?.caption,
    ).toBe('una cumbia lenta');
  });
});

describe('reusing the last projection', () => {
  const node = backend('node-a', 'Studio');
  const songs = [
    song('song-1', '2026-08-01T00:00:00Z'),
    song('song-2', '2026-08-02T00:00:00Z'),
  ];

  function build(
    jobs: JobView[],
    previous: ReturnType<typeof buildFieldController> | null,
  ) {
    return buildFieldController(
      {
        backends: [node],
        snapshots: { 'node-a': snapshot(songs, 'ready', jobs) },
        localAudio: {},
        outbox: {},
      },
      previous,
    );
  }

  it('hands back the same controller when nothing changed', () => {
    const first = build([job('job-1', 'running')], null);
    expect(build([job('job-1', 'running')], first).presentations).toBe(
      first.presentations,
    );
    const running = first.jobs.get('node-a:job-1')!.job;
    const again = buildFieldController(
      {
        backends: [node],
        snapshots: { 'node-a': snapshot(songs, 'ready', [running]) },
        localAudio: {},
        outbox: {},
      },
      first,
    );
    expect(again).toBe(first);
  });

  it('rebuilds only the job that moved, and keeps what the layout reads', () => {
    const first = build([job('job-1', 'running')], null);
    const moved = { ...job('job-1', 'running'), revision: 2 };
    const next = build([moved], first);

    expect(next).not.toBe(first);
    expect(next.presentations).toBe(first.presentations);
    expect(next.jobs.get('node-a:job-1')?.job).toBe(moved);
    // Same entities in the same order: the layout has nothing to redo.
    expect(next.entities).toBe(first.entities);
  });
});

describe('device songs', () => {
  const album = {
    key: 'test artist|fixture album|/Music/Fixture Album',
    title: 'Fixture Album',
    artist: 'Test Artist',
    year: 2019,
    folder: '/Music/Fixture Album',
    artwork: null,
  };
  const deviceSong: DeviceSong = {
    id: 'd0123456789abcdef',
    mediaId: 776,
    path: '/Music/Fixture Album/01 - Tone MP3.mp3',
    size: 730681,
    headSha256: 'c'.repeat(64),
    durationMs: 30041,
    mime: 'audio/mpeg',
    title: 'Tone MP3',
    titleFromTag: true,
    artist: 'Test Artist',
    albumArtist: 'Test Artist',
    disc: 1,
    track: 1,
    year: 2019,
    date: null,
    genre: 'Ambient',
    albumKey: album.key,
    addedAtMs: 1_790_542_056_000,
    importedAtMs: 1_790_600_000_000,
    missingSinceMs: null,
  };
  const empty = { backends: [], snapshots: {}, localAudio: {}, outbox: {} };
  const library = (songs: DeviceSong[], tags: [string, string[]][] = []) => ({
    songs,
    albums: [album],
    tags: new Map(tags),
    generations: new Map(),
    excludedFolders: [],
  });

  it('joins the field under the reserved device key, as a song on the phone', () => {
    const model = buildFieldController({
      ...empty,
      device: library([deviceSong], [[deviceSong.id, ['p/road']]]),
    });
    const presentation = model.presentations.get(`device:${deviceSong.id}`);
    expect(presentation).toMatchObject({
      source: 'device',
      title: 'Tone MP3',
      durationMs: 30041,
      label: 'Test Artist',
      localAudio: { state: 'pinned', bytes: 730681 },
      audioActions: false,
      playable: true,
      album,
    });
    expect(presentation?.entity).toMatchObject({
      nodePublicKey: 'device',
      createdAtMs: deviceSong.addedAtMs,
      tags: ['p/road'],
    });
    expect(audioRefOf(presentation!)).toEqual({
      nodeKey: 'device',
      songId: deviceSong.id,
      digest: `730681:${'c'.repeat(64)}`,
    });
  });

  it('leaves a missing file’s song out', () => {
    const model = buildFieldController({
      ...empty,
      device: library([{ ...deviceSong, missingSinceMs: 5 }]),
    });
    expect(model.presentations.size).toBe(0);
    expect(model.entities).toEqual([]);
  });

  it('keeps the whole controller when the library object is new but its songs are not', () => {
    const songs = [deviceSong];
    const first = buildFieldController({ ...empty, device: library(songs) });
    const second = buildFieldController(
      { ...empty, device: library(songs) },
      first,
    );
    expect(second).toBe(first);
  });

  it('names a device song with no artist after the phone', () => {
    const model = buildFieldController({
      ...empty,
      device: library([{ ...deviceSong, artist: null }]),
    });
    expect(model.presentations.get(`device:${deviceSong.id}`)?.label).toBe(
      'This phone',
    );
  });
});
