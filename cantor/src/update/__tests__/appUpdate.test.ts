import {
  createAppUpdate,
  failureMessage,
  updateAvailable,
  updateWaiting,
  UPDATE_KNOBS,
  type UpdateDeps,
} from '../appUpdate';
import { decodeManifest } from '../manifest';
import type { InstallEvent, Installed, NativeUpdate } from '../native';

const SHA = 'a'.repeat(64);
const manifest = (versionCode: number, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  versionCode,
  versionName: `0.1.${versionCode - 1}`,
  url: `https://github.com/ckadirt/Cantor/releases/download/app-v0.1.${versionCode - 1}/cantor.apk`,
  sha256: SHA,
  bytes: 1000,
  notes: 'Songs you cancel no longer come back',
  ...extra,
});

/** Lets every pending promise settle. */
const settle = () => new Promise<void>(resolve => setTimeout(() => resolve(), 0));

function harness({
  installed = { applicationId: 'com.cantor.app', versionCode: 2, versionName: '0.1.1' } as Installed,
  stored = null as string | null,
  latest = manifest(3) as unknown,
  canInstall = true,
  download = (): Promise<string> => Promise.resolve('/cache/updates/cantor.apk'),
  verify = (): Promise<{ versionCode: number; versionName: string }> =>
    Promise.resolve({ versionCode: 3, versionName: '0.1.2' }),
  withNative = true,
} = {}) {
  let progress: ((received: number, total: number) => void) | null = null;
  let installEvent: ((event: InstallEvent) => void) | null = null;
  let appStateListener: ((state: string) => void) | null = null;
  let allowed = canInstall;
  let clock = 1_000_000;
  const saved: string[] = [];
  const native: NativeUpdate = {
    current: jest.fn(() => Promise.resolve(installed)),
    canInstall: jest.fn(() => Promise.resolve(allowed)),
    allowInstall: jest.fn(() => Promise.resolve(true)),
    download: jest.fn(download),
    cancel: jest.fn(() => Promise.resolve(true)),
    verify: jest.fn(verify),
    install: jest.fn(() => Promise.resolve(true)),
    clear: jest.fn(() => Promise.resolve(true)),
    onProgress: listener => {
      progress = listener;
      return () => {};
    },
    onInstall: listener => {
      installEvent = listener;
      return () => {};
    },
  };
  const fetchJson = jest.fn((_url: string, _timeout: number) =>
    latest instanceof Error ? Promise.reject(latest) : Promise.resolve(latest),
  );
  const deps: UpdateDeps = {
    native: withNative ? native : null,
    fetchJson,
    storage: {
      load: () => Promise.resolve(stored),
      save: value => {
        saved.push(value);
        return Promise.resolve();
      },
    },
    appState: {
      currentState: 'active',
      addEventListener: (_type, listener) => {
        appStateListener = listener;
        return { remove: () => {} };
      },
    },
    now: () => clock,
  };
  const update = createAppUpdate(deps);
  return {
    update,
    native,
    fetchJson,
    saved,
    state: () => update.store.get(),
    progress: (r: number, t: number) => progress?.(r, t),
    installEvent: (e: InstallEvent) => installEvent?.(e),
    foreground: () => appStateListener?.('active'),
    allow: () => {
      allowed = true;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setLatest: (value: unknown) => {
      latest = value;
    },
  };
}

describe('decodeManifest', () => {
  it('reads schema 1', () => {
    expect(decodeManifest(manifest(3))).toEqual({
      versionCode: 3,
      versionName: '0.1.2',
      url: expect.stringMatching(/^https:/),
      sha256: SHA,
      bytes: 1000,
      notes: 'Songs you cancel no longer come back',
    });
  });

  it('ignores fields it does not know, and treats missing notes as empty', () => {
    const withoutNotes: Record<string, unknown> = { ...manifest(3), channel: 'beta' };
    delete withoutNotes.notes;
    expect(decodeManifest(withoutNotes)?.notes).toBe('');
  });

  it.each([
    ['another schema', { schema: 2 }],
    ['a plain-text address', { url: 'http://example.com/a.apk' }],
    ['a short hash', { sha256: 'abc' }],
    ['a fractional version', { versionCode: 2.5 }],
    ['a version name that is not X.Y.Z', { versionName: 'latest' }],
    ['no size', { bytes: 0 }],
  ])('refuses %s', (_name, change) => {
    expect(decodeManifest(manifest(3, change))).toBeNull();
  });

  it('refuses what is not an object', () => {
    expect(decodeManifest(null)).toBeNull();
    expect(decodeManifest('{}')).toBeNull();
  });
});

describe('following', () => {
  it('learns what is installed, checks, and marks a newer version as waiting', async () => {
    const h = harness();
    h.update.follow();
    await settle();
    expect(h.state().installed?.versionCode).toBe(2);
    expect(h.state().latest?.versionCode).toBe(3);
    expect(updateAvailable(h.state())).toBe(true);
    expect(updateWaiting(h.state())).toBe(true);
    // A fresh install is not "just updated".
    expect(h.state().justUpdated).toBe(false);
  });

  it('stops marking once the offer has been seen, and remembers it', async () => {
    const h = harness();
    h.update.follow();
    await settle();
    h.update.markSeen();
    expect(updateWaiting(h.state())).toBe(false);
    expect(updateAvailable(h.state())).toBe(true);
    expect(JSON.parse(h.saved[h.saved.length - 1]).seenCode).toBe(3);

    const again = harness({ stored: h.saved[h.saved.length - 1] });
    again.update.follow();
    await settle();
    expect(updateWaiting(again.state())).toBe(false);
  });

  it('says "updated" once on the first launch of a newer version, and drops the old file', async () => {
    const h = harness({
      installed: { applicationId: 'com.cantor.app', versionCode: 3, versionName: '0.1.2' },
      stored: JSON.stringify({ ranCode: 2, seenCode: 3, announce: null }),
    });
    h.update.follow();
    await settle();
    expect(h.state().justUpdated).toBe(true);
    expect(h.native.clear).toHaveBeenCalled();
    expect(updateAvailable(h.state())).toBe(false);
    h.update.markSeen();
    expect(h.state().justUpdated).toBe(false);
    expect(JSON.parse(h.saved[h.saved.length - 1]).announce).toBeNull();
  });

  it('never offers an update to Cantor Dev', async () => {
    const h = harness({
      installed: { applicationId: 'com.cantor.app.dev', versionCode: 1, versionName: '0.1.0' },
    });
    h.update.follow();
    await settle();
    expect(h.state().latest?.versionCode).toBe(3);
    expect(updateAvailable(h.state())).toBe(false);
    expect(updateWaiting(h.state())).toBe(false);
  });

  it('knows nothing without the native module, and offers nothing', async () => {
    const h = harness({ withNative: false });
    h.update.follow();
    await settle();
    expect(h.state().installed).toBeNull();
    expect(updateAvailable(h.state())).toBe(false);
  });
});

describe('checking', () => {
  it('keeps what it knew when a check fails, and says the check failed', async () => {
    const h = harness();
    h.update.follow();
    await settle();
    h.setLatest(new Error('offline'));
    await h.update.check(true);
    expect(h.state().checkFailed).toBe(true);
    expect(h.state().latest?.versionCode).toBe(3);
  });

  it('treats a malformed manifest as a failed check, never as up to date', async () => {
    const h = harness({ latest: { schema: 1, versionCode: 'three' } });
    h.update.follow();
    await settle();
    expect(h.state().latest).toBeNull();
    expect(h.state().checkFailed).toBe(true);
  });

  it('coming back to the front checks again only once the last check is stale', async () => {
    const h = harness();
    h.update.follow();
    await settle();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    h.foreground();
    await settle();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    h.advance(UPDATE_KNOBS.RECHECK_MS + 1);
    h.foreground();
    await settle();
    expect(h.fetchJson).toHaveBeenCalledTimes(2);
  });
});

describe('updating', () => {
  it('downloads, proves and hands the file to Android', async () => {
    let finish: (path: string) => void = () => {};
    const h = harness({ download: () => new Promise(resolve => (finish = resolve)) });
    h.update.follow();
    await settle();
    const started = h.update.start();
    expect(h.state().phase).toEqual({ kind: 'downloading', received: 0, total: 1000 });
    h.progress(400, 1000);
    expect(h.state().phase).toEqual({ kind: 'downloading', received: 400, total: 1000 });
    finish('/cache/updates/cantor.apk');
    await started;
    expect(h.native.download).toHaveBeenCalledWith(expect.stringMatching(/^https:/), SHA, 1000);
    expect(h.native.verify).toHaveBeenCalledWith('/cache/updates/cantor.apk');
    expect(h.native.install).toHaveBeenCalledWith('/cache/updates/cantor.apk');
    expect(h.state().phase.kind).toBe('installing');
    h.installEvent({ status: 'cancelled' });
    expect(h.state().phase.kind).toBe('idle');
  });

  it('installs nothing when the download is damaged', async () => {
    const h = harness({
      download: () => Promise.reject(Object.assign(new Error('x'), { code: 'checksum_mismatch' })),
    });
    h.update.follow();
    await settle();
    await h.update.start();
    expect(h.native.install).not.toHaveBeenCalled();
    expect(h.state().phase).toEqual({ kind: 'failed', message: failureMessage('checksum_mismatch') });
  });

  it('installs nothing when the file is another version than the one offered', async () => {
    const h = harness({ verify: () => Promise.resolve({ versionCode: 4, versionName: '0.1.3' }) });
    h.update.follow();
    await settle();
    await h.update.start();
    expect(h.native.install).not.toHaveBeenCalled();
    expect(h.state().phase.kind).toBe('failed');
  });

  it('asks for permission to install, and carries on when it comes back with it', async () => {
    const h = harness({ canInstall: false });
    h.update.follow();
    await settle();
    await h.update.start();
    expect(h.native.allowInstall).toHaveBeenCalled();
    expect(h.state().phase.kind).toBe('allowing');
    expect(h.native.install).not.toHaveBeenCalled();
    h.allow();
    h.foreground();
    await settle();
    expect(h.native.install).toHaveBeenCalledWith('/cache/updates/cantor.apk');
    expect(h.native.download).toHaveBeenCalledTimes(1);
  });

  it('says so when it comes back without permission', async () => {
    const h = harness({ canInstall: false });
    h.update.follow();
    await settle();
    await h.update.start();
    h.foreground();
    await settle();
    expect(h.state().phase).toEqual({ kind: 'failed', message: failureMessage('not_allowed') });
  });

  it('a cancelled download goes quietly back to the offer', async () => {
    const h = harness({
      download: () => Promise.reject(Object.assign(new Error('x'), { code: 'cancelled' })),
    });
    h.update.follow();
    await settle();
    await h.update.start();
    expect(h.state().phase.kind).toBe('idle');
  });

  it('does nothing when there is nothing newer', async () => {
    const h = harness({ latest: manifest(2) });
    h.update.follow();
    await settle();
    await h.update.start();
    expect(h.native.download).not.toHaveBeenCalled();
  });
});
