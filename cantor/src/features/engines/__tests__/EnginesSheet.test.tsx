import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import * as Renderer from 'react-test-renderer';
import fixture from '../../../../../protocol/fixtures/v2/node-info.json';
import type { NodeInfo } from '../../../core/protocol';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
import { STRIKE_KNOBS } from '../../controls';
import type { DeviceLibraryState } from '../../../device/deviceLibrary';
import type { FolderSummary } from '../../../device/folders';
import { EnginesSheet } from '../EnginesSheet';

// CanvasKit's system font manager is empty under Jest, so the recovery grid
// and the settings act have no face to lay out. The rest is plain React.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
  useFontScaledStyle: (style: unknown) => style,
}));

const node = fixture.node as NodeInfo;
const backend = (nodePubkey: string, selector: string): BackendRecord => ({
  nodePubkey,
  petname: nodePubkey,
  relayUrl: 'wss://example.test',
  lastNodeInfo: {
    ...node,
    models: [
      {
        selector,
        family: selector.split(':')[0],
        engine: selector.split(':')[0],
      },
    ],
  },
});
const snapshot: ConnectionSnapshot = {
  phase: 'disconnected',
  error: null,
  jobs: [],
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
};

const ROOT = '/storage/emulated/0';

function deviceState(
  extra: Partial<DeviceLibraryState> = {},
): DeviceLibraryState {
  return {
    status: 'ready',
    library: {
      songs: [],
      albums: [],
      tags: new Map(),
      generations: new Map(),
      excludedFolders: [],
    },
    scan: { phase: 'idle' },
    permission: 'unknown',
    folders: null,
    lookedAtMs: null,
    result: null,
    ...extra,
  };
}

function folder(label: string, extra: Partial<FolderSummary> = {}) {
  const segments = label.split('/');
  return {
    path: `${ROOT}/${label}`,
    label,
    root: segments[0] === 'Music' ? 'Music' : null,
    name: segments[segments.length - 1],
    songs: 10,
    albums: 2,
    loose: false,
    coverMediaId: null,
    status: 'new',
    voiceNotes: false,
    keep: true,
    ...extra,
  } as FolderSummary;
}

function phoneActions() {
  return {
    requestPermission: jest.fn(async () => 'granted'),
    openSettings: jest.fn(async () => undefined),
    look: jest.fn(async () => ({ changed: true })),
    refresh: jest.fn(async () => ({ changed: false })),
    bringIn: jest.fn(async () => undefined),
    seeThem: jest.fn(),
    leaveOut: jest.fn(async () => undefined),
    showAlbum: jest.fn(),
    report: jest.fn(),
  };
}

function render(
  snapshots: Record<string, ConnectionSnapshot> = {},
  device: DeviceLibraryState = deviceState(),
  actions = phoneActions(),
  startOn: 'phone' | null = null,
) {
  const onForget = jest.fn();
  const onRefresh = jest.fn();
  const onChangeBudget = jest.fn();
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <GestureHandlerRootView>
        <EnginesSheet
          open
          backends={[
            backend('studio', 'acestep:1.5-fast'),
            backend('phone', 'levo2:1.0-fast'),
          ]}
          snapshots={snapshots}
          footprints={{}}
          refreshing={false}
          onClose={jest.fn()}
          onPair={jest.fn()}
          onRefresh={onRefresh}
          onRename={jest.fn()}
          onForget={onForget}
          publicKey="123456789abcdef"
          library={{ songs: 9, placements: 14, playlists: 3 }}
          storage={{
            downloadedSongs: 3,
            downloadedBytes: 4000,
            cachedSongs: 2,
            cachedBytes: 2000,
          }}
          budgetBytes={1024 ** 3}
          onChangeBudget={onChangeBudget}
          device={device}
          phoneActions={actions}
          startOn={startOn}
        />
      </GestureHandlerRootView>,
    );
  });
  const press = (label: string) => {
    const button = tree.root.find(
      n =>
        typeof n.type !== 'string' &&
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityLabel === label,
    );
    Renderer.act(() => button.props.onPress());
  };
  const words = () =>
    tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children);
  // The head's eyebrow and title morph on a canvas; their words are labels.
  const labels = () =>
    tree.root
      .findAll(n => typeof n.props.accessibilityLabel === 'string')
      .map(n => n.props.accessibilityLabel as string);
  return { tree, press, words, labels, onForget, onChangeBudget, onRefresh };
}

