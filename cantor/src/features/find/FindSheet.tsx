import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FieldLayout, Placement, TagCount, TagFilter } from '../../field';
import type { Lens } from '../../lenses';
import {
  findIn,
  matchRanges,
  type FindIndex,
  type FindResult,
} from '../../library/find';
import {
  Coda,
  Dial,
  Door,
  FOLIO_ACT_STYLE,
  FOLIO_META_STYLE,
  FOLIO_NOTE_STYLE,
  FOLIO_TITLE_STYLE,
  FolioHead,
  LEDGER_DIAL_ITEM,
  Measure,
  PanelPressable,
  Rest,
  Row,
  SongClef,
  Stave,
  type SongClefSong,
} from '../controls';
import { filterPhrase } from '../field/filterWords';
import { font, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the find blind, drawn as a Folio like every other blind
 * (`folio.html`): the head with its clef, a stave of measures on the spine,
 * and a coda for the page's one act. A found song is a roster row — its face
 * on the spine, its name a door — the way a node is on the nodes page.
 */
export const FIND_KNOBS = {
  /** A song's face against the spine, as a node's station stands there. */
  ROW_FACE_PX: 34,
  /** The clef: up to four faces, two by two, as the nodes page draws its own. */
  CLEF_FACE_PX: 28,
  CLEF_GAP_PX: 4,
  CLEF_FACES: 4,
  /** A tag's mark against the spine: chosen is filled, unchosen a ring. */
  TAG_DOT_PX: 7,
  TAG_NAME_SIZE_PX: 20,
  /**
   * The most rows a find draws. Each face is a small canvas; past a page or
   * two of matches, the next letter is a better way down than a scroll.
   */
  MAX_ROWS: 60,
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

  // The clef is a drawing of the page's subject: the songs it is about —
  // what was found, or before anything is typed, what the map shows.
  const clefSongs = useMemo(() => {
    if (source === undefined || layout === null) return [];
    const placements =
      result === null
        ? layout.placements
        : result.groups.flatMap(group => group.placements);
    const seen = new Set<string>();
    const songs: SongClefSong[] = [];
    for (const placement of placements) {
      if (songs.length >= FIND_KNOBS.CLEF_FACES) break;
      if (seen.has(placement.entityKey)) continue;
      const row = source.describe(placement);
      if (row === null) continue;
      seen.add(placement.entityKey);
      songs.push(row.clef);
    }
    return songs;
  }, [layout, result, source]);

  return (
    <View style={styles.root}>
      <FolioHead
        clef={
          source === undefined ? null : (
            <FoundClef lens={source.lens} songs={clefSongs} />
          )
        }
        eyebrow={eyebrow}
        meta={
          <Text
            accessibilityLiveRegion="polite"
            style={[FOLIO_META_STYLE, styles.meta, { color: pal.faint }]}
          >
            {countLine}
          </Text>
        }
        nav={{
          label: 'CLOSE',
          accessibilityLabel: 'Close find',
          onPress: onClose,
        }}
        title={
          <TextInput
            ref={input}
            accessibilityLabel="Find a song"
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder="a song…"
            placeholderTextColor={pal.faint}
            returnKeyType="search"
            style={[FOLIO_TITLE_STYLE, styles.query, { color: pal.ink }]}
            underlineColorAndroid="transparent"
            value={query}
          />
        }
        titleWritesItself
      />
      <Stave keyboardShouldPersistTaps="handled">
        {typing && result !== null && source !== undefined ? (
          <Results
            onWiden={() => setWide(true)}
            query={query}
            result={result}
            scoped={scoped}
            source={source}
          />
        ) : !typing ? (
          <TagPage
            chosen={chosen}
            filter={filter}
            onMode={mode => onChangeFilter({ ...filter, mode })}
            onToggle={toggle}
            tags={tags}
          />
        ) : null}
      </Stave>
      <Coda>
        {filtering && !typing ? (
          <PanelPressable
            accessibilityLabel={`Show every song, not only ${filterPhrase(
              filter,
            ).text.toLocaleLowerCase()}`}
            accessibilityRole="button"
            onPress={() => onChangeFilter({ tags: [], mode: 'any' })}
            style={styles.act}
          >
            <Text style={[FOLIO_ACT_STYLE, { color: pal.ink }]}>
              Show every song
            </Text>
          </PanelPressable>
        ) : null}
      </Coda>
    </View>
  );
}

/** Up to four of the page's songs, two by two, against the spine. */
function FoundClef({
  songs,
  lens,
}: {
  songs: readonly SongClefSong[];
  lens: Lens;
}) {
  if (songs.length === 0) return null;
  return (
    <View style={styles.clef}>
      {songs.map(song => (
        <SongClef
          key={song.id}
          lens={lens}
          size={FIND_KNOBS.CLEF_FACE_PX}
          song={song}
        />
      ))}
    </View>
  );
}

/** The empty query's page: how the tags join, then the tags themselves. */
function TagPage({
  tags,
  filter,
  chosen,
  onToggle,
  onMode,
}: {
  tags: readonly TagCount[];
  filter: TagFilter;
  chosen: ReadonlySet<string>;
  onToggle: (tag: string) => void;
  onMode: (mode: TagFilter['mode']) => void;
}) {
  const pal = usePalette();
  if (tags.length === 0) {
    return (
      <Measure>
        <Row label="Only show">
          <Text style={[type.body, { color: pal.muted }]}>
            No song has a tag yet. Hold a song to give it one.
          </Text>
        </Row>
      </Measure>
    );
  }
  return (
    <>
      <Measure>
        {filter.tags.length >= 2 ? (
          <Row label="Songs with" control>
            <Dial
              compact
              activeColour={pal.ink}
              activeKey={filter.mode}
              itemStyle={LEDGER_DIAL_ITEM}
              items={[
                {
                  key: 'any',
                  label: 'ANY OF THEM',
                  accessibilityLabel: 'Songs with any of these tags',
                },
                {
                  key: 'all',
                  label: 'ALL OF THEM',
                  accessibilityLabel: 'Songs with all of these tags',
                },
              ]}
              onSelect={key => onMode(key as TagFilter['mode'])}
              restColour={pal.faint}
              textStyle={styles.dialWord}
              tickColour={pal.ink}
            />
          </Row>
        ) : (
          <Row label="Only show">
            <Text style={[type.body, { color: pal.muted }]}>
              {filter.tags.length === 1
                ? `Songs tagged ${filter.tags[0].trim()}.`
                : 'Songs with the tags you choose.'}
            </Text>
          </Row>
        )}
      </Measure>
      <Rest />
      <Measure>
        {tags.map(({ tag, count }) => {
          const on = chosen.has(fold(tag));
          return (
            <Row
              key={tag}
              mark={
                <View
                  style={[
                    styles.dot,
                    on
                      ? { backgroundColor: pal.ink }
                      : [styles.ring, { borderColor: pal.faint }],
                  ]}
                />
              }
            >
              <PanelPressable
                accessibilityLabel={`${tag}, ${count} ${
                  count === 1 ? 'song' : 'songs'
                }`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => onToggle(tag)}
                style={styles.tagTarget}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.tagName, { color: on ? pal.ink : pal.faint }]}
                >
                  {tag}
                </Text>
                <Text
                  style={[
                    FOLIO_NOTE_STYLE,
                    { color: on ? pal.muted : pal.faint },
                  ]}
                >
                  {`${count} ${count === 1 ? 'SONG' : 'SONGS'}`}
                </Text>
              </PanelPressable>
            </Row>
          );
        })}
      </Measure>
    </>
  );
}

