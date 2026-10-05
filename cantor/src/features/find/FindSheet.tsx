import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { FieldLayout, Placement, TagCount, TagFilter } from '../../field';
import type { Lens } from '../../lenses';
import {
  findIn,
  matchRanges,
  type FindIndex,
  type FindResult,
} from '../../library/find';
import {
  Arrive,
  ARRIVAL_KNOBS,
  PanelPressable,
  SongClef,
  type SongClefSong,
} from '../controls';
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
  /**
   * A result is a shelf row: the face, then the name over its place. The
   * study seats them at 98 and 155 dp from the screen's edge; these are from
   * the blind's content edge, which is already `space.lg` in.
   */
  RESULT_ROW_PX: 64,
  RESULT_FACE_CENTRE_PX: 98 - space.lg,
  RESULT_NAME_PX: 155 - space.lg,
  RESULT_FACE_PX: 30,
  RESULT_NAME_SIZE_PX: 17.5,
  RESULT_LINE_SIZE_PX: 8.6,
  /** A group's name, where the group changes, in small faint mono. */
  GROUP_ROW_PX: 30,
  RESULTS_TOP_PX: 22,
} as const;

/** What a result row says about its song. */
export type FindRow = Readonly<{
  title: string;
  /** Under the name: who made it, how long it is, and its tags. */
  line: string;
  /**
   * A generated song's caption summary, said instead of `line` when the
   * query matched it rather than the name — so a row says why it is here.
   */
  caption?: string | null;
  clef: SongClefSong;
}>;

