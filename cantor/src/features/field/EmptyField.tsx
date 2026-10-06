import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SHELF_BOX, type TagFilter } from '../../field';
import { Caret, FOLIO_KNOBS, PanelPressable, PhoneSealMark } from '../controls';
import { font, space, touch, type, usePalette } from '../../theme/tokens';
import { emptyFilterSentence } from './filterWords';

/** KNOBS — the field with nothing in it (`flow.html#f-empty`, I7i). */
export const EMPTY_FIELD_KNOBS = {
  /** The doors' column, centred under the sentence. */
  WIDTH_PX: 236,
  /** Between the seal, the sentence and the doors. */
  GAP_PX: 22,
  DOOR_NAME_PX: 20,
  DOOR_LINE_PX: 24,
} as const;

/**
 * The field when there is not a single song in it: no node's, none of the
 * phone's, no job. Someone without a node has nothing else to do on day one,
 * so the field offers the two doors it has — bring the phone's music in, or
 * pair a node. Gone as soon as there is one song.
 *
 * Laid out in the screen, not the world: there is nothing for the camera to
 * move, so nothing here follows it.
 */
export function EmptyField({
  publicKey,
  onBringIn,
  onPair,
}: {
  publicKey: string;
  onBringIn: () => void;
  onPair: () => void;
}) {
  const pal = usePalette();
  return (
    <View pointerEvents="box-none" style={styles.root}>
      <View style={styles.column}>
        <PhoneSealMark
          faint
          publicKey={publicKey}
          size={FOLIO_KNOBS.CLEF_PX}
          spindle
        />
        <Text style={[type.body, styles.sentence, { color: pal.ink }]}>
          Your music is already on this phone. Cantor can play it where it lies.
        </Text>
        <View style={[styles.doors, { borderColor: pal.line }]}>
          <EmptyDoor label="Bring it in" onPress={onBringIn} />
          <EmptyDoor label="Pair a node" muted onPress={onPair} />
        </View>
      </View>
    </View>
  );
}

/**
 * The map when the tag filter has left nothing on it: *No songs are rainy and
 * live*, and the one way back. Not `EmptyField`'s doors — the library is not
 * empty, and offering to bring music in would say it was.
 */
export function EmptyFilter({
  filter,
  onClear,
}: {
  filter: TagFilter;
  onClear: () => void;
}) {
  const pal = usePalette();
  return (
    <View pointerEvents="box-none" style={styles.root}>
      <View style={styles.column}>
        <Text style={[type.body, styles.sentence, { color: pal.ink }]}>
          {emptyFilterSentence(filter)}
        </Text>
        <Pressable
          accessibilityLabel="Clear the filter"
          accessibilityRole="button"
          onPress={onClear}
          style={styles.clear}
        >
          {({ pressed }) => (
            <Text
              style={[type.eyebrow, { color: pressed ? pal.muted : pal.ink }]}
            >
              CLEAR
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Find with a query that found nothing: said under the header, where the
 * found shelf would stand, and above the keyboard. Find looks inside the
 * filter, so a filtered map says so.
 */
export function EmptyFind({
  query,
  filtered,
}: {
  query: string;
  filtered: boolean;
}) {
  const pal = usePalette();
  return (
    <View pointerEvents="none" style={styles.findRoot}>
      <Text
        accessibilityLiveRegion="polite"
        style={[type.body, styles.findSentence, { color: pal.muted }]}
      >
        {emptyFindSentence(query, filtered)}
      </Text>
    </View>
  );
}

/** `No song begins a word with “piax”.` */
export function emptyFindSentence(query: string, filtered: boolean): string {
  return `No song${filtered ? ' on this map' : ''} begins a word with “${query.trim()}”.`;
}

function EmptyDoor({
  label,
  muted = false,
  onPress,
}: {
  label: string;
  /** The second way, in muted ink: the phone's music is the first. */
  muted?: boolean;
  onPress: () => void;
}) {
  const pal = usePalette();
  const colour = muted ? pal.muted : pal.ink;
  return (
    <PanelPressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.door, { borderColor: pal.line }]}
    >
      <Text style={[styles.doorName, { color: colour }]}>{label}</Text>
      <View style={styles.caretSeat}>
        <Caret colour={colour} direction="right" />
      </View>
    </PanelPressable>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    justifyContent: 'center',
  },
  column: {
    alignItems: 'center',
    gap: EMPTY_FIELD_KNOBS.GAP_PX,
    width: EMPTY_FIELD_KNOBS.WIDTH_PX,
  },
  sentence: { textAlign: 'center' },
  findRoot: {
    left: space.lg,
    position: 'absolute',
    right: space.lg,
    top: SHELF_BOX.TOP_PX + space.lg,
  },
  findSentence: { textAlign: 'left' },
  clear: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
    minWidth: touch.min * 2,
  },
  doors: { alignSelf: 'stretch', borderTopWidth: StyleSheet.hairlineWidth },
  door: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: touch.min,
  },
  doorName: {
    fontFamily: font.display,
    fontSize: EMPTY_FIELD_KNOBS.DOOR_NAME_PX,
    lineHeight: EMPTY_FIELD_KNOBS.DOOR_LINE_PX,
  },
  caretSeat: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'center',
    marginRight: space.xs,
    width: 18,
  },
});
