import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { TransformText, WriteText, easeSmoother } from '../../motion';
import {
  ARRANGEMENTS,
  DATE_RESOLUTIONS,
  SONG_ORDERS,
  byTime,
  type DateResolution,
  type Level,
} from '../../field';
import { space, type, usePalette } from '../../theme/tokens';

type Props = {
  level: Level;
  offline: boolean;
  storageError: string | null;
  onOpenEngines: () => void;
  onOpenComposer: () => void;
  /** How the field is grouped, and the control that changes it. */
  arrangementKey: string;
  onChangeArrangement: (key: string) => void;
  /** How coarsely the date axis cuts time. Ignored by every other axis. */
  dateResolution: DateResolution;
  onChangeDateResolution: (resolution: DateResolution) => void;
  /** What the header counts: songs on screen, and the clusters holding them. */
  songCount: number;
  groupCount: number;
  /** The name of the cluster you are inside, at L1. */
  groupLabel: string | null;
  /**
   * The bulk action for the shelf you are inside, already carrying its size —
   * `DOWNLOAD ALL · 84 MB` — or null when there is nothing left to fetch.
   *
   * Bulk work is list work, so it lives at L1 only: at L0 it would act on a
   * cluster you are looking at rather than one you are inside.
   */
  shelfAction: string | null;
  onShelfAction: () => void;
  /**
   * How members are seated inside the shelf you are inside, and the control
   * that changes it. Order is position, so this is a dial like the axis is —
   * you watch a cluster re-form rather than watching a list re-sort.
   */
  orderKey: string;
  onChangeOrder: (key: string) => void;
};

/**
 * KNOBS — the chrome.
 *
 * The edge tabs keep their drawing and their target in separate numbers.
 * `TAB_SLAT_*` and `TAB_LABEL_*` say how big the mark is; `TAB_HIT_*` says how
 * big the door is. They were one number once — the widest slat was `touch.min`,
 * so the drawing was sized by what a finger needs — and the mark grew to the
 * size of a target while the target stayed the size of a mark.
 */
