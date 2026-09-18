import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { space, type, usePalette } from '../../theme/tokens';

/** KNOBS — the blind: how it hangs, how far it must come, how fast it runs. */
export const CURTAIN_KNOBS = {
  /**
   * How much field stays visible past the blind when it is fully drawn.
   *
   * Zero: a blind comes all the way down. It used to stop short and leave a
   * strip of field showing, on the argument that you could still see where a
   * song would land — but a sheet that stops before the edge reads as a sheet
   * that got stuck, and the strip it left was live field under an open sheet.
   * Kept as a knob because it is the one number that would bring the strip
   * back; every seat, height and hem position is derived from it.
   */
  PEEK_PX: 0,
  /**
   * How fast a released blind runs, in pixels a second.
   *
   * A duration, not a rate, is what this used to be — one number for every
   * distance — so a blind let go two thirds of the way down covered its last
   * few hundred pixels at the same speed it would have covered two thousand,
   * and the short trips read as snaps. A blind has a speed; how long it takes
   * is how far it has to go. A fling faster than this carries its own speed
   * into the settle, so the sheet never slows down at the moment of release.
   */
  UNROLL_PX_PER_S: 4500,
  /** Floor and ceiling on that: no snap on a short trip, no crawl on a long one. */
  SETTLE_MIN_MS: 220,
  SETTLE_MAX_MS: 560,
  /**
   * How fast a flick has to be, in pixels a second, for its direction to
   * decide where the blind ends up regardless of how far it came.
   *
   * This is the notification shade's rule and the reason a blind feels
   * ordinary: throw it and it goes where you threw it, ease it and it settles
   * to whichever end is nearer. A single distance threshold — which is what
   * this used to be — answers a slow deliberate drag and a fast flick with the
   * same number, so a flick that had clearly asked for the sheet snapped back
   * and a careful nudge that had not opened it.
   */
  FLING_PX_PER_S: 400,
  /**
   * How much of the way a blind must have come, as a fraction of its height,
   * for a release with no throw in it to open rather than to roll back.
   *
   * Measured against the blind's full travel rather than in pixels, because
   * "past the halfway point" is what a hand judges and pixels are not.
   */
  SETTLE_FRACTION: 0.4,
  /**
   * The grip at the blind's leading edge: the band a finger may drag it back
   * by, and the hairline drawn in the middle of that band.
   *
   * A blind is folded away the way it was pulled out — by its leading edge,
   * dragged back toward the seat it came from. The band is a touch target
   * first: 48 px leaves room above the system's own bottom-edge gesture zone
   * on the top blind, which is where the two would otherwise collide.
   */
  GRIP_PX: 48,
  GRIP_LINE_PX: 56,
  /**
   * The blank band at the seat edge, opposite the grip.
   *
   * Nothing but air: it keeps the sheet's first line off the edge it is
   * hinged on, and it is the same measure as the grip's own so the content
   * sits in the middle of what it is given rather than pressed to one end.
   */
  SEAT_GAP_PX: 24,
  /** How much pull it takes for the hem's words to be fully present. */
  HINT_APPEAR_PX: 24,
  /** The stretch over which `KEEP PULLING` becomes `RELEASE TO OPEN`. */
  HINT_FADE_PX: 30,
  /**
   * The last stretch of the run, over which the hem's words leave.
   *
   * They are answering a finger that has already let go, so they go out with
   * the arrival rather than being unmounted at the release: a word removed by
   * a React commit is a word that vanishes a third of the way down, and the
   * rail it shares a block with would jump to fill the space it left.
   */
  HINT_LEAVE_PX: 140,
  /** The hem block: a rail, a gap, and one line of eyebrow type. */
  HEM_BLOCK_PX: 24,
  HINT_ROW_PX: 15,
} as const;

/**
 * How long a blind takes to cover a distance, in milliseconds.
 *
 * `velocityPxPerS` is how fast the finger was already moving when it let go,
 * in the blind's own direction and sign-free here: a throw faster than the
 * house speed keeps its own speed, so the sheet carries on at the pace it was
 * handed over at instead of visibly braking under the finger that threw it.
 *
 * Shared with the field's edge gesture, which starts the same movement from
 * the UI thread the moment a finger lets go — so a pull and its settle are one
 * motion at one speed rather than two animations that happen to meet.
 */
