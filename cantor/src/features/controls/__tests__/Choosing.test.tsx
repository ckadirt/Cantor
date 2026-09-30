import React from 'react';
import * as Renderer from 'react-test-renderer';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Choice, declaredStep, Ruler } from '../Choosing';
import { groupDeclared } from '../../composer/ModelParams';
import type { ModelParameter } from '../../../../../protocol/ModelParameter';

function render(element: React.ReactElement) {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <GestureHandlerRootView>{element}</GestureHandlerRootView>,
    );
  });
  const words = () =>
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
  const press = (label: string) =>
    Renderer.act(() =>
      tree.root
        .find(
          node =>
            typeof node.type !== 'string' &&
            typeof node.props.onPress === 'function' &&
            node.props.accessibilityLabel === label,
        )
        .props.onPress(),
    );
  return { tree, words, press };
}

const items = [
  { key: 'a', label: 'agentbox', accessibilityLabel: 'Run it on agentbox' },
  { key: 'h', label: 'h100', accessibilityLabel: 'Run it on h100' },
  {
    key: 'r',
    label: 'rtx6000',
    accessibilityLabel: 'Run it on rtx6000',
    quiet: true,
    state: 'offline',
  },
];

describe('a choice of names', () => {
  it('reads as a fact with its alternatives whispered, and opens to pick', () => {
    const onSelect = jest.fn();
    const { words, press } = render(
      <Choice activeKey="a" empty="none" items={items} onSelect={onSelect} />,
    );
    expect(words()).toContain('agentbox');
    expect(words()).toContain('OR H100 · RTX6000');
    press('agentbox, tap to change');
    // Offline stays listed, with its state.
    expect(words()).toContain('OFFLINE');
    press('Run it on h100');
    expect(onSelect).toHaveBeenCalledWith('h');
  });

  it('states a single option rather than offering it', () => {
    const { words } = render(
      <Choice
        activeKey={null}
        empty="none"
        items={items.slice(0, 1)}
        onSelect={jest.fn()}
      />,
    );
    expect(words()).toContain('agentbox');
    expect(words().some(word => word.startsWith('OR '))).toBe(false);
  });
});

describe('a ruler', () => {
  it('steps by accessibility actions, as a finger steps along it', () => {
    const onSelect = jest.fn();
    const { tree } = render(
      <Ruler
        auto
        activeKey="auto"
        onSelect={onSelect}
        stops={[
          { key: 'auto', accessibilityLabel: 'auto' },
          { key: '30', accessibilityLabel: '30 seconds' },
        ]}
      />,
    );
    const ruler = tree.root.find(
      node =>
        node.props.accessibilityRole === 'adjustable' &&
        typeof node.type !== 'string',
    );
    Renderer.act(() =>
      ruler.props.onAccessibilityAction({
        nativeEvent: { actionName: 'increment' },
      }),
    );
    expect(onSelect).toHaveBeenCalledWith('30');
  });
});

describe('declared numbers and labels', () => {
  it('picks a step about forty wide when none is declared', () => {
    expect(declaredStep('integer', 1, 60, undefined)).toBe(1);
    expect(declaredStep('number', 0, 10, undefined)).toBe(0.25);
    expect(declaredStep('number', 0, 2, 0.05)).toBe(0.05);
  });

  it('groups labels that share a first word, in declared order', () => {
    const number = (key: string, label: string): ModelParameter => ({
      kind: 'number',
      key,
      label,
      default: 1,
      minimum: 0,
      maximum: 2,
    });
    const groups = groupDeclared([
      number('steps', 'Steps'),
      number('lt', 'Lyric temperature'),
      number('cfg', 'Guidance'),
      number('lg', 'Lyric guidance'),
    ]);
    expect(groups.map(group => group.word)).toEqual([
      'Steps',
      'Lyric',
      'Guidance',
    ]);
    expect(groups[1].members.map(member => member.key)).toEqual(['lt', 'lg']);
  });
});
