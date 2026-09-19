import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { Caret, REVEAL_KNOBS } from '../controls';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS — how a membership is drawn, and how it changes. */
export const MEMBERSHIP_KNOBS = {
  /**
   * The seat one name takes. Nothing a finger chooses is shorter than 48 dp,
   * and a scroll container clips `hitSlop` outside its bounds — so the target
   * is the row's real height rather than padding hung off a shorter one.
   */
  ITEM_PX: touch.min,
  /**
   * How long the tick takes to draw on or erase, and the ink to arrive with it.
   *
   * The dial's own number. A membership and a dial position are the same
   * gesture — a hairline saying *this one* — so they move at the same speed.
   * The word's colour rides the same clock: a name that goes black the instant
   * it is touched while its hairline is still drawing is two marks, not one.
   */
  TICK_MS: 220,
  /** Between names when they run as a line rather than a column. */
  INLINE_GAP_PX: space.md,
  /**
   * How long a seat takes to open or close.
   *
   * `Reveal`'s measure, and the caret's: the peel is one gesture made of a
   * chevron turning, seats growing and ink arriving, and those three finishing
   * at three different moments is what made a tap read as a shove.
   */
  PEEL_MS: REVEAL_KNOBS.MS,
} as const;

export type MembershipEntry = Readonly<{ name: string; member: boolean }>;

/**
 * Whether the names stand in a column or run as a line.
 *
 * The two arrangements are the design, not a style: a playlist answers *where
 * does this live* and a tag answers *what is this like*, so places are a
 * column you scan down and words are a line you read across. Sharing one
 * component is what keeps them the same control; taking two flows is what
 * keeps them from being mistaken for each other.
 *
 * It is also which way a closed seat collapses. A column reclaims its height;
 * a line reclaims its width, because a name of no height in a wrapping row
 * still holds its place along the line.
 */
export type MembershipFlow = 'column' | 'inline';

type Props = {
  /** Every name that exists, each carrying whether this song holds it. */
  entries: readonly MembershipEntry[];
  flow: MembershipFlow;
  busy: boolean;
  /** True when the song is at the node's tag bound and may take no more. */
  full: boolean;
  /** What the unopened field says: `new playlist`, or `add a tag`. */
  addPlaceholder: string;
  /** The quiet line under the peeled block; the shared count, when it matters. */
  note?: string;
  /** Why a typed name cannot be used, or null. Checked before it is sent. */
  problemOf?: (name: string) => string | null;
  onToggle: (name: string, member: boolean) => void;
};

/**
 * The names a song carries, and every name it could.
 *
 * Tapping is the whole control: a name you hold is ink with a hairline under
 * it, a name you do not is faint with none, and a tap moves it between the two
 * while the tick draws on or erases. Neither direction is privileged, so
 * neither direction needs a button — which is what `Remove from Dog walk`
 * used to be, a whole row spent on one half of one membership, filed beside
 * removing a download and ending a song.
 *
 * At rest only the names the song holds are drawn. The caret peels the rest of
 * the vocabulary down under them, with the typed field last, because the
 * common case is reaching for a word you already use rather than inventing
 * one.
 *
 * **Every name keeps one seat, and keeps it in one place.** The list used to
 * be cut into the names held and the names not, so choosing a name moved it
 * from the second list to the first: it was unmounted and rebuilt, which threw
 * away the tick it was in the middle of drawing and shunted every row past it
 * by 48 px. Order is therefore taken once, in `useStableOrder`, and is
 * append-only afterwards — a tap changes a name's ink and nothing else's
 * anything. What the peel does is open the seats of the names the song does
 * not hold; those seats grow and shrink on their own measured size, so the
 * space arrives over the same beat as the ink in it rather than in one frame
 * ahead of it.
 */
