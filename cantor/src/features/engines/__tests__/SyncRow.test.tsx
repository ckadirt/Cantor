import { GestureHandlerRootView } from 'react-native-gesture-handler';
import React from 'react';
import { Text } from 'react-native';
import * as Renderer from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';
import { SyncRow, type SyncSong } from '../SyncRow';
import { noteRoute, setSyncOffset, syncStore } from '../../../player/syncOffsets';

function render(song: SyncSong | null) {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <GestureHandlerRootView>
        <SyncRow song={song} />
      </GestureHandlerRootView>,
    );
  });
  return tree;
}

function words(tree: Renderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node => [node.props.children].flat().join(''))
    .join(' | ');
}

const position = { value: 10 } as SharedValue<number>;

describe('the sync row', () => {
  beforeEach(() => {
    for (const route of ['speaker', 'wired', 'usb', 'bluetooth', 'other'] as const) setSyncOffset(route, 0);
    syncStore.set(state => ({ ...state, route: null }));
  });

  it('asks for a song when nothing is playing', () => {
    expect(words(render(null))).toContain('Play a song');
  });

  it('says which output it sets, and how long the picture waits', () => {
    noteRoute('bluetooth');
    setSyncOffset('bluetooth', 30);
    const tree = render({ positionSeconds: position, beats: [0.5, 1, 1.5], playing: true });
    expect(words(tree)).toContain('+30 ms');
    expect(words(tree)).toContain('Bluetooth: the picture waits 230 ms');
  });

  it('will not be set by a beat it is not sure of', () => {
    noteRoute('speaker');
    expect(words(render({ positionSeconds: position, beats: null, playing: true }))).toContain('no beat sure enough');
  });

  it('moves the correction for the output in use, and only that one', () => {
    noteRoute('wired');
    const tree = render({ positionSeconds: position, beats: [1], playing: true });
    const ruler = tree.root.find(
      n => n.props.accessibilityRole === 'adjustable' && typeof n.type !== 'string',
    );
    expect(ruler.props.accessibilityLabel).toBe('Picture 0 milliseconds');
    Renderer.act(() => ruler.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(syncStore.get().offsets.wired).toBe(10);
    expect(syncStore.get().offsets.speaker).toBe(0);
  });
});
