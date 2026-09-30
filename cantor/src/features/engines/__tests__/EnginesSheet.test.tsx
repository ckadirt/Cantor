import React from 'react';
import * as Renderer from 'react-test-renderer';
import fixture from '../../../../../protocol/fixtures/v2/node-info.json';
import type { NodeInfo } from '../../../core/protocol';
import type {
  BackendRecord,
  ConnectionSnapshot,
} from '../../../backends/types';
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

function render(snapshots: Record<string, ConnectionSnapshot> = {}) {
  const onForget = jest.fn();
  const onRefresh = jest.fn();
  const onChangeBudget = jest.fn();
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
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
      />,
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
  return { tree, press, words, onForget, onChangeBudget, onRefresh };
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

  it('retains the explicit forget confirmation and correct node', () => {
    const { press, onForget, words } = render();
    press('Open studio');
    press('Forget studio');
    expect(onForget).not.toHaveBeenCalled();
    press('Keep it');
    // Keeping it goes back to the node it was about, not to the roster.
    expect(words()).toContain('Forget this node');
    expect(onForget).not.toHaveBeenCalled();
    press('Back to nodes');
    press('Open phone');
    press('Forget phone');
    press('Forget it');
    expect(onForget).toHaveBeenCalledWith('phone');
  });

  it("says each node's state as a person would, and syncs on opening", () => {
    const { words, onRefresh } = render({
      studio: { ...snapshot, phase: 'ready' },
      phone: { ...snapshot, phase: 'handshaking' },
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(words()).toContain('Two nodes');
    expect(words()).toContain('ONE READY · 0 SONGS');
    expect(words()).toContain('READY');
    expect(words()).toContain('CONNECTING');
    expect(words()).not.toContain('handshaking');
    expect(words()).not.toContain('Refresh libraries');
    expect(words()).toContain('Pair a node');
  });

  it('changes only the cache budget from settings and returns', () => {
    const { press, words, onChangeBudget, onForget } = render();
    press('Settings');
    expect(words()).toEqual(
      expect.arrayContaining(['DOWNLOADED', 'CACHED', 'PLACEMENTS']),
    );
    press('Budget 2 GB');
    expect(onChangeBudget).toHaveBeenCalledWith(2 * 1024 ** 3);
    expect(onForget).not.toHaveBeenCalled();
    press('Back to nodes');
    expect(words()).toContain('NODES');
  });
});
