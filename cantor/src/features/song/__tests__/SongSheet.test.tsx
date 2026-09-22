import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { SongSheet } from '../SongSheet';
import type { SongDetail, SongHeader } from '../../../core/protocol';

// CanvasKit's system font manager is empty under Jest, so the header's name
// morph has no face to lay out. The rest of the sheet is plain React.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
}));

const song = (over: Partial<SongHeader> = {}): SongHeader =>
  ({
    id: '1f2e3d4c-5b6a-4978-8765-4321abcdef00',
    title: 'Lanterns',
    model: 'acestep:1.5-fast',
    seed: 41822,
    duration_ms: 192_000,
    created_at: '2026-08-10T21:14:00Z',
    tags: ['p/Dog walk', 'p/Birthday', 'ambient'],
    favorite: false,
    trashed: false,
    artifacts: [],
    ...over,
  }) as SongHeader;

const detail = (): SongDetail =>
  ({
    song: song(),
    generation: { caption: 'a slow harbour at dusk', steps: 8, cfg: 3 },
    engine: 'acestep',
    component_digests: ['bdaf9e292d44aaaa'],
    attempts: 1,
  }) as SongDetail;

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

function render(over: Partial<React.ComponentProps<typeof SongSheet>> = {}) {
  const props: React.ComponentProps<typeof SongSheet> = {
    visible: true,
    song: song(),
    nodeLabel: 'agentbox',
    audioState: 'cached',
    detail: detail(),
    detailError: null,
    problem: null,
    acting: null,
    onClose: jest.fn(),
    onPatch: jest.fn(async () => {}),
    knownPlaylists: ['Dog walk', 'Birthday', 'Focus'],
    knownTags: ['ambient', 'loud'],
    playlistProblem: () => null,
    tagProblem: () => null,
    scopeLabel: 'Dog walk',
    placementCount: 3,
    deliveryBytes: 3_200_000,
    masterBytes: 28_600_000,
    onPin: jest.fn(),
    onUnpin: jest.fn(),
    onRemoveDownload: jest.fn(),
    onDelete: jest.fn(),
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<SongSheet {...props} />);
  });
  const words = () =>
    tree.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
  const labels = () =>
    tree.root
      .findAll(node => typeof node.props.accessibilityLabel === 'string')
      .map(node => node.props.accessibilityLabel as string);
  const press = (label: string) =>
    ReactTestRenderer.act(() => {
      tree.root
        .find(
          node =>
            typeof node.type !== 'string' &&
            typeof node.props.onPress === 'function' &&
            node.props.accessibilityLabel === label,
        )
        .props.onPress();
    });
  mounted.push(tree);
  return { tree, props, words, labels, press };
}