export const OVERLAY_KNOBS = {
  /**
   * The rolled blind, drawn as slats, outermost first.
   *
   * A stack of hairlines rather than the single rule and tick this used to be:
   * a stack says *blind*, and a taper says which way it comes down. One line
   * at the edge of the screen said neither, which is why the two doors out of
   * the field were the two things nobody found.
   *
   * Drawn at about two thirds of the size it was first cut at. The widest slat
   * used to be `touch.min` — the mark for a gesture made exactly as wide as the
   * smallest thing a finger is expected to find, which conflated a *drawing*
   * with a *target*. At 48 px, over a 160 px word in the header's own type
   * size, the door read as a second header at the top of the screen and as a
   * fourth row of the transport at the foot. The target did not shrink with it;
   * it moved into `TAB_HIT_*`, where it belongs.
   */
  TAB_SLAT_WIDTHS_PX: [28, 18, 10],
  TAB_SLAT_GAP_PX: 3,
  /** The column the slats are centred in: exactly the widest of them. */
  TAB_WIDTH_PX: 28,
  TAB_EDGE_INSET_PX: space.sm,
  /** Between the slats and the word naming what is rolled up behind them. */
  TAB_LABEL_GAP_PX: 6,
  /** Wide enough for `NEW SONG` at the tab's own size, centred on the screen. */
  TAB_LABEL_WIDTH_PX: 120,
  /**
   * The tab's own type: the eyebrow, one step quieter.
   *
   * The same step down `resolution` takes under the axis dial, and for the same
   * reason — this is a label for a door, not a reading about the field, and at
   * the header's own 11 px it competed with `L1 · GROUP` a few pixels to its
   * left. Smaller *and* tighter: dropping the size alone leaves the 2 px
   * tracking, and a small word spaced like a large one reads as a wider object
   * rather than a quieter one.
   */
  TAB_LABEL_SIZE_PX: 9,
  TAB_LABEL_TRACKING_PX: 1.4,
  /** Clear of the tab, which now reaches `TAB_REACH_PX` up from the same edge. */
  FOOT_INSET_PX: 72,
  /** High enough to clear the dial at L0 and the player's transport at L2. */
  ALERT_INSET_PX: 150,
  /**
   * How far a tab's body reaches back into the screen from its edge: three
   * hairlines, two gaps, the label's own gap, and one line of the tab's type.
   */
  TAB_REACH_PX: 28,
  /**
   * Added to that body *outward and sideways* to make a finger's target.
   *
   * Outward is free: it runs into the screen edge, where a thumb overshoots
   * anyway and there is nothing else to hit.
   */
  TAB_HIT_SLOP_PX: 20,
  /**
   * Added *inward*, toward the middle of the screen — and deliberately much
   * smaller, because inward is not free.
   *
   * The slop used to be one number applied on all four sides, which put 20 px
   * of invisible tab on top of whatever the level below had at the foot. At L2
   * that is the player's own quiet line: `DETAIL` and `PINNED` are drawn on the
   * canvas and caught by boxes `touch.min` tall centred on their baseline, so
   * their targets reach down to `SONG_WORDS_BOTTOM_PX - touch.min / 2` = 46 px,
   * and the tab's reached up to 64. The overlap was invisible and the tab was
   * on top of it, so the bottom third of `DETAIL` opened the engines.
   *
   * `TAB_EDGE_INSET_PX + TAB_REACH_PX + this` is the whole inward reach: 42 px,
   * four clear of the player's words. `songFoot.test.ts` holds that gap.
   */
  TAB_HIT_INWARD_PX: 6,
  /**
   * The mark under the selected word on a dial.
   *
   * A tick, not a triangle or a pill: the edge tabs already say "this is the
   * one" with a short hairline, so the dial says it the same way and the
   * chrome keeps one vocabulary. It slides rather than jumping because the
   * dial is a dial — the selection moves along it.
   */
  TICK_GAP_PX: 5,
  DIAL_MOVE_MS: 260,
  /**
   * The resolution row's height, including the space above it. Fixed rather
   * than measured: it is one line of one type size, and animating a measured
   * height means the first frame of every open is the wrong size.
   */
  RESOLUTION_ROW_PX: 26,
  RESOLUTION_MS: 240,
  /** How far the row rises into its seat, in the engine's entrance spirit. */
  REVEAL_RISE_PX: 6,
  /*
   * Reserved heights for the chrome's animated lines.
   *
   * The text engine draws on a canvas that fills its container absolutely and
   * reports no height of its own, so every slot has to be given one — house
   * rule 2. Fixed rather than measured: a slot that resized as the words
   * changed would reflow the header in the middle of a morph, which is the one
   * thing the engine cannot absorb.
   *
   * These are the line heights the engine lays out at, which is `fontSize`
   * times its default 1.35, rounded up: 11 → 15, 26 → 36.
   */
  EYEBROW_ROW_PX: 15,
  TITLE_ROW_PX: 36,
  /**
   * The width kept for the shelf's bulk action, at the right end of the meta
   * row, and the reason it is a constant.
   *
   * The action is `DOWNLOAD ALL · 84 MB` at its longest, and its slot has to
   * keep one width across every string it ever holds — including the empty one
   * at L0. A slot measured to its text would collapse to zero when the action
   * goes away, and the engine builds no model for a zero-width slot, so the
   * outgoing word would simply stay on screen. Fixed width, right-aligned ink.
   */
  ACTION_WIDTH_PX: 190,
  /**
   * How long the header takes to become the header for the level you moved to.
   *
   * One number for every line in it, because the header is one object: the
   * depth, the name, the count and the bulk action are four readings of a
   * single change, and four readings that finish at four different times read
   * as four things happening rather than one.
   *
   * It has to be said out loud rather than left to the engine's defaults,
   * which do not agree with each other. A morph runs for
   * `DEFAULT_TEXT_TRANSFORM_MS`; a `Write` runs for ManimGL's automatic
   * duration, which is *two seconds* for a line of fifteen glyphs or more —
   * right for a title writing itself onto an empty screen, and three times
   * the length of everything beside it here. `DOWNLOAD ALL · 84 MB` was still
   * being written long after the title it belongs to had settled.
   *
   * 700 is the morph default, so raising this slows the whole header together
   * rather than pulling the action back out of step with the rest.
   */
  HEADER_CHANGE_MS: 700,
} as const;

