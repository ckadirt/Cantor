import React, { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { TagCount, TagFilter } from '../../field';
import { Arrive, ARRIVAL_KNOBS, PanelPressable } from '../controls';
import { CURTAIN_KNOBS, useKeyboardInset } from '../curtain';
import { filterPhrase } from '../field/filterWords';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the find blind, as the study draws it (`search-variants.html`,
 * B·2 and B·3), at the seats the field's own header uses so the blind's
 * three lines land where the map's were.
 */
export const FIND_KNOBS = {
  /**
   * Above the eyebrow, inside the blind's seat gap: together they put the
   * eyebrow where the field's stands (`space.xl` from the top).
   */
  HEAD_TOP_PX: space.xl - CURTAIN_KNOBS.SEAT_GAP_PX,
  EYEBROW_ROW_PX: 15,
  /** The query line: the title's face and size, on a hairline. */
  QUERY_ROW_PX: 44,
  QUERY_RULE_PX: StyleSheet.hairlineWidth,
  /** `OR ONLY SHOW` and `ANY · ALL`, at a quieter size than the eyebrow. */
  LIST_HEAD_SIZE_PX: 10,
  LIST_HEAD_TOP_PX: 30,
  /** One tag per row: a dot, its name in the display face, its count. */
  TAG_ROW_PX: 52,
  TAG_NAME_SIZE_PX: 21,
  TAG_DOT_PX: 7,
  TAG_DOT_GAP_PX: 12,
  /** Between the ANY and ALL words. */
  MODE_GAP_PX: 14,
} as const;

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * The shelf the blind was opened from, named as the header named it, or
   * null when it was opened on the map.
   */
  scopeLabel: string | null;
  /** Every song in the library, and how many the filter leaves on the map. */
  libraryCount: number;
  shownCount: number;
  filter: TagFilter;
  /**
   * Narrow the map. The blind covers it completely while a tag can be
   * pressed, so the screen applies each change out of sight; what the blind
   * shows is only its count.
   */
  onChangeFilter: (next: TagFilter) => void;
  /** Every tag in the library with its song count, chosen or not. */
  tags: readonly TagCount[];
};

/**
 * Find and filter, behind one word (find-plan, decision 9). The title is the
 * query line. With nothing typed the page lists the tags; typing turns it
 * into results. Never both at once.
 */
export function FindSheet({
  open,
  onClose,
  scopeLabel,
  libraryCount,
  shownCount,
  filter,
  onChangeFilter,
  tags,
}: Props) {
  const pal = usePalette();
  const keyboard = useKeyboardInset();
  const [query, setQuery] = useState('');
  const input = useRef<TextInput>(null);
  // Each opening starts blank, with the keyboard down: the tags have the
  // whole page until the query line is touched.
  useEffect(() => {
    if (open) {
      setQuery('');
      return;
    }
    input.current?.blur();
    Keyboard.dismiss();
  }, [open]);

  const typing = query.trim().length > 0;
  const chosen = new Set(filter.tags.map(fold));
  const toggle = (tag: string) => {
    const key = fold(tag);
    const next = chosen.has(key)
      ? filter.tags.filter(each => fold(each) !== key)
      : [...filter.tags, tag];
    onChangeFilter({ tags: next, mode: next.length < 2 ? 'any' : filter.mode });
  };
  const filtering = filter.tags.length > 0;
  const count = filtering
    ? `${shownCount} OF ${libraryCount} ${
        libraryCount === 1 ? 'SONG' : 'SONGS'
      } WOULD SHOW`
    : `${libraryCount} ${libraryCount === 1 ? 'SONG' : 'SONGS'}`;
  const eyebrow =
    scopeLabel === null ? 'FIND' : `FIND IN ${scopeLabel.toUpperCase()}`;

  return (
    <View style={styles.root}>
      <Arrive from={ARRIVAL_KNOBS.LINES_FROM} to={ARRIVAL_KNOBS.LINES_TO}>
        <View style={styles.eyebrowRow}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={[type.eyebrow, styles.eyebrow, { color: pal.muted }]}
          >
            {eyebrow}
          </Text>
          <PanelPressable
            accessibilityLabel="Close find"
            accessibilityRole="button"
            hitSlop={space.md}
            onPress={onClose}
            style={styles.close}
          >
            <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
          </PanelPressable>
        </View>
      </Arrive>
      <Arrive from={ARRIVAL_KNOBS.TITLE_FROM} to={ARRIVAL_KNOBS.TITLE_TO}>
        <TextInput
          ref={input}
          accessibilityLabel="Find a song"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder="a song…"
          placeholderTextColor={pal.faint}
          returnKeyType="search"
          style={[styles.query, { color: pal.ink }]}
          underlineColorAndroid="transparent"
          value={query}
        />
        <View
          style={[
            styles.queryRule,
            { backgroundColor: typing ? pal.ink : pal.line },
          ]}
        />
        <Text style={[type.eyebrow, styles.count, { color: pal.faint }]}>
          {count}
        </Text>
      </Arrive>
      {typing ? null : (
        <TagList
          bottomInset={keyboard}
          filter={filter}
          chosen={chosen}
          onClear={() => onChangeFilter({ tags: [], mode: 'any' })}
          onMode={mode => onChangeFilter({ ...filter, mode })}
          onToggle={toggle}
          tags={tags}
        />
      )}
    </View>
  );
}