export function unrollMs(
  fromPx: number,
  toPx: number,
  velocityPxPerS: number,
): number {
  'worklet';
  const thrown = Number.isFinite(velocityPxPerS) ? Math.abs(velocityPxPerS) : 0;
  const rate = Math.max(CURTAIN_KNOBS.UNROLL_PX_PER_S, thrown);
  const ms = (Math.abs(toPx - fromPx) / rate) * 1000;
  return Math.min(
    Math.max(ms, CURTAIN_KNOBS.SETTLE_MIN_MS),
    CURTAIN_KNOBS.SETTLE_MAX_MS,
  );
}

/**
 * Where a released blind is headed, in its own direction: `heightPx` for open,
 * zero for rolled back up.
 *
 * The throw decides if there was one, and the nearer end decides if there was
 * not. Both ends of the gesture ask this — the edge pull that opens a blind
 * and the grip drag that folds it away — because they are the same movement
 * read at two starting points, and answering them with two different rules is
 * how a sheet ends up opening more easily than it closes.
 */
export function releaseTarget(
  drawnPx: number,
  heightPx: number,
  velocityPxPerS: number,
): number {
  'worklet';
  const thrown = Number.isFinite(velocityPxPerS) ? velocityPxPerS : 0;
  if (thrown > CURTAIN_KNOBS.FLING_PX_PER_S) return heightPx;
  if (thrown < -CURTAIN_KNOBS.FLING_PX_PER_S) return 0;
  return drawnPx >= heightPx * CURTAIN_KNOBS.SETTLE_FRACTION ? heightPx : 0;
}

/**
 * How long this trip takes: the house rate, or a blind's own if it asked.
 *
 * `UNROLL_PX_PER_S` is tuned for a *released drag*, where the run only has to
 * finish what a finger already did. A blind opened by a tap pays for the whole
 * travel at that rate, and the whole travel of a full-screen sheet is under
 * the floor — so every tapped sheet arrived at the same 220 ms whatever its
 * height. `fullMs` is what a full-height trip should take instead, scaled here
 * by how much of it this particular run covers, so a half-drawn blind released
 * to the top still moves at the speed the rest of it did.
 */
function travelMs(
  fromPx: number,
  toPx: number,
  fullMs: number | undefined,
  heightPx: number | undefined,
): number {
  'worklet';
  if (fullMs === undefined || heightPx === undefined || heightPx <= 0) {
    return unrollMs(fromPx, toPx, 0);
  }
  const covered = Math.abs(toPx - fromPx) / heightPx;
  return Math.max(CURTAIN_KNOBS.SETTLE_MIN_MS, fullMs * Math.min(1, covered));
}

/**
 * Send the blind to `target`, from wherever it is now.
 *
 * `destination` is what stops a release being animated twice. The finger's own
 * worklet launches the run at the instant it lets go; React learns a commit
 * later that the sheet is open and would otherwise restart the same trip with
 * a fresh ease — a visible hitch a third of the way down. Whoever gets there
 * first writes the destination, and the other one sees it and leaves it alone.
 *
 * `sign` is which blind is asking, and it is what keeps the two of them off
 * each other's value: both read one signed pull, so a blind that is rolled up
 * has no business writing to it while the other one is hanging. Without that
 * test the closed blind rolled the open one away every time the height
 * changed — open the keyboard under the composer and the soft input shrank the
 * viewport, both blinds re-ran this with their new height, and the engines,
 * closed and asking for zero, took the composer down with it.
 */
export function unrollTo(
  pull: SharedValue<number>,
  destination: SharedValue<number>,
  target: number,
  sign: number,
  fullMs?: number,
  heightPx?: number,
): void {
  'worklet';
  if (pull.value * sign < 0) return;
  if (destination.value === target) return;
  destination.value = target;
  pull.value = withTiming(target, {
    duration: travelMs(pull.value, target, fullMs, heightPx),
    easing: easeSmoother,
  });
}