function MembershipImpl({
  entries,
  flow,
  busy,
  full,
  addPlaceholder,
  note,
  problemOf,
  onToggle,
}: Props) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const field = useRef<TextInput>(null);
  const ordered = useStableOrder(entries);
  const held = entries.some(entry => entry.member);
  const trimmed = draft.trim();
  const problem =
    trimmed.length === 0 || problemOf === undefined
      ? null
      : problemOf(trimmed);

  const submit = () => {
    if (trimmed.length === 0 || problem !== null || full) return;
    onToggle(trimmed, true);
    setDraft('');
  };

  const peel = useCallback(() => {
    setOpen(value => {
      // A field inside a folded seat is unreachable but still focused, and the
      // keyboard it raised does not know that. Fold the field away first.
      if (value) field.current?.blur();
      return !value;
    });
  }, []);

  return (
    <View>
      <View style={styles.head}>
        <View style={flow === 'inline' ? styles.inline : styles.names}>
          {/*
            The honest empty line, which the vocabulary replaces rather than
            sits above: once every name is showing, `In no playlist.` reads as
            one of them.
          */}
          <Seat
            axis={flow === 'inline' ? 'width' : 'height'}
            open={!held && !(open && ordered.length > 0)}
          >
            <View style={styles.item}>
              <Text style={[type.body, { color: pal.faint }]}>
                {flow === 'column' ? 'In no playlist.' : 'No tags.'}
              </Text>
            </View>
          </Seat>
          {ordered.map(entry => (
            <Seat
              axis={flow === 'inline' ? 'width' : 'height'}
              key={entry.name}
              open={entry.member || open}
            >
              <Name
                busy={busy || (!entry.member && full)}
                flow={flow}
                member={entry.member}
                name={entry.name}
                onPress={() => onToggle(entry.name, !entry.member)}
              />
            </Seat>
          ))}
        </View>
        {/*
          The peel control sits at the right edge of the value column, level
          with the first name: a chevron is a control you have read before you
          have finished reading it, and one line of words fewer in a block
          whose subject is the words.
        */}
        <Pressable
          accessibilityLabel={open ? 'Fold the list away' : 'Show every name'}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={space.sm}
          onPress={peel}
          style={styles.peelTab}>
          <Caret colour={pal.faint} direction={open ? 'up' : 'down'} />
        </Pressable>
      </View>

      <Seat axis="height" open={open}>
        <TextInput
          accessibilityLabel={addPlaceholder}
          editable={!busy && !full}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          placeholder={full ? 'no room for another' : addPlaceholder}
          placeholderTextColor={pal.faint}
          ref={field}
          returnKeyType="done"
          style={[styles.add, type.mono, { color: pal.ink }]}
          value={draft}
        />
        {problem === null ? null : (
          <Text style={[type.mono, styles.note, { color: pal.muted }]}>
            {problem}
          </Text>
        )}
        {note === undefined ? null : (
          <Text style={[type.eyebrow, styles.note, { color: pal.faint }]}>
            {note}
          </Text>
        )}
      </Seat>
    </View>
  );
}

/**
 * The order the names are drawn in: the one they first arrived in, for as long
 * as this sheet is open.
 *
 * The incoming order is *held first, then the rest*, which is the reading the
 * block wants at rest — but it is recomputed from the song's own tags, so the
 * name you just chose jumps to the top of the list under your finger. Taking
 * it once and appending anything new keeps that reading (nothing is held yet
 * that was not held when the sheet opened, so the names on top are still the
 * ones on top) while making a tap cost no movement at all.
 */
function useStableOrder(
  entries: readonly MembershipEntry[],
): readonly MembershipEntry[] {
  const seen = useRef<string[]>([]);
  return useMemo(() => {
    for (const entry of entries) {
      if (!seen.current.includes(entry.name)) seen.current.push(entry.name);
    }
    const rank = new Map(seen.current.map((name, index) => [name, index]));
    return [...entries].sort(
      (a, b) => (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0),
    );
  }, [entries]);
}

/**
 * A seat that grows to hold what is in it, or shrinks to nothing.
 *
 * `Reveal` reserves its seat and only animates the ink, because the row it was
 * written for sits in a stack whose height must not move. A peel is the
 * opposite case: the space is exactly what is arriving, and a block that
 * mounts at full height shoves everything below it down in one frame while its
 * own ink is still fading in — two clocks on one gesture.
 *
 * So the child is measured at its natural size and the seat animates to that
 * number. The child never shrinks with the seat (`flexShrink: 0`); it
 * overflows and is clipped, which is what keeps a word from re-wrapping itself
 * on every frame of the close. Before the first measurement the seat is either
 * natural or nothing, never a guess.
 */