/** The empty query's page: the library's tags, one per row. */
function TagList({
  tags,
  filter,
  chosen,
  onToggle,
  onMode,
  onClear,
  bottomInset,
}: {
  tags: readonly TagCount[];
  filter: TagFilter;
  chosen: ReadonlySet<string>;
  onToggle: (tag: string) => void;
  onMode: (mode: TagFilter['mode']) => void;
  onClear: () => void;
  bottomInset: number;
}) {
  const pal = usePalette();
  if (tags.length === 0) {
    return (
      <Text style={[type.small, styles.noTags, { color: pal.muted }]}>
        No song has a tag yet. Hold a song to give it one.
      </Text>
    );
  }
  const modes: readonly TagFilter['mode'][] = ['any', 'all'];
  return (
    <>
      <View style={styles.listHead}>
        <Text style={[styles.listHeadText, { color: pal.faint }]}>
          OR ONLY SHOW
        </Text>
        {/* The mode means nothing until there are two tags to join. */}
        {filter.tags.length >= 2 ? (
          <View style={styles.modes}>
            {modes.map(mode => (
              <Pressable
                key={mode}
                accessibilityLabel={
                  mode === 'any'
                    ? 'Songs with any of these tags'
                    : 'Songs with all of these tags'
                }
                accessibilityRole="button"
                accessibilityState={{ selected: filter.mode === mode }}
                hitSlop={space.md}
                onPress={() => onMode(mode)}
              >
                <Text
                  style={[
                    styles.listHeadText,
                    { color: filter.mode === mode ? pal.ink : pal.faint },
                  ]}
                >
                  {mode.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomInset }}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
      >
        {tags.map(({ tag, count }) => {
          const on = chosen.has(fold(tag));
          return (
            <Pressable
              key={tag}
              accessibilityLabel={`${tag}, ${count} ${
                count === 1 ? 'song' : 'songs'
              }`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              onPress={() => onToggle(tag)}
              style={[styles.tagRow, { borderBottomColor: pal.line }]}
            >
              <View style={styles.tagName}>
                <View
                  style={[
                    styles.dot,
                    on
                      ? { backgroundColor: pal.ink }
                      : [styles.ring, { borderColor: pal.faint }],
                  ]}
                />
                <Text
                  numberOfLines={1}
                  style={[styles.tagWord, { color: on ? pal.ink : pal.faint }]}
                >
                  {tag}
                </Text>
              </View>
              <Text
                style={[styles.listHeadText, { color: on ? pal.ink : pal.faint }]}
              >
                {count}
              </Text>
            </Pressable>
          );
        })}
        {filter.tags.length > 0 ? (
          <PanelPressable
            accessibilityLabel={`Clear the filter, ${filterPhrase(
              filter,
            ).text.toLocaleLowerCase()}`}
            accessibilityRole="button"
            onPress={onClear}
            style={styles.clear}
          >
            <Text style={[type.eyebrow, { color: pal.muted }]}>CLEAR</Text>
          </PanelPressable>
        ) : null}
      </ScrollView>
    </>
  );
}

function fold(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: FIND_KNOBS.HEAD_TOP_PX },
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: FIND_KNOBS.EYEBROW_ROW_PX,
    justifyContent: 'space-between',
  },
  eyebrow: { flex: 1 },
  close: { minHeight: 0, minWidth: 0 },
  query: {
    fontFamily: font.display,
    fontSize: type.title.fontSize,
    height: FIND_KNOBS.QUERY_ROW_PX,
    marginTop: space.sm,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  queryRule: { height: FIND_KNOBS.QUERY_RULE_PX },
  count: { marginTop: space.sm },
  listHead: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: FIND_KNOBS.LIST_HEAD_TOP_PX,
  },
  listHeadText: {
    fontFamily: font.mono,
    fontSize: FIND_KNOBS.LIST_HEAD_SIZE_PX,
    letterSpacing: 1.6,
  },
  modes: { flexDirection: 'row', gap: FIND_KNOBS.MODE_GAP_PX },
  list: { flex: 1 },
  tagRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: FIND_KNOBS.TAG_ROW_PX,
    justifyContent: 'space-between',
  },
  tagName: { alignItems: 'center', flex: 1, flexDirection: 'row' },
  dot: {
    borderRadius: FIND_KNOBS.TAG_DOT_PX / 2,
    height: FIND_KNOBS.TAG_DOT_PX,
    marginRight: FIND_KNOBS.TAG_DOT_GAP_PX,
    width: FIND_KNOBS.TAG_DOT_PX,
  },
  ring: { borderWidth: 1 },
  tagWord: {
    flex: 1,
    fontFamily: font.display,
    fontSize: FIND_KNOBS.TAG_NAME_SIZE_PX,
  },
  clear: {
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: touch.min,
  },
  noTags: { marginTop: FIND_KNOBS.LIST_HEAD_TOP_PX },
});
