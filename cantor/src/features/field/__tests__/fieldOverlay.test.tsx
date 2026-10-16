import React from 'react';
import { StyleSheet, Text } from 'react-native';
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
import { describeFailure } from '../../../core/protocol';
import { notices, NOTICE_KNOBS } from '../../../notices';
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
  motion: null,
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

describe('notices borrow the hint seat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    Renderer.act(() => {
      for (const notice of notices.store.get()) notices.clear(notice.key);
    });
    jest.useRealTimers();
  });

  function mount(level: Level = 'field', legend = false) {
    const render = (next: Level) => (
      <FieldOverlay
        arrangementKey={byTime.key}
        cameraShared={shared({ x: 0, y: 0, scale: FIT })}
        dateResolution="week"
        fitScaleShared={shared(FIT)}
        groupCount={3}
        groupLabel="This week"
        lens={nameLens}
        level={next}
        offline={false}
        onChangeArrangement={() => {}}
        onChangeDateResolution={() => {}}
        onChangeOrder={() => {}}
        onOpenComposer={() => {}}
        onOpenEngines={() => {}}
        onShelfAction={() => {}}
        orderKey="date"
        shelfAction={null}
        showLegend={legend}
        mountLegend={legend}
        songCount={8}
      />
    );
    let tree!: Renderer.ReactTestRenderer;
    Renderer.act(() => { tree = Renderer.create(render(level)); });
    const seat = () => tree.root.findByProps({ testID: 'field-hint-seat' });
    const line = () => seat().findAll(
      node => node.props.hosted && typeof node.props.text === 'string',
    )[0];
    return {
      tree,
      level: (next: Level) => {
        Renderer.act(() => tree.update(render(next)));
      },
      seat,
      line,
      text: () => line().props.text,
    };
  }

  const words = describeFailure(new Error('Timed out'), 'agentbox');

  it('morphs the hint into a notice in the same seat, then back without an alert over the dial', () => {
    const f = mount();
    const line = f.line();
    const hint = line.props.text;
    Renderer.act(() => notices.post({ key: 'work:a', tone: 'refusal', words }));
    expect(f.line()).toBe(line);
    expect(f.text()).toBe('AGENTBOX DID NOT ANSWER');
    expect(f.seat().props.accessibilityRole).toBe('alert');
    expect(f.seat().props.accessibilityLabel).toBe(words.sentence);
    const alerts = f.tree.root.findAll(
      node => node.type === Text && node.props.accessibilityRole === 'alert',
    );
    expect(alerts).toHaveLength(0);
    expect(StyleSheet.flatten(f.seat().props.style).position).toBeUndefined();
    Renderer.act(() => jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS));
    expect(f.text()).toBe(hint);
    expect(f.line()).toBe(line);
    Renderer.act(() => f.tree.unmount());
  });

  it.each(['song', 'grain'] as const)(
    'waits at %s and starts its lifetime on return to L0/L1',
    level => {
      const f = mount(level);
      const hidden = f.text();
      Renderer.act(() => notices.post({ key: 'work:a', tone: 'refusal', words }));
      Renderer.act(() => jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS * 3));
      expect(f.text()).toBe(hidden);
      expect(notices.store.get()).toHaveLength(1);
      f.level('shelf');
      expect(f.text()).toBe('AGENTBOX DID NOT ANSWER');
      Renderer.act(() => jest.advanceTimersByTime(NOTICE_KNOBS.STANDS_MS));
      expect(f.text()).toBe('TAP A ROW TO ARRIVE');
      Renderer.act(() => f.tree.unmount());
    },
  );

  it('offers the action as a button and gives a notice priority over the legend', () => {
    const f = mount('field', true);
    const run = jest.fn();
    Renderer.act(() => notices.post({
      key: 'audio:a', tone: 'unreachable', words,
      action: { label: 'TRY AGAIN', run },
    }));
    expect(f.text()).toBe('AGENTBOX DID NOT ANSWER · TRY AGAIN');
    const button = f.seat().findAll(
      node => node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function',
    )[0];
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe(words.sentence);
    Renderer.act(() => button.props.onPress());
    expect(run).toHaveBeenCalledTimes(1);
    expect(notices.store.get()).toEqual([]);
    expect(f.text()).toBe(''); // the legend takes its seat back
    Renderer.act(() => f.tree.unmount());
  });
});
