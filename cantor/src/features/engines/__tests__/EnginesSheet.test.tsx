import React from 'react';
import * as Renderer from 'react-test-renderer';
import fixture from '../../../../../protocol/fixtures/v2/node-info.json';
import type { NodeInfo } from '../../../core/protocol';
import type { BackendRecord } from '../../../backends/types';
import { EnginesSheet } from '../EnginesSheet';

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
function render() {
  const onForget = jest.fn();
  const onChangeBudget = jest.fn();
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <EnginesSheet
        backends={[
          backend('studio', 'acestep:1.5-fast'),
          backend('phone', 'levo2:1.0-fast'),
        ]}
        snapshots={{}}
        footprints={{}}
        refreshing={false}
        onClose={jest.fn()}
        onPair={jest.fn()}
        onRefresh={jest.fn()}
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
  return { tree, press, words, onForget, onChangeBudget };
}

describe('Ledger engine pages', () => {
  it('keeps the growing model list behind a node-scoped door', () => {
    const { press, words } = render();
    expect(words()).not.toContain('acestep:1.5-fast');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
    press('All models on studio');
    expect(words()).toContain('1.5-fast');
    expect(words()).toContain('KNOWN ELSEWHERE');
    press('Model levo2:1.0-fast');
    expect(words()).toContain('cantor pull levo2:1.0-fast');
    press('Back to engines');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
    press('All models on phone');
    press('Model levo2:1.0-fast');
    expect(words()).not.toContain('cantor pull levo2:1.0-fast');
  });

  it('retains the explicit forget confirmation and correct node', () => {
    const { press, onForget } = render();
    press('Forget studio');
    expect(onForget).not.toHaveBeenCalled();
    press('Keep it');
    expect(onForget).not.toHaveBeenCalled();
    press('Forget phone');
    press('Forget it');
    expect(onForget).toHaveBeenCalledWith('phone');
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
    press('Back to engines');
    expect(words()).toContain('ENGINES');
  });
});
