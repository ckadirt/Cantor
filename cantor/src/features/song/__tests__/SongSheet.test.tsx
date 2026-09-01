import React from 'react';
import * as ReactTestRenderer from 'react-test-renderer';
import { SongSheet } from '../SongSheet';
import type { SongHeader } from '../../../core/protocol';

const song = (over: Partial<SongHeader> = {}): SongHeader =>
  ({
    id: '1f2e3d4c-5b6a-4978-8765-4321abcdef00',
    title: 'Lanterns',
    model: 'acestep:1.5-fast',
    seed: 41822,
    duration_ms: 192_000,
    created_at: '2026-08-10T00:00:00Z',
    tags: ['p/Late Night', 'p/Keep', 'p/Drive', 'ambient'],
    favorite: false,
    trashed: false,
    artifacts: [],
    ...over,
  }) as SongHeader;

function render(over: Partial<React.ComponentProps<typeof SongSheet>> = {}) {
  const props: React.ComponentProps<typeof SongSheet> = {
    visible: true,
    song: song(),
    nodeLabel: 'agentbox',
    audioState: 'pinned',
    detail: null,
    detailError: null,
    busy: false,
    onClose: jest.fn(),
    onRename: jest.fn(),
    onToggleFavourite: jest.fn(),
    onAddTag: jest.fn(),
    playlists: null,
    onRemoveTag: jest.fn(),
    scopeLabel: 'Late Night',
    placementCount: 3,
    playlistCount: 3,
    scopePlaylist: 'Late Night',
    onRemoveFromScope: jest.fn(),
    downloadedBytes: 34 * 1024 * 1024,
    onTrash: jest.fn(),
    onPin: jest.fn(),
    onUnpin: jest.fn(),
    onRemoveDownload: jest.fn(),
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
  const press = (label: string) => {
    const target = tree.root.find(
      node =>
        typeof node.type !== 'string' &&
        typeof node.props.onPress === 'function' &&
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(label),
    );
    ReactTestRenderer.act(() => target.props.onPress());
  };
  return { props, words, press };
}

describe('the song sheet names what it is about to act on', () => {
  it('says which mark was held and how many others the song has', () => {
    const { words } = render();

    expect(words()).toContain('FROM · LATE NIGHT');
    expect(words()).toContain('IN 3 PLAYLISTS · 3 PLACEMENTS');
  });

  it('counts a song in one place without pluralising it into three', () => {
    const { words } = render({
      placementCount: 1,
      playlistCount: 0,
      scopePlaylist: null,
    });

    expect(words()).toContain('IN NO PLAYLIST · 1 PLACEMENT');
  });

  it('keeps leaving a playlist and destroying a song apart, and says what each costs', () => {
    const { props, words, press } = render();

    expect(words()).toContain('KEEPS THE SONG · 2 MARKS REMAIN');
    expect(words()).toContain('EVERY PLACEMENT · 3 MARKS GO AT ONCE');
    expect(words()).toContain('FREES 34 MB · STAYS ON AGENTBOX');

    press('Remove from Late Night');
    expect(props.onRemoveFromScope).toHaveBeenCalledTimes(1);
    expect(props.onTrash).not.toHaveBeenCalled();
  });

  it('never trashes on one press', () => {
    const { props, press, words } = render();

    press('Trash the song');
    expect(props.onTrash).not.toHaveBeenCalled();
    // The sheet now asks, and offers the way out first.
    expect(words()).toContain('Keep it');

    press('Trash the song');
    expect(props.onTrash).toHaveBeenCalledTimes(1);
  });

  it('forgets a half-pressed confirmation when it opens on another song', () => {
    const { props, press, words } = render();
    press('Trash the song');
    expect(words()).toContain('Keep it');

    ReactTestRenderer.act(() => {});
    const again = render({ song: song({ id: 'other', title: 'Foxes' }) });
    expect(again.words()).not.toContain('Keep it');
    expect(props.onTrash).not.toHaveBeenCalled();
  });
});
