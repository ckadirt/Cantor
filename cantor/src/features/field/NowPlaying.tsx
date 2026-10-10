import React, { useEffect, useMemo, useRef } from 'react';
import { PixelRatio, Pressable, StyleSheet, type TextStyle } from 'react-native';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Canvas,
  PaintStyle,
  Picture,
  Skia,
  createPicture,
  type SkFont,
} from '@shopify/react-native-skia';
import { WriteText, easeSmoother, graphemes } from '../../motion';
import { useFontScaledStyle, useMorphFont } from '../../motion/fonts';
import {
  ARRIVING_NONE,
  NAME_LENS_KNOBS,
  nameLensRingRadius,
  type Lens,
} from '../../lenses';
import type { FaceRecipe } from '../../lenses/face';
import { CIRCLE_MOTION_KNOBS } from '../../lenses/circleMotion';
import { beatSureOf, steppedBeatsAt } from '../../lenses/motion/motionFrame';
import type { MotionTrack } from '../../lenses/motion/motionTrack';
import { space, type Palette } from '../../theme/tokens';

/**
 * The song the player holds, as the header's one act on the map: its own face
 * inside the ring the map draws round it, and its name.
 *
 * `docs/interfacealpha/now-playing-variants.html` § I, "The song, in
 * miniature". The face is the lens's identity — the same mark you tapped on
 * the map — turning slowly while the song sounds; the ring is the clock, its
 * ink arc how far into the song you are. Once the song's motion track is
 * measured the turn steps on its beats, as the player's circle does, so the
 * header keeps the music's time rather than a clock of its own
 * (reactive-player-plan.md, decision 3). Paused, the turn comes to a stop, the
 * face keeps its last angle, and the ink settles to muted. Nothing snaps: the
 * turn is a phase that only ever advances, and the ink eases over `STATE_MS`.
 */
export type NowPlaying = Readonly<{
  title: string;
  recipe: FaceRecipe;
  /** Sounding, rather than held and silent. */
  playing: boolean;
  /** The transport's moving clock, and the length it runs against. */
  positionSeconds: SharedValue<number>;
  durationSeconds: number;
  /** The song's beats, once measured; until then the turn is even. */
  motion: MotionTrack | null;
}>;

/** KNOBS — the now-playing mark and its name. */
export const NOW_PLAYING_KNOBS = {
  /** The face, at this fraction of its size as a mark on the map. */
  FACE_SIZE: 0.5,
  /** The face's outline, and the ring's rim and heard arc. */
  HAIRLINE_PX: 1,
  RING_WIDTH_PX: 1,
  /** Between the mark and the first letter of the name. */
  MARK_GAP_PX: 8,
  /** Kept clear between the count line's last letter and the mark. */
  COUNT_GAP_PX: 14,
  /** One whole turn of the face, in seconds of the song sounding, where it turns evenly. */
  TURN_S: 12,
  /**
   * Stepping on the beat, a beat's share of a turn: a turn in twelve seconds
   * at 120 BPM, the even turn's speed. A beat further than this in one frame
   * is a seek, and the face does not spin to catch it up.
   */
  BEAT_TURN: 1 / 24,
  MAX_BEATS_PER_FRAME: 2,
  /**
   * How far the face's rim and the arc's head may travel, in physical pixels,
   * before the mark is redrawn. The turn moves about six pixels a second, so
   * redrawing on every frame would paint the same image twenty times over.
   */
  STEP_PX: 0.5,
  /** Playing ↔ paused: how long the turn's speed and the ink take to ease. */
  STATE_MS: 600,
  /**
   * The marquee, for a name longer than the room the count line leaves it: a
   * bus sign. The name scrolls left at `MARQUEE_PX_PER_S` without end, a
   * second copy following it after `MARQUEE_GAP`, so the loop has no seam.
   * It waits `MARQUEE_HOLD_MS` of the song sounding before it first moves, so
   * the name can be read as it is written. Its speed eases with the mark's
   * turn: paused, it slows to a stop where it stands, and resumes from there.
   */
  MARQUEE_HOLD_MS: 2400,
  MARQUEE_PX_PER_S: 24,
  MARQUEE_GAP: '   ·   ',
  /**
   * Spare room past the title's last letter inside its slot. The engine wraps
   * against the slot's laid-out width, and a slot measured exactly to the
   * title can round a hair short and drop its last glyph to a second line.
   * The window clips the spare, so it is never seen.
   */
  WRAP_SLACK_PX: 16,
} as const;

