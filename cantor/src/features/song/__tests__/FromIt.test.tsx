import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { FromIt, type SongAudioActs } from '../FromIt';

function render(acts: SongAudioActs) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<FromIt acts={acts} disabled={false} />);
  });
  // Host text only: the composite `Text` carries the same string again.
  const words = () =>
    tree.root
      .findAll(
        node =>
          typeof node.type === 'string' &&
          typeof node.props.children === 'string',
      )
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
    const { words, press } = render({
      version: ready,
      longer: ready,
      nodeLabel: 'agentbox',
      onAct,
    });
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

  const fast = {
    kind: 'no-model' as const,
    catalogKnown: true,
    suggestion: {
      selector: 'acestep:1.5-fast',
      family: 'acestep',
      capabilities: ['cover' as const, 'extend' as const, 'timbre' as const],
      bytes: 3_300_000_000,
      licence: 'Apache-2.0',
    },
  };

  it('gives acts shut for one reason one door, and one command', () => {
    const onAct = jest.fn();
    const { words, press } = render({
      version: fast,
      longer: fast,
      nodeLabel: 'agentbox',
      onAct,
    });
    expect(words()).toEqual(
      expect.arrayContaining(['A version · Longer', 'NOT ON AGENTBOX YET']),
    );
    expect(words()).not.toContain('cantor pull acestep:1.5-fast');
    press('A version · Longer: not on agentbox yet');
    const opened = words();
    expect(
      opened.filter(word => word === 'cantor pull acestep:1.5-fast'),
    ).toHaveLength(1);
    expect(opened).toContain('ACESTEP 1.5 FAST · 3.3 GB');
    expect(onAct).not.toHaveBeenCalled();
  });

  it('lists each distinct command once, and finds what could when the catalog is unknown', () => {
    const { words, press } = render({
      version: fast,
      longer: { kind: 'no-model', catalogKnown: false, suggestion: null },
      nodeLabel: 'agentbox',
      onAct: jest.fn(),
    });
    press('A version · Longer: not on agentbox yet');
    expect(words()).toEqual(
      expect.arrayContaining([
        'cantor pull acestep:1.5-fast',
        'cantor list --all --can extend',
        'LISTS WHAT COULD',
      ]),
    );
  });

  it('keeps an act that can apart from one that cannot', () => {
    const onAct = jest.fn();
    const { words, press } = render({
      version: ready,
      longer: fast,
      nodeLabel: 'agentbox',
      onAct,
    });
    expect(words()).toEqual(
      expect.arrayContaining([
        'A version',
        'THE SAME SONG, CHANGED',
        'Longer',
        'NOT ON AGENTBOX YET',
      ]),
    );
    expect(words().filter(word => word === 'FROM IT')).toHaveLength(1);
    press('A version');
    expect(onAct).toHaveBeenCalledWith('version');
  });

  it('lets the sheet make the command copyable', () => {
    const copy = jest.fn(
      (_value: string, _what: string, children: React.ReactNode) => children,
    );
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <FromIt
          acts={{
            version: fast,
            longer: fast,
            nodeLabel: 'agentbox',
            onAct: jest.fn(),
          }}
          copy={copy}
          disabled={false}
        />,
      );
    });
    const door = tree.root.find(
      node =>
        node.props.accessibilityLabel ===
          'A version · Longer: not on agentbox yet' &&
        typeof node.props.onPress === 'function',
    );
    ReactTestRenderer.act(() => door.props.onPress());
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]![0]).toBe('cantor pull acestep:1.5-fast');
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