type FoundSong = Readonly<{ placement: Placement; row: FindRow }>;

/**
 * The matches as roster rows, in the order the map is cut: groups as the axis
 * seats them, rows in the shelf's ORDER. One measure, not one per group — a
 * find across weeks is mostly one song a week, and a spine broken after every
 * row read as rubble. Each row names its group in its note instead, so a row
 * read alone still says where it is. Inside a shelf the group goes without
 * saying, and a last measure offers the rest of the field.
 */
function Results({
  result,
  source,
  query,
  scoped,
  onWiden,
}: {
  result: FindResult;
  source: FindSource;
  query: string;
  scoped: boolean;
  onWiden: () => void;
}) {
  const pal = usePalette();
  const groups = useMemo(() => {
    let left: number = FIND_KNOBS.MAX_ROWS;
    const list: { key: string; label: string; songs: FoundSong[] }[] = [];
    for (const group of result.groups) {
      if (left <= 0) break;
      const songs: FoundSong[] = [];
      for (const placement of group.placements) {
        if (left <= 0) break;
        const row = source.describe(placement);
        if (row === null) continue;
        songs.push({ placement, row });
        left -= 1;
      }
      if (songs.length > 0) {
        list.push({
          key: group.groupKey,
          label: source.groupName(group.label),
          songs,
        });
      }
    }
    return list;
  }, [result, source]);
  if (groups.length === 0) {
    return (
      <Measure>
        <Row>
          <Text style={[type.body, { color: pal.muted }]}>
            {`No song begins a word with “${query.trim()}”.`}
          </Text>
        </Row>
      </Measure>
    );
  }
  const drawn = groups.reduce((sum, group) => sum + group.songs.length, 0);
  const plural = `${source.noun}S`.toLocaleLowerCase();
  return (
    <>
      <Measure>
        {groups.flatMap(group =>
          group.songs.map(({ placement, row }) => (
            <FoundEntry
              key={placement.key}
              group={scoped ? null : group.label}
              lens={source.lens}
              onPress={() => source.onArrive(placement)}
              query={query}
              row={row}
            />
          )),
        )}
      </Measure>
      {drawn < result.count ? (
        <>
          <Rest />
          <Measure>
            <Row>
              <Text style={[type.small, { color: pal.muted }]}>
                {`${result.count - drawn} more. Another letter narrows them.`}
              </Text>
            </Row>
          </Measure>
        </>
      ) : null}
      {result.outside > 0 ? (
        <>
          <Rest />
          <Measure>
            <Row>
              <Door
                accessibilityLabel={`${result.outside} more in other ${plural}`}
                label={`${result.outside} more in other ${plural}`}
                onPress={onWiden}
              />
            </Row>
          </Measure>
        </>
      ) : null}
    </>
  );
}

