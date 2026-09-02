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
import { easeSmoother } from '../../motion';
import {
  ARRANGEMENTS,
  DATE_RESOLUTIONS,
  SONG_ORDERS,
  byTime,
  type DateResolution,
  type Level,
} from '../../field';
import { space, touch, type, usePalette } from '../../theme/tokens';

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
 * The two tabs are 48 px because that is `touch.min`: the mark for a gesture is
 * exactly as wide as the smallest thing a finger is expected to find.
 */
const OVERLAY_KNOBS = {
  TAB_WIDTH_PX: touch.min,
  TAB_TICK_WIDTH_PX: 8,
  TAB_TICK_GAP_PX: 4,
  TAB_EDGE_INSET_PX: space.sm,
  /** Clear of the origin mark, which sits `space.lg` up from the same edge. */
  FOOT_INSET_PX: 40,
  /** High enough to clear the dial at L0 and the player's transport at L2. */
  ALERT_INSET_PX: 150,
  /** How far a tab's body reaches back into the screen from its edge. */
  TAB_REACH_PX: 28,
  /**
   * Added to that body in every direction to make a finger's target.
   *
   * `touch.min` is 48: a 28 px body plus 20 either side clears it with room,
   * and it costs the drawing nothing because slop is not layout.
   */
  TAB_HIT_SLOP_PX: 20,
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
        colour={pal.line}
        edge="top"
        onPress={onOpenComposer}
      />
      {showHeader ? (
        // box-none, not none: the count is not touchable but the shelf action
        // beside it is, and it is the only thing in this corner that is.
        <View style={styles.header} pointerEvents="box-none">
          <Text style={[type.eyebrow, { color: pal.muted }]} pointerEvents="none">
            L{LEVELS[level].index} · {LEVELS[level].name}
          </Text>
          <Text
            style={[type.title, styles.title, { color: pal.ink }]}
            pointerEvents="none"
          >
            {level === 'shelf' ? groupLabel ?? 'Group' : 'Field'}
          </Text>
          <View style={styles.metaRow} pointerEvents="box-none">
            <Text
              style={[type.eyebrow, { color: pal.faint }]}
              pointerEvents="none"
            >
              {metaLine(
                level,
                songCount,
                groupCount,
                onDateAxis,
                dateResolution,
              )}
              {offline ? ' · OFFLINE' : ''}
            </Text>
            {level === 'shelf' && shelfAction !== null ? (
              <Pressable
                accessibilityLabel={shelfAction}
                accessibilityRole="button"
                hitSlop={space.md}
                onPress={onShelfAction}
              >
                {({ pressed }) => (
                  <Text
                    style={[
                      type.eyebrow,
                      { color: pressed ? pal.muted : pal.ink },
                    ]}
                  >
                    {shelfAction}
                  </Text>
                )}
              </Pressable>
            ) : null}
          </View>
          {level === 'shelf' ? (
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
          ) : null}
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
          {level === 'field' ? (
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
          ) : null}
          <Text style={[type.eyebrow, styles.hint, { color: pal.faint }]}>
            {level === 'field'
              ? `${HINTS.field} ${
                  onDateAxis ? CLUSTER_NOUN[dateResolution] : 'PLAYLIST'
                }`
              : HINTS.shelf}
          </Text>
        </View>
      ) : null}
      <EdgeTab
        accessibilityLabel="Open engines"
        colour={pal.line}
        edge="bottom"
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
  const noun = onDateAxis ? CLUSTER_NOUN[resolution] : 'PLAYLIST';
  return `${songs} · ${groupCount} ${noun}${groupCount === 1 ? '' : 'S'}`;
}

/**
 * The mark for a pull.
 *
 * A gesture nobody can see is a gesture nobody uses, so each pull gets a
 * hairline and a tick on the edge it belongs to — the same object at both
 * edges, because it is the same gesture. It is also a button: a screen reader
 * and a finger that misses the drag both still have a door.
 *
 * The body is `TAB_REACH_PX` tall and grows *inward* from the edge, with the
 * hairline pinned to the outer end. `hitSlop` cannot do this job: on Android
 * it does not reliably enlarge an absolutely positioned view, so the real
 * target would be the hairline itself — which at the bottom sits inside the
 * system's own gesture strip, where a tap opens the launcher instead.
 */
function EdgeTab({
  accessibilityLabel,
  colour,
  edge,
  onPress,
}: {
  accessibilityLabel: string;
  colour: string;
  edge: 'top' | 'bottom';
  onPress: () => void;
}) {
  const line = (
    <View
      key="line"
      pointerEvents="none"
      style={[styles.tabLine, { backgroundColor: colour }]}
    />
  );
  const tick = (
    <View
      key="tick"
      pointerEvents="none"
      style={[styles.tabTick, { backgroundColor: colour }]}
    />
  );
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      // The mark is a hairline and a tick; the *target* has to be a finger's
      // worth of screen. The bottom tab measured three device-independent
      // pixels tall — which is why nothing could ever be made to press it —
      // while the identical top one measured twenty-eight. Slop rather than
      // height, so the drawn mark stays exactly where the design puts it.
      hitSlop={OVERLAY_KNOBS.TAB_HIT_SLOP_PX}
      onPress={onPress}
      style={[styles.tab, edge === 'top' ? styles.tabTop : styles.tabBottom]}
    >
      {edge === 'top' ? [line, tick] : [tick, line]}
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
 * A row that rises into space already kept for it.
 *
 * The foot is anchored to the bottom of the screen and stacks upward, so a row
 * that mounts at full height shoves the axis above it up in one frame — which
 * is the jump this replaces. The seat is therefore permanent: the dial above
 * sits at the same height on every axis, and only the row's own ink arrives
 * and leaves.
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
  height,
  open,
}: {
  children: React.ReactNode;
  height: number;
  open: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const amount = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const to = open ? 1 : 0;
    amount.value = reducedMotion
      ? to
      : withTiming(to, {
          duration: OVERLAY_KNOBS.RESOLUTION_MS,
          easing: easeSmoother,
        });
  }, [amount, open, reducedMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: amount.value,
    transform: [
      { translateY: (1 - amount.value) * OVERLAY_KNOBS.REVEAL_RISE_PX },
    ],
  }));
  return (
    <Animated.View
      pointerEvents={open ? 'box-none' : 'none'}
      style={[styles.reveal, { height }, style]}
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
  title: { marginTop: space.sm },
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
    justifyContent: 'space-between',
    marginTop: space.sm,
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
  hint: { marginTop: space.md, textAlign: 'center' },
  tab: {
    alignItems: 'center',
    alignSelf: 'center',
    gap: OVERLAY_KNOBS.TAB_TICK_GAP_PX,
    height: OVERLAY_KNOBS.TAB_REACH_PX,
    position: 'absolute',
    width: OVERLAY_KNOBS.TAB_WIDTH_PX,
  },
  tabTop: {
    justifyContent: 'flex-start',
    top: OVERLAY_KNOBS.TAB_EDGE_INSET_PX,
  },
  tabBottom: {
    bottom: OVERLAY_KNOBS.TAB_EDGE_INSET_PX,
    justifyContent: 'flex-end',
  },
  tabLine: {
    height: StyleSheet.hairlineWidth,
    width: OVERLAY_KNOBS.TAB_WIDTH_PX,
  },
  tabTick: {
    height: StyleSheet.hairlineWidth,
    width: OVERLAY_KNOBS.TAB_TICK_WIDTH_PX,
  },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const FieldOverlay = React.memo(FieldOverlayImpl);
