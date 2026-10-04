import React from 'react';
import { StyleSheet } from 'react-native';
import * as Renderer from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';
import {
  REPRESENTATION_WINDOWS,
  bandAlphaAt,
  byTime,
  type Camera,
  type Level,
} from '../../../field';
import { nameLens } from '../../../lenses';
import { FieldOverlay, nowPlayingWord } from '../FieldOverlay';

// CanvasKit's system font manager is empty under Jest, so the header's
// morphing lines have no face to lay out; what is judged here is the views
// holding them.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
  useFontScaledStyle: (style: unknown) => style,
}));

const FIT = 0.5;

function shared<T>(value: T): SharedValue<T> {
  return { value } as SharedValue<T>;
}

/** The header's and foot's drawn opacity with the camera at `ratio`·FIT. */
function opacities(level: Level, ratio: number) {
  const camera: Camera = { x: 0, y: 0, scale: ratio * FIT };
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <FieldOverlay
        arrangementKey={byTime.key}
        cameraShared={shared(camera)}
        dateResolution="week"
        fitScaleShared={shared(FIT)}
        groupCount={3}
        groupLabel="This week"
        lens={nameLens}
        level={level}
        offline={false}
        onChangeArrangement={() => {}}
        onChangeDateResolution={() => {}}
        onChangeOrder={() => {}}
        onOpenComposer={() => {}}
        onOpenEngines={() => {}}
        onShelfAction={() => {}}
        orderKey="date"
        shelfAction={null}
        showLegend={false}
        mountLegend={false}
        songCount={8}
        storageError={null}
      />,
    );
  });
  const opacityOf = (testID: string) =>
    StyleSheet.flatten(tree.root.findByProps({ testID }).props.style).opacity;
  const result = {
    header: opacityOf('field-header'),
    foot: opacityOf('field-foot'),
  };
  Renderer.act(() => tree.unmount());
  return result;
}

describe('the header and the foot give the screen to the player', () => {
  it('are whole on the map and the shelf', () => {
    expect(opacities('field', 1)).toEqual({ header: 1, foot: 1 });
    expect(opacities('shelf', 5)).toEqual({ header: 1, foot: 1 });
  });

  /**
   * The fix. React's level is `song` from 13·FIT, but the player has only
   * begun to arrive there; the chrome used to be cut to nothing on that
   * commit. It leaves as the song band opens instead — one number, read from
   * the live camera.
   */
  it('leave on the song band, not on the level', () => {
    const ratio = 18;
    const song = bandAlphaAt(ratio * FIT, FIT, REPRESENTATION_WINDOWS.song);
    expect(song).toBeGreaterThan(0.05);
    expect(song).toBeLessThan(0.95);
    const drawn = opacities('song', ratio);
    expect(drawn.header).toBeCloseTo(1 - song, 6);
    expect(drawn.foot).toBeCloseTo(1 - song, 6);
  });

  it('are gone once the player has arrived, and past it', () => {
    expect(opacities('song', 30)).toEqual({ header: 0, foot: 0 });
    // The song band closes again at the grain; the chrome must not return.
    expect(opacities('grain', 500)).toEqual({ header: 0, foot: 0 });
  });
});

describe("the header's one act", () => {
  function render(level: Level, nowPlaying: string | null) {
    const onNowPlaying = jest.fn();
    const onShelfAction = jest.fn();
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <FieldOverlay
          arrangementKey={byTime.key}
          cameraShared={shared({ x: 0, y: 0, scale: FIT })}
          dateResolution="week"
          fitScaleShared={shared(FIT)}
          groupCount={3}
          groupLabel="This week"
          lens={nameLens}
          level={level}
          offline={false}
          onChangeArrangement={() => {}}
          onChangeDateResolution={() => {}}
          onChangeOrder={() => {}}
          onOpenComposer={() => {}}
          onOpenEngines={() => {}}
          onShelfAction={onShelfAction}
          shelfAction={level === 'shelf' ? 'DOWNLOAD ALL · 5 MB' : null}
          nowPlaying={nowPlaying}
          onNowPlaying={onNowPlaying}
          orderKey="date"
          showLegend={false}
          mountLegend={false}
          songCount={8}
          storageError={null}
        />,
      );
    });
    const slot = tree.root.findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.props.style !== undefined &&
        StyleSheet.flatten(node.props.style).width === 190,
    )[0];
    return { tree, slot, onNowPlaying, onShelfAction };
  }

  it('on the map, goes to the song the player holds', () => {
    const { tree, slot, onNowPlaying, onShelfAction } = render(
      'field',
      'NOW · BLOODFLOW',
    );
    expect(slot.props.accessibilityLabel).toBe('Go to NOW · BLOODFLOW');
    expect(slot.props.pointerEvents).toBe('auto');
    Renderer.act(() => slot.props.onPress());
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
    expect(onShelfAction).not.toHaveBeenCalled();
    Renderer.act(() => tree.unmount());
  });

  it('on the map with nothing held, is not there to press', () => {
    const { tree, slot } = render('field', null);
    expect(slot.props.pointerEvents).toBe('none');
    Renderer.act(() => tree.unmount());
  });

  it("inside a shelf, is still the shelf's own action", () => {
    const { tree, slot, onNowPlaying, onShelfAction } = render(
      'shelf',
      'NOW · BLOODFLOW',
    );
    expect(slot.props.accessibilityLabel).toBe('DOWNLOAD ALL · 5 MB');
    Renderer.act(() => slot.props.onPress());
    expect(onShelfAction).toHaveBeenCalledTimes(1);
    expect(onNowPlaying).not.toHaveBeenCalled();
    Renderer.act(() => tree.unmount());
  });
});

it('names the held song in a word that fits the count line', () => {
  expect(nowPlayingWord('NOW', 'Bloodflow')).toBe('NOW · BLOODFLOW');
  const long = nowPlayingWord('PAUSED', 'Bringing Cultures Together');
  expect([...long]).toHaveLength(20);
  expect(long.endsWith('…')).toBe(true);
  expect(long.startsWith('PAUSED · BRINGING')).toBe(true);
});