/** What the blind needs to find, and to say what it found. */
export type FindSource = Readonly<{
  /** The layout the map draws, which is the filtered one. */
  layout: FieldLayout | null;
  index: FindIndex;
  /** A song's row, or null for a mark that is not a song. */
  describe: (placement: Placement) => FindRow | null;
  /** A group's label as the header says it (`Sep 21 – 27`). */
  groupName: (label: string) => string;
  /** The axis's noun, singular: `WEEK`, `PLAYLIST`. */
  noun: string;
  lens: Lens;
  /** Close the blind and go to the song: flown to its shelf, then into it. */
  onArrive: (placement: Placement) => void;
}>;

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
  /** The shelf the blind was opened in, by key, for the scope of a find. */
  scopeKey?: string | null;
  source?: FindSource;
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
  scopeKey = null,
  source,
}: Props) {
  const pal = usePalette();
  const keyboard = useKeyboardInset();
  const [query, setQuery] = useState('');
  /** Widened past the shelf it was opened in, by the last row's offer. */
  const [wide, setWide] = useState(false);
  const input = useRef<TextInput>(null);
  // Each opening starts blank, with the keyboard down: the tags have the
  // whole page until the query line is touched.
  useEffect(() => {
    if (open) {
      setQuery('');
      setWide(false);
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
  const scoped = scopeKey !== null && scopeLabel !== null && !wide;
  const layout = source?.layout ?? null;
  // Per keystroke, over folded words only: the index is built once per
  // library change by the screen. Find never re-cuts the map.
  const result: FindResult | null = useMemo(
    () =>
      !typing || layout === null || source === undefined
        ? null
        : findIn(
            layout,
            source.index,
            query,
            scoped ? { groupKey: scopeKey } : null,
          ),
    [layout, query, scopeKey, scoped, source, typing],
  );
  const scopeSize = scoped
    ? layout?.groups.find(group => group.key === scopeKey)?.songCount ?? 0
    : 0;
  const found = result?.count ?? 0;
  const countLine = !typing
    ? count
    : scoped
    ? `${found} OF ${scopeSize} ${scopeSize === 1 ? 'SONG' : 'SONGS'}`
    : filtering
    ? `${found} IN ${filterPhrase(filter).text}`
    : `${found} ${found === 1 ? 'SONG' : 'SONGS'}`;
  const eyebrow = !scoped
    ? 'FIND'
    : `FIND IN ${(scopeLabel ?? '').toUpperCase()}`;

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
        <Text
          accessibilityLiveRegion="polite"
          style={[type.eyebrow, styles.count, { color: pal.faint }]}
        >
          {countLine}
        </Text>
      </Arrive>
      {typing && result !== null && source !== undefined ? (
        <Results
          bottomInset={keyboard}
          grouped={!scoped}
          onWiden={() => setWide(true)}
          query={query}
          result={result}
          source={source}
        />
      ) : null}
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
                style={[
                  styles.listHeadText,
                  { color: on ? pal.ink : pal.faint },
                ]}
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

type ResultItem =
  | Readonly<{ kind: 'group'; key: string; label: string }>
  | Readonly<{ kind: 'row'; key: string; placement: Placement; row: FindRow }>
  | Readonly<{ kind: 'more'; key: string; count: number }>;

/**
 * The matches as shelf rows, grouped the way the map is cut: a group's name
 * where the group changes, rows in the shelf's ORDER under it. Inside a shelf
 * there are no group names, and a last row offers the rest of the field.
 */
function Results({
  result,
  source,
  query,
  grouped,
  onWiden,
  bottomInset,
}: {
  result: FindResult;
  source: FindSource;
  query: string;
  grouped: boolean;
  onWiden: () => void;
  bottomInset: number;
}) {
  const pal = usePalette();
  const items = useMemo(() => {
    const list: ResultItem[] = [];
    for (const group of result.groups) {
      const rows = group.placements.flatMap(placement => {
        const row = source.describe(placement);
        return row === null ? [] : [{ placement, row }];
      });
      if (rows.length === 0) continue;
      if (grouped) {
        list.push({
          kind: 'group',
          key: `group:${group.groupKey}`,
          label: source.groupName(group.label),
        });
      }
      for (const { placement, row } of rows) {
        list.push({ kind: 'row', key: placement.key, placement, row });
      }
    }
    if (result.outside > 0) {
      list.push({ kind: 'more', key: 'more', count: result.outside });
    }
    return list;
  }, [grouped, result, source]);
  if (items.length === 0) {
    return (
      <Text style={[type.small, styles.noTags, { color: pal.muted }]}>
        {`No song begins a word with “${query.trim()}”.`}
      </Text>
    );
  }
  const plural = `${source.noun}S`;
  return (
    <FlatList
      accessibilityRole="list"
      contentContainerStyle={{ paddingBottom: bottomInset }}
      data={items}
      initialNumToRender={12}
      keyExtractor={item => item.key}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      renderItem={({ item }) =>
        item.kind === 'group' ? (
          <Text
            accessibilityRole="header"
            style={[styles.groupName, { color: pal.faint }]}
          >
            {item.label.toUpperCase()}
          </Text>
        ) : item.kind === 'more' ? (
          <PanelPressable
            accessibilityLabel={`${
              item.count
            } more in other ${plural.toLocaleLowerCase()}`}
            accessibilityRole="button"
            onPress={onWiden}
            style={styles.more}
          >
            <Text style={[styles.moreText, { color: pal.muted }]}>
              {`${item.count} MORE IN OTHER ${plural}`}
            </Text>
          </PanelPressable>
        ) : (
          <ResultRow
            lens={source.lens}
            onPress={() => source.onArrive(item.placement)}
            query={query}
            row={item.row}
            group={source.groupName(
              source.layout?.groups.find(
                group => group.key === item.placement.groupKey,
              )?.label ?? '',
            )}
          />
        )
      }
      style={styles.results}
    />
  );
}

function ResultRow({
  row,
  query,
  group,
  lens,
  onPress,
}: {
  row: FindRow;
  query: string;
  group: string;
  lens: Lens;
  onPress: () => void;
}) {
  const pal = usePalette();
  const ranges = matchRanges(row.title, query);
  // The matched starts in ink and the rest in grey; a song found by its
  // caption or its maker has no start in its name, and reads in ink whole.
  const spans: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) {
      spans.push({ text: row.title.slice(at, range.start), hit: false });
    }
    spans.push({ text: row.title.slice(range.start, range.end), hit: true });
    at = range.end;
  }
  if (at < row.title.length) {
    spans.push({ text: row.title.slice(at), hit: ranges.length === 0 });
  }
  const byCaption =
    ranges.length === 0 &&
    row.caption != null &&
    matchRanges(row.caption, query).length > 0;
  const under = byCaption ? row.caption ?? '' : row.line;
  return (
    <Pressable
      accessibilityLabel={`${row.title}, ${group}, ${under}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.resultRow}
    >
      {({ pressed }) => (
        <>
          <View pointerEvents="none" style={styles.face}>
            <SongClef
              lens={lens}
              size={FIND_KNOBS.RESULT_FACE_PX}
              song={row.clef}
            />
          </View>
          <View style={styles.resultText}>
            <Text numberOfLines={1} style={styles.resultName}>
              {spans.map((span, index) => (
                <Text
                  key={index}
                  style={{
                    color: pressed ? pal.muted : span.hit ? pal.ink : pal.faint,
                  }}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.resultLine, { color: pal.muted }]}
            >
              {byCaption ? `“${under}”` : under.toUpperCase()}
            </Text>
          </View>
        </>
      )}
    </Pressable>
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
  results: { flex: 1, marginTop: FIND_KNOBS.RESULTS_TOP_PX },
  groupName: {
    fontFamily: font.mono,
    fontSize: FIND_KNOBS.RESULT_LINE_SIZE_PX,
    letterSpacing: 1.4,
    lineHeight: FIND_KNOBS.GROUP_ROW_PX,
    paddingLeft: FIND_KNOBS.RESULT_NAME_PX,
  },
  resultRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: FIND_KNOBS.RESULT_ROW_PX,
  },
  face: {
    alignItems: 'center',
    height: FIND_KNOBS.RESULT_FACE_PX,
    justifyContent: 'center',
    left: FIND_KNOBS.RESULT_FACE_CENTRE_PX - FIND_KNOBS.RESULT_FACE_PX / 2,
    position: 'absolute',
    width: FIND_KNOBS.RESULT_FACE_PX,
  },
  resultText: { flex: 1, marginLeft: FIND_KNOBS.RESULT_NAME_PX },
  resultName: {
    fontFamily: font.display,
    fontSize: FIND_KNOBS.RESULT_NAME_SIZE_PX,
  },
  resultLine: {
    fontFamily: font.mono,
    fontSize: FIND_KNOBS.RESULT_LINE_SIZE_PX,
    letterSpacing: 1.2,
    marginTop: 3,
  },
  more: { justifyContent: 'center', minHeight: touch.min },
  moreText: {
    fontFamily: font.mono,
    fontSize: FIND_KNOBS.LIST_HEAD_SIZE_PX,
    letterSpacing: 1.6,
    paddingLeft: FIND_KNOBS.RESULT_NAME_PX,
  },
});
