import { createStore, type Store } from '../core/store';
import { decodeManifest, MANIFEST_URL, type AppManifest } from './manifest';
import type { Installed, NativeUpdate } from './native';

/**
 * Updating Cantor from inside Cantor (internal/docs/plans/app-updates-plan.md).
 *
 * The app reads cantorfm.com/app/latest.json on launch, on coming back to the
 * front (at most every few hours) and whenever Settings opens; when it names
 * a newer version, Settings offers it and a quiet mark leads there from the
 * field. The ~64 MB download starts only when the user presses Update. The
 * file is checked twice before Android sees it (its SHA-256 against the
 * manifest, then its package, version and signing certificate against the
 * running app), and Android asks the user to confirm. Only the published app
 * (`com.cantor.app`) updates; Cantor Dev never offers it.
 */

/** KNOBS */
export const UPDATE_KNOBS = {
  /** How long a check stays fresh before coming back to the front checks again. */
  RECHECK_MS: 6 * 60 * 60 * 1000,
  /** A manifest request that takes longer than this is a failed check. */
  FETCH_TIMEOUT_MS: 15_000,
} as const;

/** The app that updates; every other build (Cantor Dev) only shows its version. */
export const RELEASE_ID = 'com.cantor.app';


export type UpdatePhase =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'downloading'; received: number; total: number }>
  | Readonly<{ kind: 'verifying' }>
  /** Android's page to allow installs is open; the update resumes on return. */
  | Readonly<{ kind: 'allowing' }>
  /** Handed to Android; its confirmation dialog is up. */
  | Readonly<{ kind: 'installing' }>
  | Readonly<{ kind: 'failed'; message: string }>;

export type AppUpdateState = Readonly<{
  /** The running app; null until known, and always null without the module. */
  installed: Installed | null;
  /** The newest published app; null until a check has succeeded. */
  latest: AppManifest | null;
  /** Whether the last check failed (offline, or a bad manifest). */
  checkFailed: boolean;
  checkedAt: number | null;
  phase: UpdatePhase;
  /** The newest versionCode the user has already been shown as available. */
  seenCode: number;
  /** This launch is the first on a version newer than the last: say so, once. */
  justUpdated: boolean;
}>;

export const INITIAL_UPDATE: AppUpdateState = {
  installed: null,
  latest: null,
  checkFailed: false,
  checkedAt: null,
  phase: { kind: 'idle' },
  seenCode: 0,
  justUpdated: false,
};

/** Whether a newer published version exists for this app. */
export function updateAvailable(state: AppUpdateState): boolean {
  return (
    state.installed !== null &&
    state.installed.applicationId === RELEASE_ID &&
    state.latest !== null &&
    state.latest.versionCode > state.installed.versionCode
  );
}

/** Whether the quiet mark shows: an update exists and the user has not seen it offered. */
export function updateWaiting(state: AppUpdateState): boolean {
  return updateAvailable(state) && state.seenCode < (state.latest?.versionCode ?? 0);
}

/** Whether work is under way (the control is working, not pressable). */
export function updateBusy(state: AppUpdateState): boolean {
  const kind = state.phase.kind;
  return kind === 'downloading' || kind === 'verifying' || kind === 'installing';
}

/** What is remembered between launches. */
type Persisted = { ranCode: number | null; seenCode: number; announce: number | null };

export type UpdateStorage = Readonly<{
  load: () => Promise<string | null>;
  save: (value: string) => Promise<void>;
}>;

export type AppStateLike = Readonly<{
  currentState: string;
  addEventListener: (type: 'change', listener: (state: string) => void) => { remove: () => void };
}>;

export type UpdateDeps = Readonly<{
  native: NativeUpdate | null;
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>;
  storage: UpdateStorage;
  appState: AppStateLike;
  now: () => number;
}>;

export type AppUpdate = Readonly<{
  store: Store<AppUpdateState>;
  /** Start following: what is installed, the remembered marks, checks. Returns a stop. */
  follow: () => () => void;
  /** Check now if the last check is stale, or always with `force`. */
  check: (force?: boolean) => Promise<void>;
  /** Download, prove and install the available update. */
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  /** The Version row has been seen: the mark and the once-after line go. */
  markSeen: () => void;
}>;

