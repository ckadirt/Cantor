import type { LibraryChange, SongHeader } from '../../core/protocol';
import { applyLibraryChanges, mergeSongHeaders } from '../repository';

export type LibrarySyncStage = {
  snapshotRevision: number;
  songs: ReadonlyMap<string, SongHeader>;
};

export type LibrarySyncState = {
  songs: SongHeader[];
  libraryRevision: number | null;
  librarySyncing: boolean;
  requestInFlight: boolean;
  stage: LibrarySyncStage | null;
};

export type LibrarySyncEvent =
  | { type: 'start-full' }
  | { type: 'refresh' }
  | {
      type: 'page';
      snapshotRevision: number;
      songs: SongHeader[];
      tombstones: string[];
      nextCursor?: string;
    }
  | {
      type: 'changes';
      changes: LibraryChange[];
      throughRevision: number;
      hasMore: boolean;
    }
  | { type: 'changed'; revision: number }
  | { type: 'full-sync-required' }
  | { type: 'request-failed' };

export type LibrarySyncEffect =
  | { type: 'request-page'; cursor: string | null }
  | { type: 'request-changes'; sinceRevision: number }
  | { type: 'fail'; message: string };

export type LibrarySyncTransition = {
  state: LibrarySyncState;
  effects: LibrarySyncEffect[];
  /** Mirrors the exact branches where BackendConnection currently publishes. */
  publishSnapshot: boolean;
};

export function createLibrarySyncState(
  snapshot: {
    songs: SongHeader[];
    libraryRevision: number | null;
    librarySyncing?: boolean;
  } = { songs: [], libraryRevision: null },
): LibrarySyncState {
  return {
    songs: snapshot.songs,
    libraryRevision: snapshot.libraryRevision,
    librarySyncing: snapshot.librarySyncing ?? false,
    requestInFlight: false,
    stage: null,
  };
}

export function reduceLibrarySync(
  state: LibrarySyncState,
  event: LibrarySyncEvent,
): LibrarySyncTransition {
  switch (event.type) {
    case 'start-full':
      return startFullSync(state);
    case 'refresh':
      if (state.requestInFlight) return unchanged(state);
      return state.libraryRevision === null
        ? startFullSync(state)
        : requestChanges(state, state.libraryRevision);
    case 'page':
      return receivePage(state, event);
    case 'changes':
      return receiveChanges(state, event);
    case 'changed':
      if (
        state.requestInFlight ||
        (state.libraryRevision !== null &&
          event.revision <= state.libraryRevision)
      ) {
        return unchanged(state);
      }
      return state.libraryRevision === null
        ? startFullSync(state)
        : requestChanges(state, state.libraryRevision);
    case 'full-sync-required':
      return startFullSync({ ...state, requestInFlight: false });
    case 'request-failed':
      return {
        state: {
          ...state,
          librarySyncing: false,
          requestInFlight: false,
          stage: null,
        },
        effects: [],
        publishSnapshot: true,
      };
  }
}

function startFullSync(state: LibrarySyncState): LibrarySyncTransition {
  if (state.requestInFlight) return unchanged(state);
  return {
    state: {
      ...state,
      librarySyncing: true,
      requestInFlight: true,
      stage: null,
    },
    effects: [{ type: 'request-page', cursor: null }],
    publishSnapshot: true,
  };
}

function requestChanges(
  state: LibrarySyncState,
  sinceRevision: number,
): LibrarySyncTransition {
  return {
    state: { ...state, requestInFlight: true },
    effects: [{ type: 'request-changes', sinceRevision }],
    publishSnapshot: false,
  };
}

function receivePage(
  state: LibrarySyncState,
  page: Extract<LibrarySyncEvent, { type: 'page' }>,
): LibrarySyncTransition {
  const currentStage = state.stage;
  if (
    currentStage !== null &&
    currentStage.snapshotRevision !== page.snapshotRevision
  ) {
    return fail(
      state,
      'Node library snapshot changed inside one page sequence.',
    );
  }
  const songs = new Map(currentStage?.songs ?? []);
  for (const song of page.songs) songs.set(song.id, song);
  for (const songId of page.tombstones) songs.delete(songId);

  if (page.nextCursor !== undefined) {
    return {
      state: {
        ...state,
        requestInFlight: true,
        stage: { snapshotRevision: page.snapshotRevision, songs },
      },
      effects: [{ type: 'request-page', cursor: page.nextCursor }],
      publishSnapshot: false,
    };
  }

  return {
    state: {
      ...state,
      songs: mergeSongHeaders([], [...songs.values()]),
      libraryRevision: page.snapshotRevision,
      librarySyncing: true,
      requestInFlight: true,
      stage: null,
    },
    effects: [
      { type: 'request-changes', sinceRevision: page.snapshotRevision },
    ],
    publishSnapshot: true,
  };
}

function receiveChanges(
  state: LibrarySyncState,
  batch: Extract<LibrarySyncEvent, { type: 'changes' }>,
): LibrarySyncTransition {
  if (
    state.libraryRevision !== null &&
    batch.throughRevision < state.libraryRevision
  ) {
    return fail(state, 'Node library changes are invalid.');
  }
  return {
    state: {
      ...state,
      songs: applyLibraryChanges(state.songs, batch.changes),
      libraryRevision: batch.throughRevision,
      librarySyncing: batch.hasMore,
      requestInFlight: batch.hasMore,
    },
    effects: batch.hasMore
      ? [
          {
            type: 'request-changes',
            sinceRevision: batch.throughRevision,
          },
        ]
      : [],
    publishSnapshot: true,
  };
}

function fail(state: LibrarySyncState, message: string): LibrarySyncTransition {
  return {
    state: {
      ...state,
      librarySyncing: false,
      requestInFlight: false,
      stage: null,
    },
    effects: [{ type: 'fail', message }],
    publishSnapshot: false,
  };
}

function unchanged(state: LibrarySyncState): LibrarySyncTransition {
  return { state, effects: [], publishSnapshot: false };
}