/** One found song: its face on the spine, its name a door, its place under. */
function FoundEntry({
  row,
  query,
  group,
  lens,
  onPress,
}: {
  row: FindRow;
  query: string;
  /** The group, said first in the note; null inside the shelf searched. */
  group: string | null;
  lens: Lens;
  onPress: () => void;
}) {
  const pal = usePalette();
  // Found by the caption rather than the name: the caption is the reason, so
  // it is what the row says under the name.
  const byCaption =
    matchRanges(row.title, query).length === 0 &&
    row.caption != null &&
    matchRanges(row.caption, query).length > 0;
  const note = [group, row.line].filter(part => part !== null).join(' · ');
  return (
    <Row
      mark={
        <SongClef lens={lens} size={FIND_KNOBS.ROW_FACE_PX} song={row.clef} />
      }
    >
      <Door
        accessibilityLabel={`${row.title}, ${
          byCaption ? row.caption : note
        }. Go to the song`}
        label={row.title}
        name
        onPress={onPress}
      />
      {byCaption ? (
        <Text
          numberOfLines={2}
          style={[type.small, styles.caption, { color: pal.muted }]}
        >
          {`“${row.caption}”`}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={[FOLIO_NOTE_STYLE, { color: pal.muted }]}>
        {note.toUpperCase()}
      </Text>
    </Row>
  );
}

function fold(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  query: {
    includeFontPadding: false,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  meta: { lineHeight: 16 },
  clef: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: FIND_KNOBS.CLEF_GAP_PX,
    justifyContent: 'flex-end',
    width: FIND_KNOBS.CLEF_FACE_PX * 2 + FIND_KNOBS.CLEF_GAP_PX,
  },
  dialWord: { ...type.eyebrow, fontSize: 12, letterSpacing: 0 },
  dot: {
    borderRadius: FIND_KNOBS.TAG_DOT_PX / 2,
    height: FIND_KNOBS.TAG_DOT_PX,
    width: FIND_KNOBS.TAG_DOT_PX,
  },
  ring: { borderWidth: StyleSheet.hairlineWidth * 2 },
  tagTarget: { alignItems: 'flex-start', justifyContent: 'center' },
  tagName: { fontFamily: font.display, fontSize: FIND_KNOBS.TAG_NAME_SIZE_PX },
  caption: { marginBottom: 2 },
  act: { alignItems: 'flex-start', justifyContent: 'center' },
});