function Seat({
  axis,
  children,
  open,
}: {
  /**
   * Which way it collapses: a column gives back height, a line gives back
   * width — and its height with it, because a name of no width in a wrapping
   * row still holds a line open behind it.
   */
  axis: 'height' | 'width';
  children: React.ReactNode;
  open: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const amount = useSharedValue(open ? 1 : 0);
  const down = useSharedValue(0);
  const across = useSharedValue(0);
  useEffect(() => {
    const to = open ? 1 : 0;
    amount.value = reducedMotion
      ? to
      : withTiming(to, {
          duration: MEMBERSHIP_KNOBS.PEEL_MS,
          easing: easeSmoother,
        });
  }, [amount, open, reducedMotion]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height, width } = event.nativeEvent.layout;
      down.value = height;
      across.value = width;
    },
    [across, down],
  );
  const faded = useAnimatedStyle(() => ({
    opacity: amount.value,
    // Pinned to what it measured, once it has. An absolute child is still
    // offered the room its seat has left, so a name in a closing seat re-wraps
    // itself onto two lines on the way out — `No tags.` breaking after `No`
    // is what this is. Height is never pinned: it is the measurement.
    ...(axis === 'width' && across.value > 0
      ? { width: across.value }
      : null),
  }));
  const grown = useAnimatedStyle(() =>
    axis === 'height'
      ? { height: amount.value * down.value }
      : {
          height: amount.value * down.value,
          width: amount.value * across.value,
        },
  );
  return (
    <Animated.View
      // A folded seat is gone as far as a finger is concerned, and it has to be
      // gone for a screen reader too: `Reveal`'s rule, for the same reason.
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
      pointerEvents={open ? 'box-none' : 'none'}
      style={[axis === 'height' ? styles.seatColumn : styles.seatRow, grown]}
    >
      <Animated.View
        onLayout={onLayout}
        style={[
          axis === 'height' ? styles.naturalColumn : styles.naturalRow,
          faded,
        ]}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

/**
 * One name, the hairline that says the song holds it, and the ink of both.
 *
 * The tick travels rather than appearing, for the reason the dial's does: the
 * mark is one object changing, not two marks taking turns. The word darkens on
 * the same value — one gesture, one clock.
 */
function Name({
  name,
  flow,
  member,
  busy,
  onPress,
}: {
  name: string;
  flow: MembershipFlow;
  member: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  const amount = useSharedValue(member ? 1 : 0);
  useEffect(() => {
    const to = member ? 1 : 0;
    amount.value = reducedMotion
      ? to
      : withTiming(to, {
          duration: MEMBERSHIP_KNOBS.TICK_MS,
          easing: easeSmoother,
        });
  }, [amount, member, reducedMotion]);
  const tick = useAnimatedStyle(() => ({
    transform: [{ scaleX: amount.value }],
  }));
  const inked = useAnimatedStyle(() => ({
    color: interpolateColor(amount.value, [0, 1], [pal.faint, pal.ink]),
  }));
  return (
    <Pressable
      accessibilityLabel={member ? `Remove from ${name}` : `Add to ${name}`}
      accessibilityRole="button"
      accessibilityState={{ selected: member, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={flow === 'inline' ? styles.inlineItem : styles.item}>
      <View style={styles.word}>
        <Animated.Text style={[type.body, inked]}>{name}</Animated.Text>
        <Animated.View
          style={[styles.tick, { backgroundColor: pal.ink }, tick]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start' },
  /**
   * The names take the value column and the caret is pushed off its end, which
   * is where `marginLeft: auto` was already putting it. Said as a measure
   * rather than as a leftover because the seats inside hold nothing in flow:
   * without a width of its own the block would have none to give them.
   */
  names: { flex: 1 },
  /**
   * No `columnGap`: the gap between names is paid inside each seat, so a seat
   * that has closed to no width leaves no gap behind it either.
   */
  inline: { flex: 1, flexDirection: 'row', flexWrap: 'wrap' },
  item: { justifyContent: 'center', minHeight: MEMBERSHIP_KNOBS.ITEM_PX },
  inlineItem: {
    justifyContent: 'center',
    minHeight: MEMBERSHIP_KNOBS.ITEM_PX,
    paddingRight: MEMBERSHIP_KNOBS.INLINE_GAP_PX,
  },
  /**
   * The word and its hairline, as wide as the word.
   *
   * Every seat in a column is as wide as the widest name in the block, so a
   * tick left to stretch would run out past the end of the word it underlines
   * — by the width of whichever other name happens to be the longest.
   */
  word: { alignSelf: 'flex-start' },
  /**
   * Clipped, and holding nothing in flow: the seat's whole size is the number
   * being animated, and the thing it holds is laid out beside that argument
   * rather than inside it. A child left in flow is measured *through* the seat
   * — a seat closed to nothing reports a child of nothing, which is a latch
   * that never opens again.
   */
  seatColumn: { overflow: 'hidden' },
  seatRow: { overflow: 'hidden' },
  /** Its width is the seat's; its height is its own, which is the measurement. */
  naturalColumn: { left: 0, position: 'absolute', right: 0, top: 0 },
  /** Both its own, for a name that gives back width rather than height. */
  naturalRow: { left: 0, position: 'absolute', top: 0 },
  tick: {
    bottom: 3,
    height: StyleSheet.hairlineWidth,
    left: 0,
    position: 'absolute',
    right: 0,
    transformOrigin: 'left',
  },
  peelTab: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 'auto',
    minHeight: MEMBERSHIP_KNOBS.ITEM_PX,
    minWidth: space.lg,
  },
  add: { minHeight: MEMBERSHIP_KNOBS.ITEM_PX, paddingVertical: 0 },
  note: { marginTop: space.xs },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const Membership = React.memo(MembershipImpl);