/** The ring's radius round the face at `FACE_SIZE`, as the map draws it. */
const RING_RADIUS_PX = nameLensRingRadius(
  NAME_LENS_KNOBS.MARK_RADIUS_PX * NOW_PLAYING_KNOBS.FACE_SIZE,
);
/** The mark's canvas: the ring and its stroke, whole. */
export const NOW_PLAYING_MARK_BOX_PX = Math.ceil(
  2 * RING_RADIUS_PX + NOW_PLAYING_KNOBS.RING_WIDTH_PX + 1,
);

/** One line of `font` at `letterSpacing`, as the text engine lays it out. */
export function lineWidth(
  font: SkFont,
  letterSpacing: number,
  text: string,
): number {
  const chars = graphemes(text);
  if (chars.length === 0) return 0;
  const glyphs = font.getGlyphWidths(font.getGlyphIDs(text));
  return glyphs.reduce((sum, width) => sum + width, 0) + letterSpacing * chars.length;
}

/** `text` cut with an ellipsis to fit `room`, for when the marquee may not run. */
export function fitWithEllipsis(
  font: SkFont,
  letterSpacing: number,
  text: string,
  room: number,
): string {
  if (lineWidth(font, letterSpacing, text) <= room) return text;
  const chars = graphemes(text);
  for (let n = chars.length - 1; n > 0; n -= 1) {
    const cut = `${chars.slice(0, n).join('').trimEnd()}…`;
    if (lineWidth(font, letterSpacing, cut) <= room) return cut;
  }
  return '…';
}

type Props = {
  /** The held song, or null when nothing is held or the seat is taken. */
  nowPlaying: NowPlaying | null;
  /** Whether the header is on screen at all; the mark stops turning when not. */
  visible: boolean;
  lens: Lens;
  palette: Palette;
  /** The name's type, as authored; the engine scales it, and so does this. */
  charStyle: TextStyle;
  /** The width the count line leaves, or null before it is measured. */
  room: number | null;
  rowHeight: number;
  changeMs: number;
  onPress?: () => void;
};

