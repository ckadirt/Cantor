import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { Membership, type MembershipEntry } from '../Membership';

const entries: MembershipEntry[] = [
  { name: 'Dog walk', member: true },
  { name: 'Birthday', member: true },
  { name: 'Focus', member: false },
];

/**
 * Every tree this file mounts, torn down after each test.
 *
 * A membership mark holds a timer open for as long as its ink could still be
 * animating — see `useInk` — so a tree left mounted fires it after Jest has
 * taken the environment away, which reads as a crash in a component that was
 * fine.
 */
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  for (const tree of mounted.splice(0)) {
    ReactTestRenderer.act(() => tree.unmount());
  }
});

function render(over: Partial<React.ComponentProps<typeof Membership>> = {}) {
  const props: React.ComponentProps<typeof Membership> = {
    entries,
    busy: false,
    full: false,
    addPlaceholder: 'new playlist',
    empty: 'In no playlist.',
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
  /**
   * The labels a finger or a screen reader can actually get to.
   *
   * Every name keeps its seat whether or not the peel is open — that is what
   * lets a chosen one stay where it is — so `labels()` alone can no longer say
   * what the block is offering. A folded seat hides its contents, and this
   * walks the tree the way the platform does: past a hidden subtree.
   */
  const reachable = () => {
    const out: string[] = [];
    const walk = (node: ReactTestRenderer.ReactTestInstance) => {
      if (node.props?.accessibilityElementsHidden === true) return;
      const label = node.props?.accessibilityLabel;
      if (typeof label === 'string') out.push(label);
      for (const child of node.children) {
        if (typeof child !== 'string') walk(child);
      }
    };
    walk(tree.root);
    return out;
  };
  mounted.push(tree);
  return { tree, props, press, labels, pressable, reachable };
}

describe('Membership', () => {
  it('draws only the names the song holds until it is peeled open', () => {
    const { reachable, press } = render();
    expect(reachable()).toContain('Remove from Dog walk');
    expect(reachable()).not.toContain('Add to Focus');
    press('Show every name');
    expect(reachable()).toContain('Add to Focus');
  });

  it('keeps a name in one seat, so choosing it moves nothing', () => {
    const { labels, press, tree, props } = render();
    press('Show every name');
    const once = (prefix: string) => [
      ...new Set(labels().filter(label => label.startsWith(prefix))),
    ];
    const before = once('Add to');
    expect(before).toEqual(['Add to Focus']);
    // The song now holds Focus; the list is rebuilt with it at the front.
    ReactTestRenderer.act(() => {
      tree.update(
        <Membership
          {...props}
          entries={[
            { name: 'Focus', member: true },
            { name: 'Dog walk', member: true },
            { name: 'Birthday', member: true },
          ]}
        />,
      );
    });
    const names = once('Remove from');
    expect(names).toEqual([
      'Remove from Dog walk',
      'Remove from Birthday',
      'Remove from Focus',
    ]);
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

  it('says an unanswered membership in the mark, not by taking the name away', () => {
    const { pressable } = render({ pendingOf: name => name === 'Dog walk' });
    const waiting = pressable('Remove from Dog walk');
    // The mark carries the waiting; the control stays live, because the queue
    // behind it takes a second tap rather than needing to be protected from one.
    expect(waiting.props.accessibilityState).toMatchObject({ busy: true });
    expect(waiting.props.disabled).toBe(false);
    expect(
      pressable('Remove from Birthday').props.accessibilityState,
    ).toMatchObject({ busy: false });
  });

  it('says so plainly when a song holds nothing yet', () => {
    const { tree } = render({ entries: [{ name: 'Focus', member: false }] });
    const words = tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(words).toContain('In no playlist.');
  });
});
