import type { ArtifactView } from '../../../../../protocol/ArtifactView';
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

function snapshot(songs: SongHeader[], phase: ConnectionSnapshot['phase']) {
  return {
    phase,
    error: null,
    jobs: [],
    songs,
    libraryRevision: 1,
    librarySyncing: false,
  } satisfies ConnectionSnapshot;
}

describe('buildFieldController', () => {
  it('keeps loading and empty runtime states spatially empty', () => {
    expect(
      buildFieldController({ backends: null, snapshots: {}, localAudio: {} }),
    ).toEqual({ entities: [], presentations: new Map() });
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