function NowPlayingImpl({
  nowPlaying,
  visible,
  lens,
  palette,
  charStyle,
  room,
  rowHeight,
  changeMs,
  onPress,
}: Props) {
  const reducedMotion = useReducedMotion();
  // The last song held, so the mark and the name can leave on the same
  // gesture they arrived on rather than vanishing with the prop.
  const last = useRef(nowPlaying);
  if (nowPlaying !== null) last.current = nowPlaying;
  const held = last.current;
  const shown = nowPlaying !== null;
  const scaled = useFontScaledStyle(charStyle);
  const font = useMorphFont(scaled);
  const letterSpacing = scaled.letterSpacing ?? 0;

  const title = held === null ? '' : held.title.trim().toUpperCase();
  const titleWidth =
    font === null || title === '' ? null : lineWidth(font, letterSpacing, title);
  const windowRoom =
    room === null
      ? null
      : Math.max(
          0,
          room - NOW_PLAYING_MARK_BOX_PX - NOW_PLAYING_KNOBS.MARK_GAP_PX,
        );
  const overflow =
    titleWidth === null || windowRoom === null
      ? 0
      : Math.max(0, titleWidth - windowRoom);
  // Reduced motion keeps the name still, so a long one is cut instead.
  const scrolls = !reducedMotion && overflow > 0;
  // Scrolling, the line is the name twice: the second copy is what the
  // window shows as the first one leaves it.
  const loop = `${title}${NOW_PLAYING_KNOBS.MARQUEE_GAP}`;
  const word = !shown
    ? ''
    : scrolls
    ? `${loop}${title}`
    : reducedMotion && overflow > 0 && font !== null && windowRoom !== null
    ? fitWithEllipsis(font, letterSpacing, title, windowRoom)
    : title;
  // How far the line travels before it looks exactly as it started.
  const period =
    scrolls && font !== null ? lineWidth(font, letterSpacing, loop) : 0;
  const windowWidth =
    titleWidth === null
      ? windowRoom ?? 0
      : windowRoom === null
      ? titleWidth
      : Math.min(titleWidth, windowRoom);
  const innerWidth =
    Math.max(windowWidth, titleWidth ?? 0) +
    period +
    NOW_PLAYING_KNOBS.WRAP_SLACK_PX;

  // The window follows the name's width rather than jumping to it, so a new
  // song's mark slides to its new seat while the name morphs — but only while
  // it is on screen. Hidden, the room it is measured against is some other
  // level's count line; arriving, it takes its seat at once, so the name is
  // written in one place rather than starting in one and sliding to another.
  const windowShared = useSharedValue(windowWidth);
  const wasShown = useRef(shown);
  useEffect(() => {
    const arriving = shown && !wasShown.current;
    wasShown.current = shown;
    if (!shown) return;
    windowShared.value = arriving
      ? windowWidth
      : withTiming(windowWidth, { duration: changeMs, easing: easeSmoother });
  }, [changeMs, shown, windowShared, windowWidth]);
  const windowStyle = useAnimatedStyle(() => ({ width: windowShared.value }));

  // How far toward playing: 1 sounding, 0 paused, eased between. The mark's
  // turn, its ink and the marquee all run at this speed.
  const playing = held !== null && held.playing;
  const playAt = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    playAt.value = withTiming(playing ? 1 : 0, {
      duration: NOW_PLAYING_KNOBS.STATE_MS,
      easing: easeSmoother,
    });
  }, [playAt, playing]);

  // The marquee: pixels travelled, wrapped at the period. Like the face's
  // turn, speed eases and position never jumps — except on arrival or a new
  // name, which start from the first letter while the name is being written.
  const travelled = useSharedValue(0);
  const waited = useSharedValue(0);
  const marquee = useFrameCallback(info => {
    const on = playAt.value;
    if (on <= 0 || period <= 0) return;
    const dt = ((info.timeSincePreviousFrame ?? 0) / 1000) * on;
    if (waited.value < NOW_PLAYING_KNOBS.MARQUEE_HOLD_MS / 1000) {
      waited.value += dt;
      return;
    }
    travelled.value =
      (travelled.value + dt * NOW_PLAYING_KNOBS.MARQUEE_PX_PER_S) % period;
  }, false);
  useEffect(() => {
    if (!shown) return;
    travelled.value = 0;
    waited.value = 0;
  }, [shown, title, period, travelled, waited]);
  useEffect(() => {
    marquee.setActive(scrolls && shown && visible);
  }, [marquee, scrolls, shown, visible]);
  const scrollStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -travelled.value }],
  }));

  // Arrives and leaves with the name, over the header's change.
  const presence = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    presence.value = withTiming(shown ? 1 : 0, {
      duration: changeMs,
      easing: easeSmoother,
    });
  }, [changeMs, presence, shown]);
  const markStyle = useAnimatedStyle(() => ({ opacity: presence.value }));

  return (
    <Pressable
      accessibilityElementsHidden={!shown}
      accessibilityLabel={
        shown && held !== null
          ? `Go to ${held.title}, ${held.playing ? 'playing' : 'paused'}`
          : undefined
      }
      accessibilityRole="button"
      hitSlop={space.md}
      importantForAccessibility={shown ? 'yes' : 'no-hide-descendants'}
      onPress={onPress}
      pointerEvents={shown ? 'auto' : 'none'}
      style={[styles.seat, { height: rowHeight }]}
      testID="now-playing"
    >
      {({ pressed }) => (
        <>
          {held === null ? null : (
            <Animated.View pointerEvents="none" style={markStyle}>
              <NowPlayingMark
                durationSeconds={held.durationSeconds}
                lens={lens}
                palette={palette}
                playAt={playAt}
                positionSeconds={held.positionSeconds}
                motion={held.motion}
                recipe={held.recipe}
                turning={visible && shown && !reducedMotion}
              />
            </Animated.View>
          )}
          <Animated.View
            pointerEvents="none"
            style={[styles.window, { height: rowHeight }, windowStyle]}
          >
            <Animated.View
              style={[{ height: rowHeight, width: innerWidth }, scrollStyle]}
            >
              <WriteText
                text={word}
                charStyle={charStyle}
                // Paused, the name goes quiet with the mark.
                color={pressed || !playing ? palette.muted : palette.ink}
                duration={changeMs}
                writeDuration={changeMs}
                variant="transform"
                style={{ height: rowHeight }}
              />
            </Animated.View>
          </Animated.View>
        </>
      )}
    </Pressable>
  );
}

