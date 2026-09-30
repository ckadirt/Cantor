import React from 'react';
import { Text } from 'react-native';
import * as Renderer from 'react-test-renderer';
import { Door, isState, Row, RowAct } from '../Ledger';

function render(element: React.ReactElement) {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(element);
  });
  return tree;
}

const words = (tree: Renderer.ReactTestRenderer) =>
  tree.root
    .findAll(node => typeof node.props.children === 'string')
    .map(node => node.props.children as string);

describe('the three inks', () => {
  it('sets a short note as a state and a longer one as a sentence', () => {
    expect(isState('3 kept')).toBe(true);
    expect(isState('This will be instrumental')).toBe(true);
    expect(isState('Choose where it runs first.')).toBe(false);
    expect(isState('The model writes the lyrics')).toBe(false);
    expect(isState('10 SONGS · NEVER RECLAIMED')).toBe(true);
    expect(isState('10 kept here · 8 cached')).toBe(true);
  });

  it('never wraps a label: a long one moves into the value column', () => {
    const short = render(
      <Row label="Songs">
        <Text>26</Text>
      </Row>,
    );
    expect(words(short)).toContain('SONGS');
    const long = render(
      <Row label="minimax-music3">
        <Text>1.0-fast</Text>
      </Row>,
    );
    const labels = long.root.findAll(
      node => node.props.children === 'MINIMAX-MUSIC3',
    );
    expect(labels.length).toBeGreaterThan(0);
    // The label column is left empty rather than cut.
    expect(words(long)).toContain('');
  });

  it('writes a sentence note in its own case', () => {
    const tree = render(
      <Row label="Model" note="Choose where it runs first.">
        <Text>none</Text>
      </Row>,
    );
    expect(words(tree)).toContain('Choose where it runs first.');
    expect(words(tree)).not.toContain('CHOOSE WHERE IT RUNS FIRST.');
  });

  it('opens a door and refuses a second press of a working act', () => {
    const open = jest.fn();
    const door = render(<Door label="Settings" onPress={open} />);
    Renderer.act(() =>
      door.root
        .find(
          node =>
            node.props.accessibilityLabel === 'Settings' &&
            typeof node.props.onPress === 'function',
        )
        .props.onPress(),
    );
    expect(open).toHaveBeenCalledTimes(1);

    const act = jest.fn();
    const busy = render(<RowAct label="Pair a node" onPress={act} working />);
    const target = busy.root.find(
      node =>
        node.props.accessibilityLabel === 'Pair a node' &&
        node.props.accessibilityState !== undefined &&
        typeof node.type !== 'string',
    );
    expect(target.props.onPress).toBeUndefined();
    expect(target.props.accessibilityState).toEqual({
      disabled: false,
      busy: true,
    });
  });
});
