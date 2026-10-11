import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import {
  BlendMode,
  Canvas,
  Picture,
  Skia,
  TileMode,
  createPicture,
  type SkFont,
  type SkPaint,
  type SkPath,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { layoutText, type CharBox } from '../../motion/text';
import { NOW_PLAYING_KNOBS } from './NowPlaying';
import {
  songAxisPx,
  songMetaOriginPx,
  songTitleColumnPx,
  type PoseViewport,
} from './songPose';

/**
 * KNOBS — the player's byline, when it is longer than its column.
 *
 * The same bus sign as the now-playing name (`NOW_PLAYING_KNOBS`), and on the
 * same numbers, so the two scrolling lines in the app read as one behaviour:
 * the line sits still from its first letter for `HOLD_MS` of the song sounding,
 * then travels left at `PX_PER_S` without end, a second copy following it
 * `GAP_PX` behind with a middle dot in the gap, so the loop has no seam. Its
 * speed rides the transport: paused, it slows to a stop where it stands.
 */
export const BYLINE_MARQUEE_KNOBS = {
  HOLD_MS: NOW_PLAYING_KNOBS.MARQUEE_HOLD_MS,
  PX_PER_S: NOW_PLAYING_KNOBS.MARQUEE_PX_PER_S,
  /** Air between the end of the byline and its next copy; the dot sits mid-way. */
  GAP_PX: 40,
  /**
   * How far past each edge of the column the letters fade out. Inside the
   * side margin (`SONG_FOOT_SIDE_PX`), so the column itself is full ink and a
   * line at rest reads from its first letter.
   */
  EDGE_FADE_PX: 18,
  /** Where on `named` the letters past the column start to ink in; see `bylineTailInk`. */
  TAIL_FROM: 0.8,
  /** Room above and below the line in the strip canvas the marquee draws on. */
  STRIP_PAD_PX: 12,
} as const;

/** The middle dot between one copy of the byline and the next. */
const GAP_MARK = '·';

/**
 * A byline too long for its column, laid out to scroll.
 *
 * The player draws it as a loop — the byline, a dot, the byline again — whose
 * first copy starts at the column's left edge. `periodPx` is how far the loop
 * travels before it looks exactly as it started.
 */
export type BylineScroll = Readonly<{
  /** Which loop this is; the marquee's clock is kept per key. */
  key: string;
  /** The byline, once. */
  text: string;
  periodPx: number;
  /** Where the dot sits, from the seat. */
  markPx: number;
  /**
   * How many of the loop's letters start inside the column at rest. The rest
   * are only ever seen scrolled in, so they ink in as the line lands rather
   * than racing out past the column on the way.
   */
  shown: number;
  /** The column the line shows through, in the player's own space. */
  left: number;
  width: number;
  /**
   * The loop at rest as one outline: exactly what the morph lands on, so the
   * marquee takes the line over without a pixel changing. Null where the
   * runtime has no outlines, and both sides draw glyphs instead.
   */
  path: SkPath | null;
}>;

/** One line as the morph lays it out: boxes, and the width they cover. */
function runOf(text: string, font: SkFont): { boxes: CharBox[]; width: number } {
  const boxes = layoutText(text, font, 0, Infinity, 0);
  const last = boxes[boxes.length - 1];
  return { boxes, width: last === undefined ? 0 : last.x + last.w };
}

/**
 * Whether the byline fits its column, and if not, the loop it scrolls as.
 *
 * Measured with `layoutText`, the layout the morph lands on, rather than with
 * `measureText`, so the period, the dot and the second copy are exactly where
 * the morph's last frame puts them.
 */
export function bylineLayout(
  text: string,
  font: SkFont,
  viewport: PoseViewport,
):
  | Readonly<{ fits: true }>
  | Readonly<{
      fits: false;
      boxes: CharBox[];
      scroll: Omit<BylineScroll, 'path'>;
    }> {
  const width = songTitleColumnPx(viewport.width);
  const once = runOf(text, font);
  if (once.width <= width) return { fits: true };
  const mark = runOf(GAP_MARK, font);
  const periodPx = once.width + BYLINE_MARQUEE_KNOBS.GAP_PX;
  const markPx =
    once.width + (BYLINE_MARQUEE_KNOBS.GAP_PX - mark.width) / 2;
  const boxes = [
    ...once.boxes,
    ...mark.boxes.map(box => ({ ...box, x: box.x + markPx })),
    ...once.boxes.map(box => ({ ...box, x: box.x + periodPx })),
  ];
  const outside = boxes.findIndex(box => box.x >= width);
  return {
    fits: false,
    boxes,
    scroll: {
      key: `${text}\u0000${font.getSize()}\u0000${width}`,
      text,
      periodPx,
      markPx,
      shown: outside < 0 ? boxes.length : outside,
      left: songAxisPx() - width / 2,
      width,
    },
  };
}

/**
 * The marquee's state, on the UI thread.
 *
 * Shared by the field canvas, which draws the line while it is still or
 * moving with the camera, and the strip canvas, which draws it while it
 * scrolls — so re-rendering the field, which costs most of a frame at L2, is
 * never what moves the letters. `owner` is the one number both read to know
 * which of them draws; both change it only in UI-thread worklets.
 */
export type BylineClock = Readonly<{
  /** The loop the clock below is counting for (`BylineScroll.key`). */
  key: SharedValue<string>;
  /** Pixels travelled, unwrapped; 0 until the hold has passed. */
  travelled: SharedValue<number>;
  /** Seconds of the song sounding at the player, toward the hold. */
  waited: SharedValue<number>;
  /** 1 while the strip canvas draws the line, 0 while the field does. */
  owner: SharedValue<number>;
  /** Where the field last drew the player, as the flight that holds it says. */
  at: SharedValue<BylineAt | null>;
}>;

export type BylineAt = Readonly<{
  scroll: BylineScroll;
  /** The flight's translation: the player's own space, in the view. */
  x: number;
  y: number;
  /** The flight's opacity. */
  alpha: number;
  /** How far the name and the byline have travelled to the foot. */
  named: number;
}>;

export function useBylineClock(): BylineClock {
  const key = useSharedValue('');
  const travelled = useSharedValue(0);
  const waited = useSharedValue(0);
  const owner = useSharedValue(0);
  const at = useSharedValue<BylineAt | null>(null);
  return useMemo(
    () => ({ key, travelled, waited, owner, at }),
    [key, travelled, waited, owner, at],
  );
}

/**
 * How much of the loop's unseen letters to draw, 0..1, at `named` of the way
 * to the foot: nothing until the line has nearly landed, then all of it by
 * the time it has — and, leaving, gone in the first stretch of the way back.
 */
export function bylineTailInk(named: number): number {
  'worklet';
  const from = BYLINE_MARQUEE_KNOBS.TAIL_FROM;
  const u = (named - from) / (1 - from);
  return u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
}

/** How far into its loop the line is: the scroll the canvas draws. */
export function bylineOffset(travelled: number, periodPx: number): number {
  'worklet';
  return periodPx > 0 ? travelled % periodPx : 0;
}

/**
 * How much the song is sounding, 0..1, read off the transport's verb pose:
 * the pause silhouette (2) is a song playing, the play silhouette (1) one that
 * is not, and the morph between them eases the marquee's speed with it.
 */
export function bylineSounding(pose: number): number {
  'worklet';
  const sounding = pose - 1;
  return sounding <= 0 ? 0 : sounding >= 1 ? 1 : sounding;
}

/** One frame of the marquee: the hold first, then travel. */
export function stepByline(
  waited: number,
  travelled: number,
  dtSeconds: number,
): Readonly<{ waited: number; travelled: number }> {
  'worklet';
  const hold = BYLINE_MARQUEE_KNOBS.HOLD_MS / 1000;
  if (waited < hold) {
    // The frame that finishes the hold does not also move the line: the
    // first travel is the frame the strip canvas takes it over on.
    return { waited: Math.min(hold, waited + dtSeconds), travelled };
  }
  return {
    waited,
    travelled: travelled + dtSeconds * BYLINE_MARQUEE_KNOBS.PX_PER_S,
  };
}

/** Back to the first letter: a new byline, or a player left behind. */
function resetByline(clock: BylineClock, key: string): void {
  'worklet';
  clock.key.value = key;
  clock.travelled.value = 0;
  clock.waited.value = 0;
  clock.owner.value = 0;
}

/**
 * The flight's side: say where the player is, and take the line back.
 *
 * Runs only when the camera moves or the flight's ownership changes, so a
 * player at rest costs nothing here. Leaving the player — the name starting
 * back toward its row — hands the line back to the field, which morphs it from
 * where the marquee left it; arriving at the row resets it, so the next visit
 * starts from the first letter.
 */
export function usePublishByline(
  clock: BylineClock | null,
  scroll: BylineScroll | null,
  /** Whether this flight is the one drawing the player; see `playerRow`. */
  holds: DerivedValue<boolean>,
  // Read-only, so any translate-first transform will do.
  transform: Readonly<{ value: readonly unknown[] }>,
  alpha: DerivedValue<number>,
  named: DerivedValue<number>,
): void {
  useAnimatedReaction(
    () => {
      const translate = transform.value;
      const first = translate[0] as { translateX?: number } | undefined;
      const second = translate[1] as { translateY?: number } | undefined;
      return {
        holds: holds.value,
        x: first?.translateX ?? 0,
        y: second?.translateY ?? 0,
        alpha: alpha.value,
        named: named.value,
      };
    },
    now => {
      if (clock === null || !now.holds) return;
      if (scroll === null) {
        if (clock.at.value !== null) clock.at.value = null;
        if (clock.owner.value !== 0) clock.owner.value = 0;
        return;
      }
      if (clock.key.value !== scroll.key || now.named <= 0) {
        resetByline(clock, scroll.key);
      } else if (now.named < 1 && clock.owner.value !== 0) {
        clock.owner.value = 0;
      }
      clock.at.value = {
        scroll,
        x: now.x,
        y: now.y,
        alpha: now.alpha,
        named: now.named,
      };
    },
    [clock, scroll],
  );
  // A flight that goes takes its byline with it, unless the next one has
  // already put its own there.
  const key = scroll?.key ?? null;
  useEffect(() => {
    if (clock === null || key === null) return undefined;
    return () => {
      runOnUI(() => {
        'worklet';
        if (clock.at.value?.scroll.key !== key) return;
        clock.at.value = null;
        clock.owner.value = 0;
      })();
    };
  }, [clock, key]);
}

/**
 * The field's side: how far its line is scrolled, and whether it draws it.
 *
 * Both are constant while the marquee owns the line, so the field canvas is not
 * re-rendered by the scroll: an unchanged shared value notifies nobody.
 */
export function useFieldByline(
  clock: BylineClock | null,
  scroll: BylineScroll | null,
  named: DerivedValue<number>,
): Readonly<{
  shift: DerivedValue<Transforms3d>;
  drawn: DerivedValue<number>;
}> {
  const key = scroll?.key ?? null;
  const periodPx = scroll?.periodPx ?? 0;
  const shiftX = useDerivedValue(() => {
    if (clock === null || clock.key.value !== key || clock.owner.value > 0) {
      return 0;
    }
    return -bylineOffset(clock.travelled.value, periodPx) * named.value;
  });
  const shift = useDerivedValue<Transforms3d>(() => [
    { translateX: shiftX.value },
  ]);
  const drawn = useDerivedValue<number>(() =>
    clock !== null && clock.key.value === key && clock.owner.value > 0 ? 0 : 1,
  );
  return { shift, drawn };
}

/**
 * The column's edges, as a gradient: full ink across the column, fading to
 * `edge` over `EDGE_FADE_PX` past each side and clamped there beyond.
 */
export function bylineEdgeStops(
  scroll: Pick<BylineScroll, 'left' | 'width'>,
): Readonly<{ from: number; to: number; positions: number[] }> {
  const fade = BYLINE_MARQUEE_KNOBS.EDGE_FADE_PX;
  const from = scroll.left - fade;
  const to = scroll.left + scroll.width + fade;
  const inner = fade / (to - from);
  return { from, to, positions: [0, inner, 1 - inner, 1] };
}

/**
 * The byline while it scrolls, on a strip of its own above the field.
 *
 * The field draws the player and the line into one canvas that costs most of a
 * frame to redraw at L2, which is why the face moves on `PlayerMotionLayer`
 * rather than there. This is the same move for the byline: the field keeps the
 * line still, and hands it here on the frame it first moves. The strip is only
 * as tall as the line, so a frame of it is a path and a mask.
 *
 * Memoised, and its picture element held by identity, for the reason the
 * field's scene is: a canvas handed a fresh child stops its mapper until the
 * JS thread has re-recorded the tree. Re-rendered with the field on a press of
 * Back, the strip froze on its last scrolled frame for the length of that
 * commit — about 100 ms on the Xiaomi — while the field had already taken the
 * line back and begun to morph it: two bylines, one sliding off the other.
 */
export const BylineMarqueeLayer = React.memo(function BylineMarqueeLayer({
  clock,
  playing,
  font,
  colour,
  viewport,
}: {
  clock: BylineClock;
  /** The transport's verb pose; see `bylineSounding`. */
  playing: SharedValue<number> | null;
  font: SkFont;
  colour: string;
  viewport: PoseViewport;
}) {
  const metrics = font.getMetrics();
  const pad = BYLINE_MARQUEE_KNOBS.STRIP_PAD_PX;
  // The strip, in the view: around the byline's seat where the player rests,
  // which is the only place the line scrolls.
  const top = viewport.height / 2 + songMetaOriginPx(viewport).y - pad;
  const height = Math.ceil(metrics.descent - metrics.ascent + 2 * pad);
  const ascent = metrics.ascent;

  const paints = useMemo(() => {
    const ink = Skia.Paint();
    ink.setAntiAlias(true);
    ink.setColor(Skia.Color(colour));
    const stops = bylineEdgeStops({
      left: songAxisPx() - songTitleColumnPx(viewport.width) / 2,
      width: songTitleColumnPx(viewport.width),
    });
    return { ink, stops };
  }, [colour, viewport.width]);
  // The edges' mask, made on the UI thread the first time a line scrolls
  // rather than with the layer: most players never need it.
  const mask = useSharedValue<SkPaint | null>(null);
  useEffect(() => {
    mask.value = null;
  }, [mask, paints]);

  // The clock runs only while the player is at rest on a song that is
  // sounding; a paused or distant player costs no frames.
  const tick = useFrameCallback(info => {
    const at = clock.at.value;
    if (at === null || at.named < 1 || clock.key.value !== at.scroll.key) {
      return;
    }
    const on = playing === null ? 0 : bylineSounding(playing.value);
    if (on <= 0) return;
    const dt = ((info.timeSincePreviousFrame ?? 0) / 1000) * on;
    const next = stepByline(clock.waited.value, clock.travelled.value, dt);
    clock.waited.value = next.waited;
    if (next.travelled === clock.travelled.value) return;
    clock.travelled.value = next.travelled;
    if (clock.owner.value !== 1) clock.owner.value = 1;
  }, false);
  const [ticking, setTicking] = useState(false);
  useEffect(() => {
    tick.setActive(ticking);
  }, [tick, ticking]);
  useAnimatedReaction(
    () => {
      const at = clock.at.value;
      return (
        at !== null &&
        at.named >= 1 &&
        playing !== null &&
        bylineSounding(playing.value) > 0
      );
    },
    (on, was) => {
      if (on !== was) runOnJS(setTicking)(on);
    },
    [clock, playing],
  );

  const picture = useDerivedValue(() =>
    createPicture(
      canvas => {
        const at = clock.at.value;
        if (
          at === null ||
          clock.owner.value <= 0 ||
          at.alpha <= 0 ||
          clock.key.value !== at.scroll.key
        ) {
          return;
        }
        const stops = paints.stops;
        let edges = mask.value;
        if (edges === null) {
          edges = Skia.Paint();
          edges.setBlendMode(BlendMode.DstIn);
          edges.setShader(
            Skia.Shader.MakeLinearGradient(
              { x: stops.from, y: 0 },
              { x: stops.to, y: 0 },
              [
                Skia.Color('rgba(0,0,0,0)'),
                Skia.Color('black'),
                Skia.Color('black'),
                Skia.Color('rgba(0,0,0,0)'),
              ],
              stops.positions,
              TileMode.Clamp,
            ),
          );
          mask.value = edges;
        }
        const scroll = at.scroll;
        const offset = bylineOffset(clock.travelled.value, scroll.periodPx);
        paints.ink.setAlphaf(at.alpha);
        canvas.save();
        canvas.translate(at.x, at.y - top);
        canvas.saveLayer();
        canvas.save();
        canvas.translate(-offset, 0);
        if (scroll.path !== null) {
          canvas.drawPath(scroll.path, paints.ink);
        } else {
          // `layoutText`'s line is one ascent below the seat; see `baselineOf`.
          const baseline = songMetaOriginPx(viewport).y - ascent;
          canvas.drawText(scroll.text, scroll.left, baseline, paints.ink, font);
          canvas.drawText(
            GAP_MARK,
            scroll.left + scroll.markPx,
            baseline,
            paints.ink,
            font,
          );
          canvas.drawText(
            scroll.text,
            scroll.left + scroll.periodPx,
            baseline,
            paints.ink,
            font,
          );
        }
        canvas.restore();
        // `DstIn` masks only what it covers, so the rect runs well past both
        // edges; the gradient is clamped transparent out there.
        canvas.drawRect(
          Skia.XYWHRect(
            stops.from - viewport.width,
            -viewport.height,
            stops.to - stops.from + 2 * viewport.width,
            2 * viewport.height,
          ),
          edges,
        );
        canvas.restore();
        canvas.restore();
      },
      { width: viewport.width, height },
    ),
  );
  const scene = useMemo(() => <Picture picture={picture} />, [picture]);
  const style = useMemo(
    () => [styles.strip, { top, height, width: viewport.width }],
    [height, top, viewport.width],
  );
  return (
    <Canvas
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={style}
    >
      {scene}
    </Canvas>
  );
});

/** The middle dot's text, for the field's fallback glyphs. */
export const BYLINE_GAP_MARK = GAP_MARK;

const styles = StyleSheet.create({
  strip: { position: 'absolute', left: 0 },
});