/** How far past `KEEP PULLING` the pull has come, as 0..1 across the fade. */
function readiness(drawnPx: number, atPx: number): number {
  'worklet';
  const start = atPx - CURTAIN_KNOBS.HINT_FADE_PX;
  return Math.min(
    Math.max((drawnPx - start) / CURTAIN_KNOBS.HINT_FADE_PX, 0),
    1,
  );
}

/** How present the hem's words are: in with the pull, out with the arrival. */
function hintPresence(drawnPx: number, heightPx: number): number {
  'worklet';
  const arriving = Math.min(
    Math.max(
      (drawnPx - (heightPx - CURTAIN_KNOBS.HINT_LEAVE_PX)) /
        CURTAIN_KNOBS.HINT_LEAVE_PX,
      0,
    ),
    1,
  );
  return Math.min(drawnPx / CURTAIN_KNOBS.HINT_APPEAR_PX, 1) * (1 - arriving);
}

export type CurtainEdge = 'top' | 'bottom';

type Props = {
  /** Which edge the blind is rolled at, and therefore which way it unrolls. */
  edge: CurtainEdge;
  /**
   * How long a full-height trip takes when React opens or closes this blind,
   * rather than a finger letting go of it.
   *
   * Left out by the panels that are pulled: their run is the tail of a gesture
   * and belongs at the gesture's own speed. Given by the ones that are tapped,
   * which otherwise arrive at the floor of a rate meant for flicks.
   */
  openMs?: number;
  /** What is behind it, named on the hem while a finger is pulling. */
  title: string;
  /**
   * Screen pixels of pull, written by the field's edge gesture on the UI
   * thread: positive is the top blind coming down, negative is the bottom one
   * coming up. Both blinds read the one value, and each ignores the other's
   * sign.
   */
  pull: SharedValue<number>;
  /** Where the last launched run is headed; see `unrollTo`. */
  destination: SharedValue<number>;
  /** Whether the sheet has been let go of, past that threshold. */
  open: boolean;
  viewportHeight: number;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * A sheet unrolled over the field from one edge.
 *
 * A blind, not a modal, and unrolled rather than slid: the sheet has one seat
 * against its edge, and what changes is how much of it has come. That is why
 * the composer's caption arrives before its `Make it` line — the content
 * enters in reading order, the way a blind shows the slats nearest its roller
 * first.
 *
 * How far it has come is the finger's own position, frame for frame, because
 * the pull is a shared value the UI thread reads directly. Releasing throws it
 * where it was thrown, or settles it to whichever end is nearer; both ends of
 * the gesture answer to `releaseTarget`. Nothing here waits for a React commit
 * to know where it is — a commit only decides whether it ends up open or
 * closed.
 *
 * Both edges are this one object, mirrored through `sign`, because they are
 * one gesture: pull the top down for a new song, pull the bottom up for the
 * engines. Two implementations would be two answers to the same question.
 */
function CurtainImpl({
  edge,
  openMs,
  title,
  pull,
  destination,
  open,
  viewportHeight,
  onClose,
  children,
}: Props) {
  const pal = usePalette();
  const fromTop = edge === 'top';
  /** +1 draws downward from the top edge, -1 upward from the bottom one. */
  const sign = fromTop ? 1 : -1;
  const height = Math.max(0, viewportHeight - CURTAIN_KNOBS.PEEK_PX);
  /** Where the hem's words turn over, which is where a quiet release opens. */
  const openAt = height * CURTAIN_KNOBS.SETTLE_FRACTION;
  /**
   * Whether the blind is in the tree at all.
   *
   * A sheet drawn to zero height is still a view sitting over the field: it
   * swallowed every tap below its seat — the shelf's `DOWNLOAD ALL`, the order
   * dial, the whole header — while looking completely absent. Clipping is not
   * absence. This unmounts it instead, and the reaction costs one hop per
   * crossing rather than one per frame.
   */
  const [live, setLive] = useState(false);
  useAnimatedReaction(
    () => pull.value * sign > 0.5,
    (drawn, previous) => {
      if (drawn !== previous) runOnJS(setLive)(drawn);
    },
    [sign],
  );

  // React owns only the destination. The finger owns everything before it, and
  // the run starts from wherever the finger stopped — on the UI thread, so the
  // distance it measures is the live one rather than React's copy of it.
  //
  // `height` is in the dependencies because a blind that is down has to stay
  // down over a viewport that changed under it — the soft keyboard resizes the
  // window, and a sheet still drawn to the old height would hang past the
  // opening. `sign` is what makes that safe for the blind that is *not* down;
  // see `unrollTo`.
  useEffect(() => {
    runOnUI(unrollTo)(
      pull,
      destination,
      open ? sign * height : 0,
      sign,
      openMs,
      height,
    );
  }, [destination, height, open, openMs, pull, sign]);

  // Height, not transform: a blind that slid as a rigid body would enter hem
  // first, showing `Make it` before the caption. The inner sheet carries an
  // explicit height so the words inside never re-flow as the opening changes —
  // only how much of them is uncovered does.
  const surface = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value * sign, 0), height);
    return {
      height: drawn,
      // Fully up is not merely invisible, it is absent: a sheet at zero must
      // not sit over the field it is not covering.
      opacity: drawn <= 0 ? 0 : 1,
    };
  }, [height, sign]);

  // The hem rides at the leading edge, so the rail and the words are always at
  // the edge the finger is holding rather than at a fixed place on the screen.
  const hem = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value * sign, 0), height);
    return {
      // The rail fades in with the first pixels of pull and then stays: it is
      // the blind's own edge, not a hint about it.
      opacity: Math.min(drawn / CURTAIN_KNOBS.HINT_APPEAR_PX, 1),
      transform: [{ translateY: sign * drawn }],
    };
  }, [height, sign]);

  // One word before the threshold, another past it, crossfaded on the pull.
  const keepPulling = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value * sign, 0), height);
    return {
      opacity: (1 - readiness(drawn, openAt)) * hintPresence(drawn, height),
    };
  }, [height, openAt, sign]);
  const releaseToOpen = useAnimatedStyle(() => {
    const drawn = Math.min(Math.max(pull.value * sign, 0), height);
    return {
      opacity: readiness(drawn, openAt) * hintPresence(drawn, height),
    };
  }, [height, openAt, sign]);

  /**
   * Drag the open blind back by its grip: the edge pull run backwards, and the
   * reason the grip sits at the leading edge rather than at the seat.
   *
   * It tracks the finger over the blind's whole travel and clamps at both ends
   * — it does not bail out when the drag reverses. A gesture that stops
   * answering the finger halfway is the one thing that reads as broken, and a
   * hand that has changed its mind mid-drag has to be able to put the sheet
   * back where it found it without lifting.
   */
  const dismiss = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .onUpdate(event => {
          'worklet';
          // How far back toward the edge the blind came from, whichever edge
          // that is: up for the top blind, down for the bottom one.
          const retreat = -sign * event.translationY;
          const drawn = Math.min(Math.max(height - retreat, 0), height);
          // Nothing is headed anywhere while a finger is on it; see `unrollTo`.
          destination.value = Number.NaN;
          pull.value = sign * drawn;
        })
        .onEnd(event => {
          'worklet';
          const retreat = -sign * event.translationY;
          const drawn = Math.min(Math.max(height - retreat, 0), height);
          // Positive is still opening, in the blind's own direction — the same
          // sense the edge pull hands to `releaseTarget`.
          const thrown = sign * event.velocityY;
          const target = releaseTarget(drawn, height, thrown);
          destination.value = sign * target;
          pull.value = withTiming(sign * target, {
            duration: unrollMs(drawn, target, thrown),
            easing: easeSmoother,
          });
          // The run is already going; React learns a commit later that the
          // sheet is closed and finds `destination` already saying so.
          if (target <= 0) runOnJS(onClose)();
        }),
    [destination, height, onClose, open, pull, sign],
  );

  if (!live && !open) return null;

  const rail = (
    <View key="rail" style={[styles.rail, { backgroundColor: pal.ink }]} />
  );
  const words = (
    <View key="words" style={styles.hintSlot}>
      <Animated.Text
        style={[
          type.eyebrow,
          styles.hintLine,
          { color: pal.faint },
          keepPulling,
        ]}
      >
        {`${title} · KEEP PULLING`}
      </Animated.Text>
      <Animated.Text
        style={[
          type.eyebrow,
          styles.hintLine,
          { color: pal.ink },
          releaseToOpen,
        ]}
      >
        {`${title} · RELEASE TO OPEN`}
      </Animated.Text>
    </View>
  );
  const grip = (
    <GestureDetector gesture={dismiss}>
      <View style={styles.grip}>
        <View style={[styles.gripLine, { backgroundColor: pal.faint }]} />
      </View>
    </GestureDetector>
  );

  return (
    <>
      <Animated.View
        pointerEvents={open ? 'box-none' : 'none'}
        style={[
          styles.root,
          fromTop ? styles.rootTop : styles.rootBottom,
          surface,
        ]}
      >
        {/*
          No line at the seat. Both seats are screen edges now, and a blind
          needs a boundary only where it meets the field — which is the rail
          riding its hem, and nowhere else.
        */}
        <View style={[styles.sheet, { backgroundColor: pal.bg, height }]}>
          {/*
            The grip is the last thing on the top blind and the first thing on
            the bottom one, because both of those are the leading edge — the
            place the hem's rail rides, the place the sheet arrives from, and
            therefore the place a hand already knows to reach for. It is in the
            sheet's flow rather than laid over it so the content is laid out
            inside what is left, and nothing ends up underneath it.
          */}
          {fromTop ? <View style={styles.seatGap} /> : grip}
          <View style={styles.content}>{children}</View>
          {fromTop ? grip : <View style={styles.seatGap} />}
        </View>
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.hem, fromTop ? styles.hemTop : styles.hemBottom, hem]}
      >
        {/*
          The rail is the blind's own edge and stays with it the whole way; the
          words sit on the field side of it, under the hem at the top and over
          it at the bottom. Both are mounted at every opening, because the block
          is a column and a child removed from it moves the other one.
        */}
        {fromTop ? [rail, words] : [words, rail]}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  // One seat against one edge. `overflow: hidden` is what makes the animated
  // height a reveal rather than a squeeze.
  root: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
  },
  rootTop: { top: CURTAIN_KNOBS.PEEK_PX },
  // `flex-end` is the mirror of the top blind's default: the sheet is taller
  // than the opening, so pinning its foot to the opening's foot is what makes
  // the bottom blind show the slats nearest *its* roller first.
  rootBottom: { bottom: 0, justifyContent: 'flex-end' },
  sheet: {},
  /** What is left of the sheet once the grip has its band. */
  content: { flex: 1, paddingHorizontal: space.lg },
  /** The grip is the handle: a band at the leading edge, with a rule drawn in it. */
  grip: {
    alignItems: 'center',
    height: CURTAIN_KNOBS.GRIP_PX,
    justifyContent: 'center',
  },
  gripLine: {
    height: StyleSheet.hairlineWidth,
    width: CURTAIN_KNOBS.GRIP_LINE_PX,
  },
  seatGap: { height: CURTAIN_KNOBS.SEAT_GAP_PX },
  hem: {
    gap: space.sm,
    height: CURTAIN_KNOBS.HEM_BLOCK_PX,
    left: 0,
    paddingHorizontal: space.lg,
    position: 'absolute',
    right: 0,
  },
  hemTop: { top: CURTAIN_KNOBS.PEEK_PX },
  hemBottom: { bottom: 0 },
  rail: { height: StyleSheet.hairlineWidth },
  /** Both readings share one seat and cross-fade in it; neither reflows. */
  hintSlot: { height: CURTAIN_KNOBS.HINT_ROW_PX },
  hintLine: { left: 0, position: 'absolute', top: 0 },
});

/** Memoised for the same reason the sheet is: the field re-renders per frame. */
export const Curtain = React.memo(CurtainImpl);