/*
 * Char styles for the animated lines, hoisted to module scope — house rule 3.
 * A fresh style object every render defeats the components' memo and re-records
 * a ticking canvas.
 */
const CHROME_STYLES = {
  eyebrow: type.eyebrow,
  title: type.title,
  /** The action is pinned to the meta row's right end; see `ACTION_WIDTH_PX`. */
  action: { ...type.eyebrow, textAlign: 'right' } as const,
  hint: { ...type.eyebrow, textAlign: 'center' } as const,
} as const;

/** What each level is called. */
const LEVELS: Record<Level, { index: number; name: string }> = {
  field: { index: 0, name: 'MAP' },
  shelf: { index: 1, name: 'GROUP' },
  song: { index: 2, name: 'SONG' },
  grain: { index: 3, name: 'GRAIN' },
};

/**
 * The one gesture worth naming, at the levels the field owns.
 *
 * L2 and L3 get none: the player draws its own transport across the foot of
 * the screen, and a hint line there is both a second voice and, literally, on
 * top of the controls it would be describing.
 */
const HINTS = {
  field: 'TAP A FACE TO OPEN ITS',
  shelf: 'TAP A ROW TO ARRIVE',
} as const;

/**
 * What one cluster is, so the L0 hint names the thing you are opening.
 *
 * Only the date axis cuts time; every other axis says its own noun, because a
 * hint that promises a week and opens a playlist is a hint that lies.
 */
const CLUSTER_NOUN: Record<DateResolution, string> = {
  week: 'WEEK',
  month: 'MONTH',
  year: 'YEAR',
};