export function createAppUpdate(deps: UpdateDeps): AppUpdate {
  const store = createStore<AppUpdateState>(INITIAL_UPDATE);
  const set = (patch: Partial<AppUpdateState>) => store.set(current => ({ ...current, ...patch }));
  let persisted: Persisted = { ranCode: null, seenCode: 0, announce: null };
  /** A verified download waiting for permission to install. */
  let readyPath: string | null = null;

  const save = () => {
    deps.storage.save(JSON.stringify(persisted)).catch(() => {});
  };

  const check = async (force = false) => {
    const state = store.get();
    if (state.phase.kind !== 'idle' && state.phase.kind !== 'failed') return;
    const checkedAt = state.checkedAt;
    if (!force && checkedAt !== null && deps.now() - checkedAt < UPDATE_KNOBS.RECHECK_MS) return;
    const failed = state.phase.kind === 'failed' ? state.phase : null;
    set({ phase: { kind: 'checking' } });
    try {
      const latest = decodeManifest(await deps.fetchJson(MANIFEST_URL, UPDATE_KNOBS.FETCH_TIMEOUT_MS));
      if (latest === null) throw new Error('bad manifest');
      set({ latest, checkFailed: false, checkedAt: deps.now(), phase: failed ?? { kind: 'idle' } });
    } catch {
      // Keep what was known: a failed check is not news that nothing is new.
      set({ checkFailed: true, phase: failed ?? { kind: 'idle' } });
    }
  };

  const fail = (error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
    if (code === 'cancelled') {
      set({ phase: { kind: 'idle' } });
      return;
    }
    set({ phase: { kind: 'failed', message: failureMessage(code) } });
  };

  const install = async (path: string) => {
    const native = deps.native;
    if (native === null) return;
    if (!(await native.canInstall())) {
      readyPath = path;
      set({ phase: { kind: 'allowing' } });
      await native.allowInstall();
      return;
    }
    readyPath = null;
    set({ phase: { kind: 'installing' } });
    await native.install(path);
  };

  const start = async () => {
    const native = deps.native;
    const state = store.get();
    if (native === null || !updateAvailable(state) || updateBusy(state)) return;
    const latest = state.latest!;
    try {
      if (readyPath !== null) {
        await install(readyPath);
        return;
      }
      set({ phase: { kind: 'downloading', received: 0, total: latest.bytes } });
      const path = await native.download(latest.url, latest.sha256, latest.bytes);
      set({ phase: { kind: 'verifying' } });
      const verified = await native.verify(path);
      if (verified.versionCode !== latest.versionCode) {
        throw Object.assign(new Error('version'), { code: 'not_the_named_version' });
      }
      await install(path);
    } catch (error) {
      fail(error);
    }
  };

  const cancel = async () => {
    if (store.get().phase.kind !== 'downloading') return;
    await deps.native?.cancel();
  };

  const markSeen = () => {
    const state = store.get();
    const seen = state.latest !== null && updateAvailable(state) ? state.latest.versionCode : persisted.seenCode;
    if (seen === persisted.seenCode && persisted.announce === null && !state.justUpdated) return;
    persisted = { ...persisted, seenCode: Math.max(persisted.seenCode, seen), announce: null };
    save();
    set({ seenCode: persisted.seenCode, justUpdated: false });
  };

  const follow = () => {
    const native = deps.native;
    let live = true;
    const stops: (() => void)[] = [];
    if (native !== null) {
      stops.push(
        native.onProgress((received, total) => {
          if (store.get().phase.kind === 'downloading') set({ phase: { kind: 'downloading', received, total } });
        }),
        native.onInstall(event => {
          if (event.status === 'confirm') set({ phase: { kind: 'installing' } });
          // Success replaces this process with the new version; nothing to draw.
          else if (event.status === 'cancelled') set({ phase: { kind: 'idle' } });
          else if (event.status === 'failed') {
            set({ phase: { kind: 'failed', message: event.message ?? failureMessage('install_failed') } });
          }
        }),
      );
    }

    (async () => {
      const [installed, stored] = await Promise.all([
        native?.current().catch(() => null) ?? Promise.resolve(null),
        deps.storage.load().catch(() => null),
      ]);
      if (!live) return;
      persisted = { ...persisted, ...parsePersisted(stored) };
      if (installed !== null) {
        // The first launch on a newer version than the last one run: say so
        // once, and drop the file that brought it.
        if (persisted.ranCode !== null && persisted.ranCode < installed.versionCode) {
          persisted = { ...persisted, announce: installed.versionCode };
          native?.clear().catch(() => {});
        }
        persisted = { ...persisted, ranCode: installed.versionCode };
        save();
      }
      set({
        installed,
        seenCode: persisted.seenCode,
        justUpdated: installed !== null && persisted.announce === installed.versionCode,
      });
      await check(true);
    })().catch(() => {});

    const subscription = deps.appState.addEventListener('change', next => {
      if (next !== 'active') return;
      if (store.get().phase.kind === 'allowing') {
        // Back from Android's page: carry on if installs are now allowed.
        native
          ?.canInstall()
          .then(allowed => {
            if (!allowed) {
              set({ phase: { kind: 'failed', message: failureMessage('not_allowed') } });
              return;
            }
            if (readyPath !== null) install(readyPath).catch(fail);
          })
          .catch(fail);
        return;
      }
      if (store.get().phase.kind === 'installing') {
        // Android's dialog closed without an answer reaching us (some skins
        // swallow it): the control comes back rather than working forever.
        set({ phase: { kind: 'idle' } });
      }
      check().catch(() => {});
    });
    stops.push(() => subscription.remove());

    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  };

  return { store, follow, check, start, cancel, markSeen };
}

function parsePersisted(raw: string | null): Partial<Persisted> {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const number = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
    return {
      ranCode: number(value.ranCode),
      seenCode: number(value.seenCode) ?? 0,
      announce: number(value.announce),
    };
  } catch {
    return {};
  }
}

/** What a failure says, in the app's words: what happened, and that nothing broke. */
export function failureMessage(code: string): string {
  switch (code) {
    case 'checksum_mismatch':
    case 'size_mismatch':
      return 'The download arrived damaged, so nothing was installed. Try again.';
    case 'wrong_signer':
    case 'wrong_app':
    case 'not_an_app':
      return 'That file is not this Cantor, so nothing was installed.';
    case 'not_newer':
    case 'not_the_named_version':
      return 'The download was not the version offered, so nothing was installed.';
    case 'not_allowed':
      return 'Cantor needs permission to install its update. Allow it, then try again.';
    case 'install_failed':
      return 'Android could not install the update. Your Cantor is unchanged.';
    default:
      return 'The download stopped. Check the connection and try again.';
  }
}
