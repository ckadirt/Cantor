/**
 * The field's projection, followed outside React.
 *
 * What these pin is what lets `FieldScreen` stop re-rendering for a running
 * job: a progress tick publishes a new controller whose songs and entities
 * are the objects the screen already holds, and a change the field does not
 * draw publishes nothing at all.
 */
import type { JobView } from '../../../../../protocol/JobView';
import type { SongHeader } from '../../../../../protocol/SongHeader';
import { createStore } from '../../../core/store';
import {
  INITIAL_RUNTIME_STATE,
  type BackendRuntimeState,
} from '../../../runtime/backendRuntime';
import { createFieldControllerStore } from '../fieldControllerStore';

const song: SongHeader = {
  id: 'song-a',
  revision: 1,
  title: 'A song',
  caption_summary: '',
  created_at: '2026-08-08T00:00:00Z',
  duration_ms: 11_000,
  model: 'light',
  favorite: false,
  tags: [],
  trashed: false,
  artifacts: [],
};

function running(completed: number): JobView {
  return {
    id: 'job-1',
    revision: completed,
    state: 'running',
    model: 'light',
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    progress: { completed, total: 8, unit: 'steps' },
  };
}

// One list for every state below, as the runtime keeps it: a job's progress
// replaces the node's snapshot and nothing else.
const backends = [
  {
    nodePubkey: 'node-a',
    relayUrl: 'wss://relay.example',
    petname: 'Studio',
    lastNodeInfo: null,
  },
];

function withJob(completed: number): BackendRuntimeState {
  return {
    ...INITIAL_RUNTIME_STATE,
    backends,
    snapshots: {
      'node-a': {
        phase: 'ready',
        error: null,
        jobs: [running(completed)],
        songs: [song],
        libraryRevision: 1,
        librarySyncing: false,
      },
    },
  };
}

describe('the field controller store', () => {
  it('moves only the job on a progress tick', () => {
    const runtime = createStore(withJob(1));
    const field = createFieldControllerStore(runtime);
    const release = field.connect();
    const before = field.store.get();
    expect(before.jobs.size).toBe(1);

    const heard = jest.fn();
    field.store.subscribe(heard);
    runtime.set(() => withJob(2));

    const after = field.store.get();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(after.jobs).not.toBe(before.jobs);
    // What the screen selects is the same objects, so it does not re-render.
    expect(after.presentations).toBe(before.presentations);
    expect(after.entities).toBe(before.entities);
    release();
  });

  it('tells nobody about a change the field does not draw', () => {
    const runtime = createStore(withJob(1));
    const field = createFieldControllerStore(runtime);
    const release = field.connect();
    const heard = jest.fn();
    field.store.subscribe(heard);

    runtime.set(current => ({ ...current, pairing: true }));
    runtime.set(current => ({ ...current, storageError: 'disk full' }));

    expect(heard).not.toHaveBeenCalled();
    release();
  });

  it('catches up on what landed while it was not connected', () => {
    const runtime = createStore(withJob(1));
    const field = createFieldControllerStore(runtime);
    runtime.set(() => withJob(3));
    const release = field.connect();
    const [job] = [...field.store.get().jobs.values()];
    expect(job.job.revision).toBe(3);
    release();

    // And stops following once released.
    runtime.set(() => withJob(4));
    expect([...field.store.get().jobs.values()][0].job.revision).toBe(3);
  });
});