function FieldOverlayImpl({
  level,
  offline,
  storageError,
  onOpenEngines,
  onOpenComposer,
  arrangementKey,
  onChangeArrangement,
  dateResolution,
  onChangeDateResolution,
  songCount,
  groupCount,
  groupLabel,
  shelfAction,
  onShelfAction,
  orderKey,
  onChangeOrder,
}: Props) {
  const pal = usePalette();
  const onDateAxis = arrangementKey === byTime.key;
  // L2 and L3 belong to the player, which draws its own name and metadata in
  // this corner. Two headers in one place is the fault this step exists to
  // remove, so at those levels the breadcrumb carries the depth alone.
  const showHeader = level === 'field' || level === 'shelf';
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <EdgeTab
        accessibilityLabel="Open the composer"
        colour={pal.faint}
        edge="top"
        label="NEW SONG"
        onPress={onOpenComposer}
      />
      {showHeader ? (
        // box-none, not none: the count is not touchable but the shelf action
        // beside it is, and it is the only thing in this corner that is.
        <View style={styles.header} pointerEvents="box-none">
          {/*
            The header is one object at every level, not a different header per
            level. So the depth, the name and the count *change* rather than
            being replaced. `Field` becoming `Last week` is the gesture the
            whole zoom model rests on being continuous, and it was the one
            place the chrome cut.

            A plain Transform rather than the matching variant, which is what
            this used to be. Matching finds the letters two lines share and
            flies each one to its new seat on an arc, with a cascade — right
            for a title, and wrong for a line like `8 SONGS · 3 GROUPS`, whose
            every reading shares most of its letters with the last one. The
            S's and the O's swam past each other on separate arcs and the line
            read as a shuffle rather than as a number changing. `Transform`
            aligns by reading order and interpolates every outline on one
            shared alpha, so the count re-forms in place: one object, one
            gesture, which is what the paragraph above is claiming.
          */}
          <TransformText
            text={`L${LEVELS[level].index} · ${LEVELS[level].name}`}
            charStyle={CHROME_STYLES.eyebrow}
            color={pal.muted}
            duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            style={styles.eyebrowSlot}
          />
          <TransformText
            text={level === 'shelf' ? groupLabel ?? 'Group' : 'Field'}
            charStyle={CHROME_STYLES.title}
            color={pal.ink}
            duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            style={styles.titleSlot}
          />
          <View style={styles.metaRow} pointerEvents="box-none">
            <View style={styles.metaCount} pointerEvents="none">
              <TransformText
                text={`${metaLine(
                  level,
                  songCount,
                  groupCount,
                  onDateAxis,
                  dateResolution,
                )}${offline ? ' · OFFLINE' : ''}`}
                charStyle={CHROME_STYLES.eyebrow}
                color={pal.faint}
                duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
                style={styles.eyebrowSlot}
              />
            </View>
            {/*
              Always mounted, and empty at every level that has no bulk action.
              An action that unmounted could not be taken back off the screen:
              the engine needs the outgoing ink and a stable slot width to
              unwrite it, and an unmounted component has neither. The word
              writes itself on when you enter a shelf and unwrites itself when
              you leave — one gesture, both directions.
            */}
            <Pressable
              accessibilityElementsHidden={shelfAction === null}
              accessibilityLabel={shelfAction ?? undefined}
              accessibilityRole="button"
              hitSlop={space.md}
              importantForAccessibility={
                shelfAction === null ? 'no-hide-descendants' : 'yes'
              }
              onPress={onShelfAction}
              pointerEvents={shelfAction === null ? 'none' : 'auto'}
              style={styles.actionSlot}
            >
              {({ pressed }) => (
                <WriteText
                  text={level === 'shelf' ? shelfAction ?? '' : ''}
                  charStyle={CHROME_STYLES.action}
                  color={pressed ? pal.muted : pal.ink}
                  // Both, because this slot has two gestures: it writes and
                  // unwrites on the level change, and morphs in place when the
                  // shelf's size changes under it while you are standing there.
                  duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
                  writeDuration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
                  // The second of those gestures is the header's, so it is the
                  // header's variant. `write` and `erase` are chosen ahead of
                  // the variant and so are untouched by this.
                  variant="transform"
                  style={styles.eyebrowSlot}
                />
              )}
            </Pressable>
          </View>
          {/*
            Always mounted, rising into a seat the header keeps for it. The
            header stacks downward from the top of the screen, so the seat
            costs nothing at L0 — it is below everything — and the control
            arrives by coming up into focus rather than by existing suddenly.
          */}
          <Reveal
            duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            open={level === 'shelf'}
          >
            <View style={styles.orderRow} pointerEvents="box-none">
              <Text
                style={[type.eyebrow, styles.orderLabel, { color: pal.line }]}
                pointerEvents="none">
                ORDER
              </Text>
              <Dial
                activeKey={orderKey}
                activeColour={pal.ink}
                items={SONG_ORDERS.map(order => ({
                  key: order.key,
                  label: order.label.toUpperCase(),
                  accessibilityLabel: `Order by ${order.label}`,
                }))}
                onSelect={onChangeOrder}
                restColour={pal.faint}
                textStyle={type.eyebrow}
                tickColour={pal.ink}
              />
            </View>
          </Reveal>
        </View>
      ) : null}

      {/* An alert clears the player's transport as well as the dial. */}
      {storageError ? (
        <Text
          accessibilityRole="alert"
          style={[type.small, styles.alert, { color: pal.ink }]}
        >
          {storageError}
        </Text>
      ) : null}
      {showHeader ? (
        <View style={styles.foot} pointerEvents="box-none">
          {/*
          The dial is a property of the map, so it is drawn on the map. At L1
          you are inside one cluster and re-cutting the whole field from there
          would move the ground you are standing on.
        */}
          {/*
            The dial is a property of the map, so it is drawn on the map — and
            it leaves the same way it arrives. Always mounted: the foot is
            anchored to the bottom of the screen and stacks upward, so the hint
            below it does not move whether the dial is lit or not, and the dial
            can therefore rise and set instead of blinking in and out.
          */}
          <Reveal open={level === 'field'}>
            <>
              <Dial
                activeKey={arrangementKey}
                activeColour={pal.ink}
                items={ARRANGEMENTS.map(arrangement => ({
                  key: arrangement.key,
                  label: arrangement.label.toUpperCase(),
                  accessibilityLabel: `Arrange by ${arrangement.label}`,
                }))}
                onSelect={onChangeArrangement}
                restColour={pal.faint}
                textStyle={type.eyebrow}
                tickColour={pal.ink}
              />
              {/*
                Resolution sits under the axis it belongs to, because it is a
                property of that axis rather than a fourth arrangement. It
                grows in and out rather than appearing: the foot is anchored to
                the bottom of the screen, so a row arriving at full height
                shoves the axis above it upward in one frame.
              */}
              <Reveal
                open={onDateAxis}
                height={OVERLAY_KNOBS.RESOLUTION_ROW_PX}
              >
                <Dial
                  activeKey={dateResolution}
                  activeColour={pal.muted}
                  items={DATE_RESOLUTIONS.map(resolution => ({
                    key: resolution,
                    label: CLUSTER_NOUN[resolution],
                    accessibilityLabel: `Group dates by ${resolution}`,
                  }))}
                  onSelect={key =>
                    onChangeDateResolution(key as DateResolution)
                  }
                  restColour={pal.line}
                  textStyle={styles.resolution}
                  tickColour={pal.muted}
                />
              </Reveal>
            </>
          </Reveal>
          {/*
            The hint names the one gesture worth naming, and which gesture that
            is changes with the level and with the axis. It is the same
            sentence being rewritten, so it morphs like the header does.
          */}
          <TransformText
            text={
              level === 'field'
                ? `${HINTS.field} ${
                    onDateAxis ? CLUSTER_NOUN[dateResolution] : 'PLAYLIST'
                  }`
                : HINTS.shelf
            }
            charStyle={CHROME_STYLES.hint}
            color={pal.faint}
            style={styles.hintSlot}
          />
        </View>
      ) : null}
      <EdgeTab
        accessibilityLabel="Open engines"
        colour={pal.faint}
        edge="bottom"
        label="ENGINES"
        onPress={onOpenEngines}
      />
    </View>
  );
}

