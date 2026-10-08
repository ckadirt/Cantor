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
import { FieldOverlay } from '../FieldOverlay';
import {
  fitWithEllipsis,
  lineWidth,
  type NowPlaying,
} from '../NowPlaying';
import { Skia } from '@shopify/react-native-skia';

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

const BLOODFLOW: NowPlaying = {
  title: 'Bloodflow',
  recipe: { seed: 7, id: 'bloodflow', model: 'test', durationMs: 120_000 },
  playing: true,
  positionSeconds: shared(30),
  durationSeconds: 120,
};

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
  function render(level: Level, nowPlaying: NowPlaying | null) {
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
    const now = tree.root.findAll(
      node =>
        node.props.testID === 'now-playing' &&
        node.props.accessibilityRole === 'button',
    )[0];
    return { tree, slot, now, onNowPlaying, onShelfAction };
  }

  it('on the map, goes to the song the player holds', () => {
    const { tree, slot, now, onNowPlaying, onShelfAction } = render(
      'field',
      BLOODFLOW,
    );
    expect(now.props.accessibilityLabel).toBe('Go to Bloodflow, playing');
    expect(now.props.pointerEvents).toBe('auto');
    expect(slot.props.pointerEvents).toBe('none');
    Renderer.act(() => now.props.onPress());
    expect(onNowPlaying).toHaveBeenCalledTimes(1);
    expect(onShelfAction).not.toHaveBeenCalled();
    Renderer.act(() => tree.unmount());
  });

  it('says when the held song is paused', () => {
    const { tree, now } = render('field', { ...BLOODFLOW, playing: false });
    expect(now.props.accessibilityLabel).toBe('Go to Bloodflow, paused');
    Renderer.act(() => tree.unmount());
  });

  it('on the map with nothing held, is not there to press', () => {
    const { tree, slot, now } = render('field', null);
    expect(now.props.pointerEvents).toBe('none');
    expect(slot.props.pointerEvents).toBe('none');
    Renderer.act(() => tree.unmount());
  });

  it("inside a shelf, is still the shelf's own action", () => {
    const { tree, slot, now, onNowPlaying, onShelfAction } = render(
      'shelf',
      BLOODFLOW,
    );
    expect(slot.props.accessibilityLabel).toBe('DOWNLOAD ALL · 5 MB');
    expect(now.props.pointerEvents).toBe('none');
    Renderer.act(() => slot.props.onPress());
    expect(onShelfAction).toHaveBeenCalledTimes(1);
    expect(onNowPlaying).not.toHaveBeenCalled();
    Renderer.act(() => tree.unmount());
  });
});

describe('the held name, where the marquee may not run', () => {
  const font = Skia.Font(undefined, 11);
  it('is left whole when it fits', () => {
    const room = lineWidth(font, 2, 'BLOODFLOW');
    expect(fitWithEllipsis(font, 2, 'BLOODFLOW', room)).toBe('BLOODFLOW');
  });

  it('is cut with an ellipsis to the room it has', () => {
    const title = 'BRINGING CULTURES TOGETHER';
    const room = lineWidth(font, 2, title) / 2;
    const cut = fitWithEllipsis(font, 2, title, room);
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(title.startsWith(cut.slice(0, -1))).toBe(true);
    expect(lineWidth(font, 2, cut)).toBeLessThanOrEqual(room);
  });
});

describe("find's door to the tags", () => {
  function render(query: string) {
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => {
      tree = Renderer.create(
        <FieldOverlay
          arrangementKey={byTime.key}
          cameraShared={shared({ x: 0, y: 0, scale: FIT })}
          dateResolution="week"
          fitScaleShared={shared(FIT)}
          finding={{ query, songCount: 4, groupCount: 4 }}
          groupCount={3}
          groupLabel="This week"
          lens={nameLens}
          level="field"
          offline={false}
          onChangeArrangement={() => {}}
          onChangeDateResolution={() => {}}
          onChangeOrder={() => {}}
          onOpenComposer={() => {}}
          onOpenEngines={() => {}}
          onOpenTags={() => {}}
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
    const texts = tree.root
      .findAll(node => typeof node.props.text === 'string')
      .map(node => node.props.text as string);
    const foot = tree.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Show only some tags' &&
        typeof node.props.onPress === 'function',
    );
    return { tree, texts, foot };
  }

  // The foot is under the keyboard while find types; the count line is not.
  it('is on the count line before a letter, not in the foot', () => {
    const { tree, texts, foot } = render('');
    expect(texts).toContain('TYPE A NAME ·');
    expect(texts).not.toContain('TAGS');
    expect(foot).toHaveLength(0);
    Renderer.act(() => tree.unmount());
  });

  it('leaves with the first letter', () => {
    const { tree, texts } = render('p');
    expect(texts).toContain('4 SONGS · 4 WEEKS');
    Renderer.act(() => tree.unmount());
  });
});
