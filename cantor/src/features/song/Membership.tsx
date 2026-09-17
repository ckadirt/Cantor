import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { easeSmoother } from '../../motion';
import { Caret, Reveal } from '../controls';
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
   * How long the tick takes to draw on or erase.
   *
   * The dial's own number. A membership and a dial position are the same
   * gesture — a hairline saying *this one* — so they move at the same speed.
   */
  TICK_MS: 220,
  /** Between names when they run as a line rather than a column. */
  INLINE_GAP_PX: space.md,
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
 * one. The peel mounts rather than animating its height — Reanimated cannot
 * drive a layout prop without snapping, which `Reveal` documents — so the
 * space arrives on the tap that asked for it and only the ink rises into it.
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
  const mine = entries.filter(entry => entry.member);
  const others = entries.filter(entry => !entry.member);
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

  return (
    <View>
      <View style={styles.head}>
        <View style={flow === 'inline' ? styles.inline : undefined}>
          {mine.length === 0 ? (
            <View style={styles.item}>
              <Text style={[type.body, { color: pal.faint }]}>
                {flow === 'column' ? 'In no playlist.' : 'No tags.'}
              </Text>
            </View>
          ) : (
            mine.map(entry => (
              <Name
                busy={busy}
                key={entry.name}
                member
                name={entry.name}
                onPress={() => onToggle(entry.name, false)}
              />
            ))
          )}
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
          onPress={() => setOpen(value => !value)}
          style={styles.peelTab}>
          <Caret colour={pal.faint} direction={open ? 'up' : 'down'} />
        </Pressable>
      </View>

      {open ? (
        <Reveal open>
          <View style={flow === 'inline' ? styles.inline : undefined}>
            {others.map(entry => (
              <Name
                busy={busy || full}
                key={entry.name}
                member={false}
                name={entry.name}
                onPress={() => onToggle(entry.name, true)}
              />
            ))}
          </View>
          <TextInput
            accessibilityLabel={addPlaceholder}
            editable={!busy && !full}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder={full ? 'no room for another' : addPlaceholder}
            placeholderTextColor={pal.faint}
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
        </Reveal>
      ) : null}
    </View>
  );
}

/**
 * One name, and the hairline that says the song holds it.
 *
 * The tick travels rather than appearing, for the reason the dial's does: the
 * mark is one object changing, not two marks taking turns.
 */
function Name({
  name,
  member,
  busy,
  onPress,
}: {
  name: string;
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
  return (
    <Pressable
      accessibilityLabel={member ? `Remove from ${name}` : `Add to ${name}`}
      accessibilityRole="button"
      accessibilityState={{ selected: member, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={styles.item}>
      <View>
        <Text style={[type.body, { color: member ? pal.ink : pal.faint }]}>
          {name}
        </Text>
        <Animated.View
          style={[styles.tick, { backgroundColor: pal.ink }, tick]}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start' },
  inline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: MEMBERSHIP_KNOBS.INLINE_GAP_PX,
  },
  item: { justifyContent: 'center', minHeight: MEMBERSHIP_KNOBS.ITEM_PX },
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