/** `23 SONGS · 5 WEEKS`, or what the current axis counts instead. */
function metaLine(
  level: Level,
  songCount: number,
  groupCount: number,
  onDateAxis: boolean,
  resolution: DateResolution,
): string {
  const songs = `${songCount} ${songCount === 1 ? 'SONG' : 'SONGS'}`;
  if (level === 'shelf') return songs;
  // `GROUP` rather than `PLAYLIST`, which is the truer word and did not fit:
  // this line shares its row with `ACTION_WIDTH_PX` of reserved slot, so
  // `8 SONGS · 3 PLAYLISTS` ran off the end and was read as `8 SONGS · 3` —
  // a count with nothing to count. The hint below still says `PLAYLIST`,
  // where there is room for it and where naming the gesture is the point.
  const noun = onDateAxis ? CLUSTER_NOUN[resolution] : 'GROUP';
  return `${songs} · ${groupCount} ${noun}${groupCount === 1 ? '' : 'S'}`;
}

/**
 * The mark for a pull: the rolled blind, and the name of what it opens.
 *
 * A gesture nobody can see is a gesture nobody uses. This was one hairline and
 * a tick — true to the drawing and completely mute about what it was for. Now
 * each edge shows its blind rolled up against it: slats tapering the way it
 * will unroll, with the word it opens beside them. Still hairlines, still the
 * same object at both edges, because it is the same gesture — pull the top
 * down for a new song, pull the bottom up for the engines.
 *
 * It is also a button: a screen reader and a finger that misses the drag both
 * still have a door.
 *
 * The body is `TAB_REACH_PX` tall and grows *inward* from the edge, with the
 * widest slat pinned to the outer end. `hitSlop` cannot do this job: on
 * Android it does not reliably enlarge an absolutely positioned view, so the
 * real target would be the hairlines themselves — which at the bottom sit
 * inside the system's own gesture strip, where a tap opens the launcher
 * instead.
 */
