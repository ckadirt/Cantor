import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ARRANGEMENTS,
  DATE_RESOLUTIONS,
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

/** What one cluster is, so the L0 hint names the thing you are opening. */
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
        <View style={styles.header} pointerEvents="none">
          <Text style={[type.eyebrow, { color: pal.muted }]}>
            L{LEVELS[level].index} · {LEVELS[level].name}
          </Text>
          <Text style={[type.title, styles.title, { color: pal.ink }]}>
            {level === 'shelf' ? groupLabel ?? 'Group' : 'Field'}
          </Text>
          <Text style={[type.eyebrow, styles.meta, { color: pal.faint }]}>
            {metaLine(level, songCount, groupCount, onDateAxis, dateResolution)}
            {offline ? ' · OFFLINE' : ''}
          </Text>
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
              <View style={styles.dial} pointerEvents="box-none">
                {ARRANGEMENTS.map(arrangement => (
                  <DialItem
                    active={arrangement.key === arrangementKey}
                    key={arrangement.key}
                    label={arrangement.label.toUpperCase()}
                    accessibilityLabel={`Arrange by ${arrangement.label}`}
                    onPress={() => onChangeArrangement(arrangement.key)}
                    activeColour={pal.ink}
                    restColour={pal.faint}
                    style={type.eyebrow}
                  />
                ))}
              </View>
              {/*
              Resolution sits under the axis it belongs to, because it is a
              property of that axis rather than a fourth arrangement.
            */}
              {onDateAxis ? (
                <View style={styles.dial} pointerEvents="box-none">
                  {DATE_RESOLUTIONS.map(resolution => (
                    <DialItem
                      active={resolution === dateResolution}
                      key={resolution}
                      label={CLUSTER_NOUN[resolution]}
                      accessibilityLabel={`Group dates by ${resolution}`}
                      onPress={() => onChangeDateResolution(resolution)}
                      activeColour={pal.muted}
                      restColour={pal.line}
                      style={styles.resolution}
                    />
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
          <Text style={[type.eyebrow, styles.hint, { color: pal.faint }]}>
            {level === 'field'
              ? `${HINTS.field} ${
                  CLUSTER_NOUN[onDateAxis ? dateResolution : 'week']
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
      onPress={onPress}
      style={[styles.tab, edge === 'top' ? styles.tabTop : styles.tabBottom]}
    >
      {edge === 'top' ? [line, tick] : [tick, line]}
    </Pressable>
  );
}

function DialItem({
  accessibilityLabel,
  active,
  activeColour,
  label,
  onPress,
  restColour,
  style,
}: {
  accessibilityLabel: string;
  active: boolean;
  activeColour: string;
  label: string;
  onPress: () => void;
  restColour: string;
  style: object;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={space.sm}
      onPress={onPress}
      style={styles.dialItem}
    >
      <Text style={[style, { color: active ? activeColour : restColour }]}>
        {label}
      </Text>
    </Pressable>
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
  meta: { marginTop: space.sm },
  foot: {
    bottom: OVERLAY_KNOBS.FOOT_INSET_PX,
    gap: space.sm,
    left: space.lg,
    position: 'absolute',
    right: space.lg,
  },
  dial: { flexDirection: 'row', gap: space.md },
  dialItem: { paddingVertical: space.xs },
  resolution: { ...type.eyebrow, fontSize: 9, letterSpacing: 1.4 },
  alert: {
    bottom: OVERLAY_KNOBS.ALERT_INSET_PX,
    left: space.lg,
    position: 'absolute',
    right: space.lg,
  },
  hint: { marginTop: space.xs, textAlign: 'center' },
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
