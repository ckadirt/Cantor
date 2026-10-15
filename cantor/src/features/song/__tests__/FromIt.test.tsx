import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { FromIt, type SongAudioActs } from '../FromIt';

function render(acts: SongAudioActs) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<FromIt acts={acts} disabled={false} />);
  });
  const words = () =>
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
  const press = (label: string) => {
    const target = tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === label,
    );
    ReactTestRenderer.act(() => target.props.onPress());
  };
  return { tree, words, press };
}

const ready = { kind: 'ready' as const, models: [] };

describe('From it', () => {
  it('offers both acts on a node that can, and says what each makes', () => {
    const onAct = jest.fn();
    const { words, press } = render({ version: ready, longer: ready, nodeLabel: 'agentbox', onAct });
    expect(words()).toEqual(
      expect.arrayContaining(['A version', 'THE SAME SONG, CHANGED', 'Longer']),
    );
    press('Longer');
    expect(onAct).toHaveBeenCalledWith('longer');
  });

  it('holds with the fermata while the node is away', () => {
    const { words } = render({
      version: { kind: 'away' },
      longer: { kind: 'away' },
      nodeLabel: 'agentbox',
      onAct: jest.fn(),
    });
    expect(words()).toContain('AGENTBOX IS AWAY · THE SONG LIVES THERE');
  });

  it('turns a shut door into the model that would open it', () => {
    const onAct = jest.fn();
    const { words, press } = render({
      version: {
        kind: 'no-model',
        catalogKnown: true,
        suggestion: {
          selector: 'acestep:1.5-fast',
          family: 'acestep',
          capabilities: ['cover', 'extend', 'timbre'],
          bytes: 4_500_000_000,
          licence: 'Apache-2.0',
        },
      },
      longer: { kind: 'no-model', catalogKnown: false, suggestion: null },
      nodeLabel: 'agentbox',
      onAct,
    });
    expect(words()).toContain('NO MODEL ON AGENTBOX MAKES VERSIONS');
    expect(words()).not.toContain('cantor pull acestep:1.5-fast');
    press('A version: no model on agentbox can do this');
    expect(words()).toEqual(
      expect.arrayContaining([
        'acestep:1.5-fast can',
        'COVER · EXTEND · TIMBRE · 4.5 GB',
        'cantor pull acestep:1.5-fast',
      ]),
    );
    press('Longer: no model on agentbox can do this');
    expect(words()).toContain('cantor list --all --can extend');
    expect(onAct).not.toHaveBeenCalled();
  });

  it('draws nothing for a node that predates audio', () => {
    const { tree } = render({
      version: { kind: 'unsupported' },
      longer: { kind: 'unsupported' },
      nodeLabel: 'old',
      onAct: jest.fn(),
    });
    expect(tree.toJSON()).toBeNull();
  });
});