function EdgeTab({
  accessibilityLabel,
  colour,
  edge,
  label,
  onPress,
}: {
  accessibilityLabel: string;
  colour: string;
  edge: 'top' | 'bottom';
  /** The word beside the slats: what pulling this edge actually opens. */
  label: string;
  onPress: () => void;
}) {
  // Widest slat outermost, so the taper always points the way the blind
  // travels — reversed at the bottom, where it travels the other way.
  const widths =
    edge === 'top'
      ? OVERLAY_KNOBS.TAB_SLAT_WIDTHS_PX
      : [...OVERLAY_KNOBS.TAB_SLAT_WIDTHS_PX].reverse();
  const slats = (
    <View key="slats" pointerEvents="none" style={styles.tabSlats}>
      {widths.map((width, index) => (
        <View
          key={`${index}-${width}`}
          style={[styles.tabSlat, { backgroundColor: colour, width }]}
        />
      ))}
    </View>
  );
  const word = (
    <Text key="word" style={[styles.tabLabel, { color: colour }]}>
      {label}
    </Text>
  );
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      // The mark is hairlines and a word; the *target* has to be a finger's
      // worth of screen. The bottom tab measured three device-independent
      // pixels tall — which is why nothing could ever be made to press it —
      // while the identical top one measured twenty-eight. Slop rather than
      // height, so the drawn mark stays exactly where the design puts it.
      //
      // Directional, though, and not the square it used to be: generous
      // outward into the edge, sideways for a short word, and barely anything
      // inward, where the level underneath has its own foot. See
      // `TAB_HIT_INWARD_PX`.
      hitSlop={
        edge === 'top'
          ? {
              top: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
              bottom: OVERLAY_KNOBS.TAB_HIT_INWARD_PX,
              left: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
              right: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
            }
          : {
              top: OVERLAY_KNOBS.TAB_HIT_INWARD_PX,
              bottom: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
              left: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
              right: OVERLAY_KNOBS.TAB_HIT_SLOP_PX,
            }
      }
      onPress={onPress}
      style={[styles.tab, edge === 'top' ? styles.tabTop : styles.tabBottom]}
    >
      {edge === 'top' ? [slats, word] : [word, slats]}
    </Pressable>
  );
}

/** One position on a dial. */
type DialItem = Readonly<{
  key: string;
  label: string;
  accessibilityLabel: string;
}>;

/**
 * A row of choices with a tick that slides to whichever is chosen.
 *
 * Colour alone already says which word is selected; the tick is what makes the
 * *change* visible. It travels to the new word's own width, so the mark reads
 * as one object moving along the dial rather than as several marks taking
 * turns being lit — which is the difference between a control and a row of
 * buttons.
 *
 * Each word reports its own box through `onLayout`; nothing here measures text.
 */