export const NowPlayingSeat = React.memo(NowPlayingImpl);

/**
 * How far the mark turns in one frame, in turns: evenly at `on` of its speed
 * over `seconds`, and by the stepped beats counted since the last frame
 * (`were` → `now`, −1 for none), weighed by how `sure` the grid is. A count
 * that went back, or forward by more than a frame can hold, is a seek: no turn.
 */
export function markTurnAdvance(
  were: number,
  now: number,
  sure: number,
  seconds: number,
  on: number,
): number {
  'worklet';
  const K = NOW_PLAYING_KNOBS;
  const moved = were < 0 || now < 0 ? 0 : now - were;
  const stepped = moved > 0 && moved <= K.MAX_BEATS_PER_FRAME ? moved * K.BEAT_TURN : 0;
  const even = on <= 0 ? 0 : (seconds * on) / K.TURN_S;
  return even * (1 - sure) + stepped * sure;
}

/**
 * The mark itself: the held song's face, turning, inside its clock.
 *
 * One small canvas, recorded on the UI thread from three numbers — the turn,
 * the heard share, and how far toward playing the state has eased — each
 * stepped so the picture is re-recorded only when something visible moved.
 */
function NowPlayingMark({
  lens,
  recipe,
  palette,
  playAt,
  positionSeconds,
  durationSeconds,
  motion,
  turning,
}: {
  lens: Lens;
  recipe: FaceRecipe;
  palette: Palette;
  playAt: SharedValue<number>;
  positionSeconds: SharedValue<number>;
  durationSeconds: number;
  motion: MotionTrack | null;
  turning: boolean;
}) {
  const identity = useMemo(() => lens.identity(recipe), [lens, recipe]);
  const ui = lens.ui;
  const paints = useMemo(() => {
    const fill = Skia.Paint();
    fill.setAntiAlias(true);
    const stroke = Skia.Paint();
    stroke.setAntiAlias(true);
    stroke.setStyle(PaintStyle.Stroke);
    const rim = Skia.Paint();
    rim.setAntiAlias(true);
    rim.setStyle(PaintStyle.Stroke);
    rim.setStrokeWidth(NOW_PLAYING_KNOBS.RING_WIDTH_PX);
    rim.setColor(Skia.Color(palette.spine));
    const arc = Skia.Paint();
    arc.setAntiAlias(true);
    arc.setStyle(PaintStyle.Stroke);
    arc.setStrokeWidth(NOW_PLAYING_KNOBS.RING_WIDTH_PX);
    return { fill, stroke, rim, arc };
  }, [palette.spine]);
  const muted = useMemo(() => Array.from(Skia.Color(palette.muted)), [palette.muted]);
  const ink = useMemo(() => Array.from(Skia.Color(palette.ink)), [palette.ink]);

  /*
   * Turns the face has made. Evenly, it advances with the eased speed; on the
   * beat, with the playhead's stepped beat count — blended by how sure the grid
   * is, so a song with no beat still turns. Only ever forward: a seek moves the
   * count by many beats in a frame, or backwards, and the face lets it go.
   * The track sits in one shared value, handed over once per song rather than
   * captured by the frame's closure.
   */
  const track = useSharedValue<MotionTrack | null>(motion);
  useEffect(() => {
    track.value = motion;
  }, [motion, track]);
  const phase = useSharedValue(0);
  const beatsWere = useSharedValue(-1);
  const frame = useFrameCallback(info => {
    const song = track.value;
    const beats =
      song === null
        ? -1
        : steppedBeatsAt(song, positionSeconds.value, CIRCLE_MOTION_KNOBS.STEP_SHARE);
    phase.value += markTurnAdvance(
      beatsWere.value,
      beats,
      song === null ? 0 : beatSureOf(song),
      (info.timeSincePreviousFrame ?? 0) / 1000,
      playAt.value,
    );
    beatsWere.value = beats;
  }, false);
  useEffect(() => {
    frame.setActive(turning);
    if (!turning) beatsWere.value = -1;
  }, [beatsWere, frame, turning]);

  const ratio = PixelRatio.get();
  const faceReach =
    NAME_LENS_KNOBS.MARK_RADIUS_PX * NOW_PLAYING_KNOBS.FACE_SIZE * ratio;
  const turnStep = NOW_PLAYING_KNOBS.STEP_PX / (2 * Math.PI * faceReach);
  const heardStep =
    NOW_PLAYING_KNOBS.STEP_PX / (2 * Math.PI * RING_RADIUS_PX * ratio);
  const turn = useSharedValue(0);
  useAnimatedReaction(
    () => {
      const t = phase.value;
      return Math.round((t - Math.floor(t)) / turnStep) * turnStep;
    },
    (next, previous) => {
      if (next !== previous) turn.value = next;
    },
    [turnStep],
  );
  const heard = useSharedValue(0);
  useAnimatedReaction(
    () => {
      if (durationSeconds <= 0) return 0;
      const share = Math.min(1, Math.max(0, positionSeconds.value / durationSeconds));
      return Math.round(share / heardStep) * heardStep;
    },
    (next, previous) => {
      if (next !== previous) heard.value = next;
    },
    [durationSeconds, heardStep, positionSeconds],
  );

  const box = NOW_PLAYING_MARK_BOX_PX;
  const picture = useDerivedValue(() =>
    createPicture(canvas => {
      const on = playAt.value;
      const colour = Float32Array.of(
        muted[0] + (ink[0] - muted[0]) * on,
        muted[1] + (ink[1] - muted[1]) * on,
        muted[2] + (ink[2] - muted[2]) * on,
        1,
      );
      const c = box / 2;
      canvas.drawCircle(c, c, RING_RADIUS_PX, paints.rim);
      if (heard.value > 0) {
        paints.arc.setColor(colour);
        canvas.drawArc(
          Skia.XYWHRect(
            c - RING_RADIUS_PX,
            c - RING_RADIUS_PX,
            RING_RADIUS_PX * 2,
            RING_RADIUS_PX * 2,
          ),
          -90,
          360 * heard.value,
          false,
          paints.arc,
        );
      }
      paints.fill.setColor(colour);
      paints.stroke.setColor(colour);
      canvas.save();
      canvas.translate(c, c);
      canvas.rotate(turn.value * 360, 0, 0);
      ui.drawMark(
        canvas,
        identity,
        NOW_PLAYING_KNOBS.FACE_SIZE,
        1,
        1,
        1,
        0,
        ARRIVING_NONE,
        NOW_PLAYING_KNOBS.HAIRLINE_PX,
        paints,
      );
      canvas.restore();
    }),
  );
  return (
    <Canvas pointerEvents="none" style={styles.mark}>
      <Picture picture={picture} />
    </Canvas>
  );
}

const styles = StyleSheet.create({
  seat: {
    alignItems: 'center',
    bottom: 0,
    flexDirection: 'row',
    gap: NOW_PLAYING_KNOBS.MARK_GAP_PX,
    position: 'absolute',
    right: 0,
  },
  mark: { height: NOW_PLAYING_MARK_BOX_PX, width: NOW_PLAYING_MARK_BOX_PX },
  window: { overflow: 'hidden' },
});
