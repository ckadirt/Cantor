import type { LibraryChange, SongHeader } from '../../../core/protocol';
import {
  createLibrarySyncState,
  reduceLibrarySync,
  type LibrarySyncState,
} from '..';

function song(
  id: string,
  revision = 1,
  createdAt = id === 'a' ? '2026-08-09T00:00:00Z' : '2026-08-08T00:00:00Z',
): SongHeader {
  return {
    id,
    revision,
    title: `Song ${id} r${revision}`,
    caption_summary: id,
    created_at: createdAt,
    duration_ms: 1_000,
    model: 'acestep:test',
    favorite: false,
    tags: [],
    trashed: false,
    artifacts: [],
  };
}

function upsert(songHeader: SongHeader, revision: number): LibraryChange {
  return {
    revision,
    song_id: songHeader.id,
    kind: 'upsert',
    changed_at: '2026-08-09T00:00:01Z',
    song: songHeader,
  };
}

function remove(songId: string, revision: number): LibraryChange {
  return {
    revision,
    song_id: songId,
    kind: 'tombstone',
    changed_at: '2026-08-09T00:00:01Z',
  };
}

describe('library synchronization reducer', () => {
  it('stages every full page and replaces the visible snapshot only at the boundary', () => {
    const cached = song('cached', 9);
    let transition = reduceLibrarySync(
      createLibrarySyncState({
        songs: [cached],
        libraryRevision: null,
      }),
      { type: 'start-full' },
    );
    expect(transition.effects).toEqual([
      { type: 'request-page', cursor: null },
    ]);
    expect(transition.publishSnapshot).toBe(true);
    expect(transition.state).toMatchObject({
      songs: [cached],
      libraryRevision: null,
      librarySyncing: true,
      requestInFlight: true,
    });

    transition = reduceLibrarySync(transition.state, {
      type: 'page',
      snapshotRevision: 4,
      songs: [song('a')],
      tombstones: [],
      nextCursor: 'signed-next',
    });
    expect(transition.state.songs).toEqual([cached]);
    expect(transition.publishSnapshot).toBe(false);
    expect([...transition.state.stage!.songs.values()]).toEqual([song('a')]);
    expect(transition.effects).toEqual([
      { type: 'request-page', cursor: 'signed-next' },
    ]);

    transition = reduceLibrarySync(transition.state, {
      type: 'page',
      snapshotRevision: 4,
      songs: [song('b')],
      tombstones: [],
    });
    expect(transition.state).toMatchObject({
      songs: [song('a'), song('b')],
      libraryRevision: 4,
      librarySyncing: true,
      requestInFlight: true,
      stage: null,
    });
    expect(transition.effects).toEqual([
      { type: 'request-changes', sinceRevision: 4 },
    ]);
    expect(transition.publishSnapshot).toBe(true);
  });

  it('applies page songs before tombstones and keeps later-page replacement behavior', () => {
    let state = syncingState();
    state = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 5,
      songs: [song('same', 5)],
      tombstones: ['same'],
      nextCursor: '',
    }).state;
    expect([...state.stage!.songs.values()]).toEqual([]);

    state = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 5,
      songs: [song('same', 2)],
      tombstones: [],
    }).state;
    expect(state.songs).toEqual([song('same', 2)]);
  });

  it('treats a completed full snapshot as authoritative over the cached revision', () => {
    const state = reduceLibrarySync(
      createLibrarySyncState({
        songs: [song('cached', 9)],
        libraryRevision: 9,
      }),
      { type: 'start-full' },
    ).state;

    const transition = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 4,
      songs: [song('replacement')],
      tombstones: [],
    });
    expect(transition.state).toMatchObject({
      songs: [song('replacement')],
      libraryRevision: 4,
      librarySyncing: true,
    });
    expect(transition.effects).toEqual([
      { type: 'request-changes', sinceRevision: 4 },
    ]);
  });

  it('rejects a revision change inside one page sequence without publishing the stage', () => {
    const cached = song('cached');
    let state = reduceLibrarySync(
      createLibrarySyncState({ songs: [cached], libraryRevision: 2 }),
      { type: 'start-full' },
    ).state;
    state = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 4,
      songs: [song('a')],
      tombstones: [],
      nextCursor: 'next',
    }).state;

    const transition = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 5,
      songs: [song('b')],
      tombstones: [],
    });
    expect(transition.state).toMatchObject({
      songs: [cached],
      libraryRevision: 2,
      librarySyncing: false,
      requestInFlight: false,
      stage: null,
    });
    expect(transition.effects).toEqual([
      {
        type: 'fail',
        message: 'Node library snapshot changed inside one page sequence.',
      },
    ]);
  });

  it('sequences incremental batches from through_revision and never regresses it', () => {
    let state = createLibrarySyncState({
      songs: [song('a', 3), song('b', 2)],
      libraryRevision: 7,
    });
    let transition = reduceLibrarySync(state, { type: 'refresh' });
    expect(transition.effects).toEqual([
      { type: 'request-changes', sinceRevision: 7 },
    ]);
    expect(transition.state.librarySyncing).toBe(false);

    const equalReplacement = {
      ...song('b', 2),
      title: 'Equal-revision replacement',
    };
    transition = reduceLibrarySync(transition.state, {
      type: 'changes',
      throughRevision: 8,
      changes: [upsert(song('a', 2), 8), upsert(equalReplacement, 8)],
      hasMore: true,
    });
    expect(transition.state).toMatchObject({
      songs: [song('a', 3), equalReplacement],
      libraryRevision: 8,
      librarySyncing: true,
      requestInFlight: true,
    });
    expect(transition.effects).toEqual([
      { type: 'request-changes', sinceRevision: 8 },
    ]);

    state = transition.state;
    transition = reduceLibrarySync(state, {
      type: 'changes',
      throughRevision: 9,
      changes: [upsert(song('b', 3), 9), remove('a', 9)],
      hasMore: false,
    });
    expect(transition.state).toMatchObject({
      songs: [song('b', 3)],
      libraryRevision: 9,
      librarySyncing: false,
      requestInFlight: false,
    });
    expect(transition.effects).toEqual([]);

    transition = reduceLibrarySync(transition.state, {
      type: 'changes',
      throughRevision: 8,
      changes: [],
      hasMore: false,
    });
    expect(transition.state).toMatchObject({
      songs: [song('b', 3)],
      libraryRevision: 9,
      librarySyncing: false,
      requestInFlight: false,
    });
    expect(transition.effects).toEqual([
      { type: 'fail', message: 'Node library changes are invalid.' },
    ]);
  });

  it('starts only needed push work and falls back atomically to a full sync', () => {
    const cached = song('cached');
    let state = createLibrarySyncState({
      songs: [cached],
      libraryRevision: 10,
    });
    expect(reduceLibrarySync(state, { type: 'changed', revision: 10 })).toEqual(
      { state, effects: [], publishSnapshot: false },
    );

    let transition = reduceLibrarySync(state, {
      type: 'changed',
      revision: 11,
    });
    expect(transition.effects).toEqual([
      { type: 'request-changes', sinceRevision: 10 },
    ]);
    expect(
      reduceLibrarySync(transition.state, {
        type: 'changed',
        revision: 12,
      }),
    ).toEqual({
      state: transition.state,
      effects: [],
      publishSnapshot: false,
    });

    transition = reduceLibrarySync(transition.state, {
      type: 'full-sync-required',
    });
    expect(transition.state).toMatchObject({
      songs: [cached],
      libraryRevision: 10,
      librarySyncing: true,
      requestInFlight: true,
      stage: null,
    });
    expect(transition.effects).toEqual([
      { type: 'request-page', cursor: null },
    ]);

    const unknown = createLibrarySyncState({
      songs: [cached],
      libraryRevision: null,
    });
    expect(
      reduceLibrarySync(unknown, { type: 'changed', revision: 1 }).effects,
    ).toEqual([{ type: 'request-page', cursor: null }]);
  });

  it('clears private staging and busy presentation state after request failure', () => {
    let state = syncingState();
    state = reduceLibrarySync(state, {
      type: 'page',
      snapshotRevision: 2,
      songs: [song('a')],
      tombstones: [],
      nextCursor: 'next',
    }).state;

    expect(reduceLibrarySync(state, { type: 'request-failed' })).toEqual({
      state: {
        ...state,
        librarySyncing: false,
        requestInFlight: false,
        stage: null,
      },
      effects: [],
      publishSnapshot: true,
    });
  });
});

function syncingState(): LibrarySyncState {
  return reduceLibrarySync(createLibrarySyncState(), {
    type: 'start-full',
  }).state;
}