function Dial({
  activeColour,
  activeKey,
  items,
  onSelect,
  restColour,
  textStyle,
  tickColour,
}: {
  activeColour: string;
  activeKey: string;
  items: readonly DialItem[];
  onSelect: (key: string) => void;
  restColour: string;
  textStyle: object;
  tickColour: string;
}) {
  const reducedMotion = useReducedMotion();
  const [boxes, setBoxes] = useState<
    Record<string, { x: number; width: number }>
  >({});
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  // The first box to arrive has nowhere to travel from, so it is placed.
  const placed = useRef(false);

  const measure = useCallback((key: string, event: LayoutChangeEvent) => {
    const { x, width: w } = event.nativeEvent.layout;
    setBoxes(previous => {
      const known = previous[key];
      if (known !== undefined && known.x === x && known.width === w) {
        return previous;
      }
      return { ...previous, [key]: { x, width: w } };
    });
  }, []);

  const target = boxes[activeKey];
  useEffect(() => {
    if (target === undefined) return;
    if (!placed.current || reducedMotion) {
      placed.current = true;
      left.value = target.x;
      width.value = target.width;
      return;
    }
    const timing = {
      duration: OVERLAY_KNOBS.DIAL_MOVE_MS,
      easing: easeSmoother,
    };
    left.value = withTiming(target.x, timing);
    width.value = withTiming(target.width, timing);
  }, [left, reducedMotion, target, width]);

  const tick = useAnimatedStyle(() => ({
    opacity: width.value > 0 ? 1 : 0,
    transform: [{ translateX: left.value }],
    width: width.value,
  }));

  return (
    <View style={styles.dial} pointerEvents="box-none">
      <View style={styles.dialRow} pointerEvents="box-none">
        {items.map(item => (
          <Pressable
            accessibilityLabel={item.accessibilityLabel}
            accessibilityRole="button"
            accessibilityState={{ selected: item.key === activeKey }}
            hitSlop={space.sm}
            key={item.key}
            onLayout={event => measure(item.key, event)}
            onPress={() => onSelect(item.key)}
            style={styles.dialItem}
          >
            <Text
              style={[
                textStyle,
                { color: item.key === activeKey ? activeColour : restColour },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Animated.View
        pointerEvents="none"
        style={[styles.tick, tick, { backgroundColor: tickColour }]}
      />
    </View>
  );
}

/**
 * A row or a block that rises into space already kept for it.
 *
 * The foot is anchored to the bottom of the screen and stacks upward, so a row
 * that mounts at full height shoves the axis above it up in one frame — which
 * is the jump this replaces. The seat is therefore permanent: the dial above
 * sits at the same height on every axis, and only the row's own ink arrives
 * and leaves.
 *
 * `height` is for a row *inside* a stack, where the seat has to be reserved
 * even when the row is empty. A whole control that comes and goes with the
 * level passes no height and keeps its natural one: it is always mounted, so
 * the space is reserved by definition, and only its ink answers to `open`.
 * That is what a dial arriving looks like — the same rise the resolution row
 * has always used, rather than a control appearing out of nothing.
 *
 * It does not animate its height to get there. Reanimated drives the view
 * directly on the UI thread, so a layout prop that would reflow the parent
 * never reaches React Native's layout pass and snaps instead — measured on
 * device. Opacity and transform do not reflow anything, so they behave.
 *
 * The children stay mounted throughout: unmounting them when the fade ends
 * would be a completion callback mutating the tree.
 */
function Reveal({
  children,
  duration = OVERLAY_KNOBS.RESOLUTION_MS,
  height,
  open,
}: {
  children: React.ReactNode;
  /**
   * Left at the resolution row's own length for a row that answers to the
   * axis, and given the header's when the thing being revealed is part of the
   * header becoming another header — a control that settles before the words
   * around it is the same break as one that settles after them.
   */
  duration?: number;
  height?: number;
  open: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const amount = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const to = open ? 1 : 0;
    amount.value = reducedMotion
      ? to
      : withTiming(to, { duration, easing: easeSmoother });
  }, [amount, duration, open, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: amount.value,
    transform: [
      { translateY: (1 - amount.value) * OVERLAY_KNOBS.REVEAL_RISE_PX },
    ],
  }));
  return (
    <Animated.View
      // `accessibilityElementsHidden` as well as the pointer guard: a control
      // that has faded out is gone as far as a finger is concerned, and it has
      // to be gone for a screen reader too or the dial for a level you are not
      // on is still in the reading order.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
      pointerEvents={open ? 'box-none' : 'none'}
      style={[
        styles.reveal,
        height === undefined ? null : { height },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    left: space.lg,
    position: 'absolute',
    right: space.lg,
    top: space.xl,
  },
  /*
   * Seats for the animated lines. Each is exactly the height the engine lays
   * its line out at, so the header's rhythm is the same as it was with RN text
   * and nothing reflows while a morph is in the air.
   */
  eyebrowSlot: { height: OVERLAY_KNOBS.EYEBROW_ROW_PX },
  titleSlot: {
    height: OVERLAY_KNOBS.TITLE_ROW_PX,
    marginTop: space.sm,
  },
  /** The count takes the room the action does not, and morphs inside it. */
  metaCount: { flex: 1 },
  /*
   * Overlaid, not flexed: at L0 the action is empty but still mounted (so the
   * shelf's word can unwrite on exit), and a flexed 190 px slot steals that
   * width from the count — `8 SONGS · 3 GROUPS` clipped to `8 SONGS · 3` on
   * device. Absolute keeps the erase seat while the count gets the full row.
   * Overlap is safe: at L1 the count is just `N SONGS`, short and
   * left-aligned, while the action is right-aligned ink in its own 190 px.
   */
  actionSlot: {
    bottom: 0,
    position: 'absolute',
    right: 0,
    width: OVERLAY_KNOBS.ACTION_WIDTH_PX,
  },
  hintSlot: { height: OVERLAY_KNOBS.EYEBROW_ROW_PX, marginTop: space.md },
  // `ORDER` names the dial beside it, the way `WEEK · MONTH · YEAR` sits under
  // the axis it belongs to. Drawn in `line` rather than `faint`: it is a label
  // for a control, not a value, and it must not compete with the words it names.
  orderRow: { alignItems: 'center', flexDirection: 'row', marginTop: space.md },
  orderLabel: { marginRight: space.md },
  // The count and the shelf's bulk action share one line, at opposite ends:
  // what is here, and the one thing you can do to all of it.
  metaRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    marginTop: space.sm,
    position: 'relative',
  },
  // No `gap`: a flex gap is spent even on a zero-height child, so a collapsed
  // resolution row would still push the dial up by 8. Children carry their own.
  foot: {
    bottom: OVERLAY_KNOBS.FOOT_INSET_PX,
    left: space.lg,
    position: 'absolute',
    right: space.lg,
  },
  // The dial owns the space under its words so the tick has somewhere to sit.
  dial: { paddingBottom: OVERLAY_KNOBS.TICK_GAP_PX },
  dialRow: { flexDirection: 'row', gap: space.md },
  tick: {
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
  },
  reveal: { overflow: 'hidden' },
  dialItem: { paddingVertical: space.xs },
  resolution: { ...type.eyebrow, fontSize: 9, letterSpacing: 1.4 },
  alert: {
    bottom: OVERLAY_KNOBS.ALERT_INSET_PX,
    left: space.lg,
    position: 'absolute',
    right: space.lg,
  },
  tab: {
    alignItems: 'center',
    alignSelf: 'center',
    gap: OVERLAY_KNOBS.TAB_LABEL_GAP_PX,
    height: OVERLAY_KNOBS.TAB_REACH_PX,
    position: 'absolute',
    // The word sets the width now; the slats keep their own inside it.
    width: OVERLAY_KNOBS.TAB_LABEL_WIDTH_PX,
  },
  tabTop: {
    justifyContent: 'flex-start',
    top: OVERLAY_KNOBS.TAB_EDGE_INSET_PX,
  },
  tabBottom: {
    bottom: OVERLAY_KNOBS.TAB_EDGE_INSET_PX,
    justifyContent: 'flex-end',
  },
  tabSlats: {
    alignItems: 'center',
    gap: OVERLAY_KNOBS.TAB_SLAT_GAP_PX,
    width: OVERLAY_KNOBS.TAB_WIDTH_PX,
  },
  tabSlat: { height: StyleSheet.hairlineWidth },
  tabLabel: {
    ...type.eyebrow,
    fontSize: OVERLAY_KNOBS.TAB_LABEL_SIZE_PX,
    letterSpacing: OVERLAY_KNOBS.TAB_LABEL_TRACKING_PX,
    textAlign: 'center',
  },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const FieldOverlay = React.memo(FieldOverlayImpl);
