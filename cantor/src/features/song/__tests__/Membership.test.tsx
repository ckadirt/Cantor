import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { Membership, type MembershipEntry } from '../Membership';

const entries: MembershipEntry[] = [
  { name: 'Dog walk', member: true },
  { name: 'Birthday', member: true },
  { name: 'Focus', member: false },
];

function render(over: Partial<React.ComponentProps<typeof Membership>> = {}) {
  const props: React.ComponentProps<typeof Membership> = {
    entries,
    flow: 'column',
    busy: false,
    full: false,
    addPlaceholder: 'new playlist',
    onToggle: jest.fn(),
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Membership {...props} />);
  });
  const pressable = (label: string) =>
    tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.onPress === 'function' &&
        node.props.accessibilityLabel === label,
    );
  const press = (label: string) =>
    ReactTestRenderer.act(() => {
      pressable(label).props.onPress();
    });
  const labels = () =>
    tree.root
      .findAll(node => typeof node.props.accessibilityLabel === 'string')
      .map(node => node.props.accessibilityLabel as string);
  return { tree, props, press, labels, pressable };
}

describe('Membership', () => {
  it('draws only the names the song holds until it is peeled open', () => {
    const { labels, press } = render();
    expect(labels()).toContain('Remove from Dog walk');
    expect(labels()).not.toContain('Add to Focus');
    press('Show every name');
    expect(labels()).toContain('Add to Focus');
  });

  it('toggles a held name off and an unheld name on', () => {
    const { press, props } = render();
    press('Remove from Dog walk');
    expect(props.onToggle).toHaveBeenCalledWith('Dog walk', false);
    press('Show every name');
    press('Add to Focus');
    expect(props.onToggle).toHaveBeenCalledWith('Focus', true);
  });

  it('refuses to add when the song is at the node bound', () => {
    const { press, pressable } = render({ full: true });
    press('Show every name');
    expect(pressable('Add to Focus').props.disabled).toBe(true);
  });

  it('says so plainly when a song holds nothing yet', () => {
    const { tree } = render({ entries: [{ name: 'Focus', member: false }] });
    const words = tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(words).toContain('In no playlist.');
  });
});
