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

function render(over: Partial<React.ComponentProps<typeof SongSheet>> = {}) {
  const props: React.ComponentProps<typeof SongSheet> = {
    visible: true,
    song: song(),
    nodeLabel: 'agentbox',
    audioState: 'cached',
    detail: detail(),
    detailError: null,
    problem: null,
    busy: false,
    onClose: jest.fn(),
    onRename: jest.fn(),
    onToggleFavourite: jest.fn(),
    knownPlaylists: ['Dog walk', 'Birthday', 'Focus'],
    knownTags: ['ambient', 'loud'],
    onTogglePlaylist: jest.fn(),
    onToggleTag: jest.fn(),
    full: false,
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
    const { words } = render({ audioState: 'remote' });
    expect(words()).toContain('3.1 MB TO FETCH · ON AGENTBOX');
    expect(words()).toContain('27 MB ON AGENTBOX');
    expect(words()).not.toContain('3.1 MB HERE · 27 MB ON AGENTBOX');
  });

  it('offers to remove a local copy only when there is one', () => {
    expect(render({ audioState: 'cached' }).labels()).toContain(
      'Remove from this phone',
    );
    expect(render({ audioState: 'remote' }).labels()).not.toContain(
      'Remove from this phone',
    );
  });

  it('toggles a playlist rather than offering to leave one', () => {
    const { labels, press, props } = render();
    expect(labels()).not.toContain('Remove from Dog walk. KEEPS THE SONG');
    press('Remove from Dog walk');
    expect(props.onTogglePlaylist).toHaveBeenCalledWith('Dog walk', false);
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

  it('stays honest while the node has not answered', () => {
    const { words } = render({ detail: null });
    expect(words()).toContain('Asking agentbox…');
  });
});