describe('SongSheet', () => {
  it('names the mark it opened on and how many the song has', () => {
    const { words } = render();
    expect(words()).toContain('FROM DOG WALK · 3 PLACEMENTS');
  });

  it('keeps the destructive act off the page you land on', () => {
    const { labels, words } = render();
    expect(words()).not.toContain('Delete it');
    // The foot's act is drawn as geometry so it can become its opposite; its
    // name is on the control rather than in a Text node.
    expect(labels()).toContain('Keep it here');
  });

  it('offers one act that turns over, not two that take turns', () => {
    const { labels, press, props } = render({ audioState: 'pinned' });
    expect(labels()).toContain('Unpin');
    expect(labels()).not.toContain('Keep it here');
    press('Unpin');
    expect(props.onUnpin).toHaveBeenCalled();
    expect(props.onPin).not.toHaveBeenCalled();
  });

  it('asks before it deletes, and says what goes on both machines', () => {
    const { words, press, props } = render();
    press('Delete everywhere');
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(words()).toContain('THERE IS NO UNDO');
    press('Delete it');
    expect(props.onDelete).toHaveBeenCalled();
  });

  it('states both sizes, because only this act frees space on both', () => {
    const { words } = render();
    expect(words()).toContain('3.1 MB HERE · 27 MB ON AGENTBOX');
  });

  it('never claims a copy here for a song that is only on the node', () => {
    // Where the audio is is a state that becomes the next state rather than
    // being replaced, so both of its lines are drawn as glyphs; the pair
    // carries one label, which is what a screen reader is given.
    const { labels, words } = render({ audioState: 'remote' });
    expect(labels()).toContain(
      'On agentbox only. 3.1 MB TO FETCH · ON AGENTBOX',
    );
    expect(words()).toContain('27 MB ON AGENTBOX');
    expect(words()).not.toContain('3.1 MB HERE · 27 MB ON AGENTBOX');
  });

  it('says where a kept copy is, in the same line that said it was cached', () => {
    expect(render({ audioState: 'cached' }).labels()).toContain(
      'Cached on this phone. 3.1 MB HERE · ON AGENTBOX',
    );
    expect(render({ audioState: 'pinned' }).labels()).toContain(
      'Downloaded on this phone. 3.1 MB HERE · ON AGENTBOX',
    );
  });

  it('offers to remove a local copy only when there is one', () => {
    expect(render({ audioState: 'cached' }).labels()).toContain(
      'Remove from this phone',
    );
    expect(render({ audioState: 'remote' }).labels()).not.toContain(
      'Remove from this phone',
    );
  });

  it('toggles a playlist rather than offering to leave one', async () => {
    const { labels, press, props } = render();
    expect(labels()).not.toContain('Remove from Dog walk. KEEPS THE SONG');
    press('Remove from Dog walk');
    expect(props.onPatch).toHaveBeenCalledWith({
      tags: ['p/Birthday', 'ambient'],
    });
    // Let the queue notice the wire is free again before the tree goes away.
    await ReactTestRenderer.act(async () => {});
  });

  it('draws a membership the moment it is asked for, not when it lands', () => {
    // The node is never allowed to answer here, so anything the sheet shows is
    // something it decided to show on the strength of the tap alone.
    const { labels, press } = render({ onPatch: jest.fn(() => new Promise<void>(() => {})) });
    expect(labels()).toContain('Remove from Dog walk');
    press('Remove from Dog walk');
    expect(labels()).toContain('Add to Dog walk');
    expect(labels()).not.toContain('Remove from Dog walk');
  });

  it('keeps one patch on the wire and folds the rest into it', async () => {
    // Two patches in flight on one song is the fault `expected_revision`
    // exists to catch: the second would carry a revision the node has already
    // replaced, and a tag list computed without the first tag in it.
    let release: () => void = () => {};
    const onPatch = jest.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    const { press } = render({ onPatch });
    press('Remove from Dog walk');
    press('Remove from Birthday');
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenLastCalledWith({ tags: ['p/Birthday', 'ambient'] });
    await ReactTestRenderer.act(async () => {
      release();
    });
    expect(onPatch).toHaveBeenCalledTimes(2);
    expect(onPatch).toHaveBeenLastCalledWith({ tags: ['ambient'] });
  });

  it('puts the mark back when the node refuses the ask', async () => {
    const onPatch = jest.fn(async () => {
      throw new Error('Backend is not ready.');
    });
    const { labels, press } = render({ onPatch });
    press('Remove from Dog walk');
    expect(labels()).toContain('Add to Dog walk');
    await ReactTestRenderer.act(async () => {});
    expect(labels()).toContain('Remove from Dog walk');
  });

  it('stops drawing an ask once the node has agreed with it', async () => {
    const { labels, press, props, tree } = render();
    press('Remove from Dog walk');
    await ReactTestRenderer.act(async () => {});
    // The node's own header arrives without the playlist. Nothing should move:
    // the sheet has been drawing this since the tap.
    ReactTestRenderer.act(() => {
      tree.update(
        <SongSheet {...props} song={song({ tags: ['p/Birthday', 'ambient'] })} />,
      );
    });
    expect(labels()).toContain('Add to Dog walk');
    expect(props.onPatch).toHaveBeenCalledTimes(1);
  });

  it('carries the model own declared parameters', () => {
    const { words } = render();
    expect(words()).toContain('8');
    expect(words()).toContain('a slow harbour at dusk');
  });

  it('says a refused act where the acts are, not on the other page', () => {
    const { words } = render({ problem: 'Backend is not ready.' });
    expect(words()).toContain('BACKEND IS NOT READY.');
  });

  it('lets the act you pressed work while the rest go out of reach', () => {
    const { tree } = render({ acting: 'pin' });
    // The outermost control carrying the label: a working act has no press
    // handler to find it by, which is the point.
    const act = (label: string) =>
      tree.root.findAll(
        node =>
          typeof node.type !== 'string' &&
          node.props.accessibilityRole === 'button' &&
          node.props.accessibilityLabel === label,
      )[0];
    // The pressed act is busy, not disabled: it keeps its ink and says it is
    // working. It cannot be pressed twice, but it is the one thing that is
    // doing something, and going grey would say the opposite.
    const keep = act('Keep it here');
    expect(keep.props.accessibilityState).toEqual({
      disabled: false,
      busy: true,
    });
    expect(keep.props.onPress).toBeUndefined();
    // Its neighbour is simply out of reach.
    const remove = act('Remove from this phone');
    expect(remove.props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
  });

  it('never marks one act as both working and out of reach', () => {
    for (const acting of ['pin', 'unpin', 'remove', 'delete', null] as const) {
      const { tree } = render({ acting, audioState: 'cached' });
      const states = tree.root
        .findAll(
          node =>
            typeof node.type !== 'string' &&
            node.props.accessibilityRole === 'button' &&
            node.props.accessibilityState?.busy !== undefined,
        )
        .map(node => node.props.accessibilityState);
      for (const state of states) {
        expect(state.disabled && state.busy).toBe(false);
      }
    }
  });

  it('stays honest while the node has not answered', () => {
    const { words } = render({ detail: null });
    expect(words()).toContain('Asking agentbox…');
  });
});