describe('Ledger engine pages', () => {
  it("keeps each node's models behind its door, with where the others are", () => {
    const { press, words } = render();
    expect(words()).not.toContain('1.5 · fast');
    press('Open studio');
    expect(words()).toContain('1.5 · fast');
    expect(words()).toContain('HERE');
    // Levo is on the other node, and says so.
    expect(words()).toContain('ON PHONE');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
    press('Model levo2:1.0-fast');
    expect(words()).toContain('cantor pull levo2:1.0-fast');
    press('Back to nodes');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
    press('Open phone');
    press('Model levo2:1.0-fast');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
  });

  it('forgets the right node only on a whole hold of its act', () => {
    jest.useFakeTimers();
    try {
      const { press, onForget, tree } = render();
      const hold = (label: string, ms: number) => {
        const target = tree.root.find(
          n =>
            typeof n.type !== 'string' &&
            typeof n.props.onPressIn === 'function' &&
            n.props.accessibilityLabel === label,
        );
        // Held before the act runs: acting leaves the page under the finger.
        const { onPressIn, onPressOut } = target.props;
        Renderer.act(() => onPressIn());
        Renderer.act(() => {
          jest.advanceTimersByTime(ms);
        });
        Renderer.act(() => onPressOut());
      };
      press('Open studio');
      hold('Forget this node', STRIKE_KNOBS.HOLD_MS / 2);
      expect(onForget).not.toHaveBeenCalled();
      press('Back to nodes');
      press('Open phone');
      hold('Forget this node', STRIKE_KNOBS.HOLD_MS);
      expect(onForget).toHaveBeenCalledWith('phone');
    } finally {
      jest.useRealTimers();
    }
  });

  it("says each node's state as a person would, and syncs on opening", () => {
    const { words, labels, onRefresh } = render({
      studio: { ...snapshot, phase: 'ready' },
      phone: { ...snapshot, phase: 'handshaking' },
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(labels()).toContain('Two nodes');
    expect(words()).toContain('ONE READY · 0 SONGS');
    expect(words()).toContain('READY');
    expect(words()).toContain('CONNECTING');
    expect(words()).not.toContain('handshaking');
    expect(words()).not.toContain('Refresh libraries');
    expect(words()).toContain('Pair a node');
  });

  it('changes only the cache budget from settings and returns', () => {
    const { press, words, labels, onChangeBudget, onForget, tree } = render();
    press('Settings');
    expect(words()).toEqual(
      expect.arrayContaining(['DOWNLOADED', 'CACHED', 'PLACEMENTS']),
    );
    // The budget is a ruler: one step up from 1 GB is 2 GB.
    const ruler = tree.root.find(
      n =>
        n.props.accessibilityRole === 'adjustable' &&
        typeof n.type !== 'string',
    );
    expect(ruler.props.accessibilityLabel).toBe('Budget 1 GB');
    Renderer.act(() =>
      ruler.props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      }),
    );
    expect(onChangeBudget).toHaveBeenCalledWith(2 * 1024 ** 3);
    expect(onForget).not.toHaveBeenCalled();
    press('Back to nodes');
    expect(labels()).toContain('NODES');
  });

  it('puts the phone first, and asks before reading', async () => {
    const actions = phoneActions();
    const { press, words, tree } = render({}, deviceState(), actions);
    expect(words()).toContain('NOT READ YET');
    press('Open this phone');
    expect(words()).toContain('ANDROID WILL ASK');
    // Nothing is listed before the permission.
    expect(actions.look).not.toHaveBeenCalled();
    press('Allow music');
    expect(actions.requestPermission).toHaveBeenCalledTimes(1);
    await Renderer.act(async () => {});
    // The working rule retracts on a timer; nothing may outlive the test.
    Renderer.act(() => tree.unmount());
  });

  it('brings in what is left in ink', async () => {
    const actions = phoneActions();
    const whatsapp = folder('WhatsApp Audio', {
      voiceNotes: true,
      keep: false,
      songs: 50,
    });
    const { press, words, labels, tree } = render(
      {},
      deviceState({
        permission: 'granted',
        folders: [
          folder('Music/clasic', { songs: 104 }),
          folder('Music/P2P', { songs: 35 }),
          whatsapp,
        ],
      }),
      actions,
    );
    press('Open this phone');
    expect(actions.look).toHaveBeenCalledTimes(1);
    expect(words()).toContain('LOOKS LIKE VOICE NOTES');
    expect(labels()).toContain('Bring in 139 songs');
    press('P2P, brought in');
    expect(labels()).toContain('Bring in 104 songs');
    press('Bring in 104 songs');
    expect(actions.bringIn).toHaveBeenCalledWith(
      new Set([`${ROOT}/Music/P2P`, whatsapp.path]),
    );
    await Renderer.act(async () => {});
    Renderer.act(() => tree.unmount());
  });

  it("opens a kept folder's page, its albums, and leaves it out held", () => {
    jest.useFakeTimers();
    try {
      const actions = phoneActions();
      const path = `${ROOT}/Music/clasic`;
      const albumKey = `|goldberg|${path}`;
      const { press, words, labels, tree } = render(
        {},
        deviceState({
          permission: 'granted',
          library: {
            songs: [
              {
                id: 'd1',
                mediaId: 1,
                path: `${path}/a.mp3`,
                size: 1,
                headSha256: '0'.repeat(64),
                durationMs: 1,
                mime: null,
                title: 'Aria',
                titleFromTag: true,
                artist: 'Bach',
                albumArtist: null,
                disc: null,
                track: null,
                year: null,
                date: null,
                genre: null,
                albumKey,
                addedAtMs: 0,
                importedAtMs: 0,
                missingSinceMs: null,
              },
            ],
            albums: [
              {
                key: albumKey,
                title: 'Goldberg',
                artist: 'Bach',
                year: null,
                folder: path,
                artwork: null,
              },
            ],
            tags: new Map(),
            generations: new Map(),
            excludedFolders: [],
          },
          folders: [folder('Music/clasic', { status: 'kept', songs: 1 })],
        }),
        actions,
      );
      press('Open this phone');
      press('Open clasic');
      expect(labels()).toContain('Back to this phone');
      expect(words()).toContain('MUSIC/CLASIC · 1 SONG');
      expect(words()).toContain('HOLD · 1 LEAVE · FILES STAY');
      press('Open Goldberg');
      expect(actions.showAlbum).toHaveBeenCalledWith(albumKey);
      const strike = tree.root.find(
        n =>
          typeof n.type !== 'string' &&
          typeof n.props.onPressIn === 'function' &&
          n.props.accessibilityLabel === 'Leave this folder out',
      );
      Renderer.act(() => strike.props.onPressIn());
      Renderer.act(() => {
        jest.advanceTimersByTime(STRIKE_KNOBS.HOLD_MS);
      });
      expect(actions.leaveOut).toHaveBeenCalledWith(path);
      Renderer.act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it("opens on the phone's page from the empty field", () => {
    const { words, labels } = render(
      {},
      deviceState(),
      phoneActions(),
      'phone',
    );
    expect(labels()).toContain('Back to nodes');
    expect(words()).toContain('ANDROID WILL ASK');
  });
});
