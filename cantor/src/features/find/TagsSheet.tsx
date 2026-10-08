import React, { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import type { TagCount, TagFilter } from '../../field';
import { Dial, PanelPressable } from '../controls';
import { FOLIO_ACT_STYLE } from '../controls/Folio';
import { filterPhrase } from '../field/filterWords';
import { font, space, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the tags page, set like a book's index (find-motion.html frame I,
 * gather-plan decision 9): a running head, then one line per tag — its mark,
 * its name, a dotted leader, and its count where a page number would be.
 * Distances in dp from the page's left edge, which is the field header's.
 */
export const TAGS_KNOBS = {
  /** The mark's centre, and its size: chosen is filled, unchosen a ring. */
  MARK_CENTRE_PX: 8,
  MARK_PX: 7,
  /** Where a tag's name starts. */
  NAME_LEFT_PX: 26,
  NAME_SIZE_PX: 19,
  /** One tag's line, and the running head's distance above the first. */
  ROW_PX: 40,
  HEAD_GAP_PX: 18,
  /** The leader: a dot every so often, kept clear of the words it joins. */
  LEADER_PITCH_PX: 4,
  LEADER_CLEAR_PX: 8,
  /** The leader's height on the line, from its top: near the baseline. */
  LEADER_DROP_PX: 4,
  /** Below the head, before the running head. */
  BODY_TOP_PX: 28,
  /**
   * The head on the field header's own seats: the blind's content starts
   * below where the header's eyebrow does (its grip and seat gap), so the
   * head is set by this much. Measured on the Xiaomi.
   */
  HEAD_TOP_PX: 6,
  /** The header's line heights: eyebrow, title, count (`OVERLAY_KNOBS`). */
  EYEBROW_ROW_PX: 15,
  TITLE_ROW_PX: 36,
} as const;

type Props = {
  onClose: () => void;
  /** Every song in the library, and how many the filter leaves on the map. */
  libraryCount: number;
  shownCount: number;
  filter: TagFilter;
  /**
   * Narrow the map. The blind covers it completely while a tag can be
   * pressed, so the screen applies each change out of sight.
   */
  onChangeFilter: (next: TagFilter) => void;
  /** Every tag in the library with its song count, chosen or not. */
  tags: readonly TagCount[];
};

/**
 * The tags, as an index: which songs the map shows. Opened from the count
 * line's tag words, on the map or in find before a letter.
 */
export function TagsSheet({
  onClose,
  libraryCount,
  shownCount,
  filter,
  onChangeFilter,
  tags,
}: Props) {
  const pal = usePalette();
  const chosen = new Set(filter.tags.map(fold));
  const toggle = (tag: string) => {
    const key = fold(tag);
    const next = chosen.has(key)
      ? filter.tags.filter(each => fold(each) !== key)
      : [...filter.tags, tag];
    onChangeFilter({ tags: next, mode: next.length < 2 ? 'any' : filter.mode });
  };
  const filtering = filter.tags.length > 0;
  const songs = (n: number) => `${n} ${n === 1 ? 'SONG' : 'SONGS'}`;
  const count = filtering
    ? `${shownCount} OF ${songs(libraryCount)} WOULD SHOW`
    : `${songs(libraryCount)} · ${tags.length} ${
        tags.length === 1 ? 'TAG' : 'TAGS'
      }`;
  return (
    <View style={styles.root}>
      <View style={styles.eyebrowRow}>
        <Text style={[type.eyebrow, { color: pal.muted }]}>ONLY SHOW</Text>
        <PanelPressable
          accessibilityLabel="Close the tags"
          accessibilityRole="button"
          hitSlop={space.md}
          onPress={onClose}
        >
          <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
        </PanelPressable>
      </View>
      <Text
        numberOfLines={1}
        style={[type.title, styles.title, { color: pal.ink }]}
      >
        {filtering ? sentenceCase(filterPhrase(filter).text) : 'Every song'}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        style={[type.eyebrow, styles.count, { color: pal.faint }]}
      >
        {count}
      </Text>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {filter.tags.length >= 2 ? (
          <View style={styles.join}>
            <Text style={[type.body, { color: pal.muted }]}>Songs with</Text>
            <Dial
              compact
              activeColour={pal.ink}
              activeKey={filter.mode}
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
              onSelect={key =>
                onChangeFilter({ ...filter, mode: key as TagFilter['mode'] })
              }
              restColour={pal.faint}
              textStyle={styles.dialWord}
              tickColour={pal.ink}
            />
          </View>
        ) : null}
        <RunningHead label="TAGS" />
        {tags.length === 0 ? (
          <Text style={[type.body, styles.none, { color: pal.muted }]}>
            No song has a tag yet. Hold a song to give it one.
          </Text>
        ) : (
          tags.map(({ tag, count: n }) => (
            <TagLine
              key={tag}
              chosen={chosen.has(fold(tag))}
              count={n}
              onPress={() => toggle(tag)}
              tag={tag}
            />
          ))
        )}
      </ScrollView>
      {filtering ? (
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
    </View>
  );
}

/** A running head: the section's word in faint mono, then a hairline to the edge. */
function RunningHead({ label }: { label: string }) {
  const pal = usePalette();
  return (
    <View style={styles.runningHead}>
      <Text style={[styles.runningWord, { color: pal.faint }]}>{label}</Text>
      <View style={[styles.runningRule, { backgroundColor: pal.line }]} />
    </View>
  );
}

/** One tag: its mark, its name, a leader, and how many songs carry it. */
function TagLine({
  tag,
  count,
  chosen,
  onPress,
}: {
  tag: string;
  count: number;
  chosen: boolean;
  onPress: () => void;
}) {
  const pal = usePalette();
  return (
    <PanelPressable
      accessibilityLabel={`${tag}, ${count} ${count === 1 ? 'song' : 'songs'}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: chosen }}
      onPress={onPress}
      style={styles.line}
    >
      <View
        style={[
          styles.mark,
          chosen
            ? { backgroundColor: pal.ink }
            : [styles.ring, { borderColor: pal.faint }],
        ]}
      />
      <Text
        numberOfLines={1}
        style={[styles.name, { color: chosen ? pal.ink : pal.muted }]}
      >
        {tag}
      </Text>
      <Leader colour={pal.line} />
      <Text style={[styles.number, { color: chosen ? pal.muted : pal.faint }]}>
        {String(count)}
      </Text>
    </PanelPressable>
  );
}

/** Dots at a fixed pitch across whatever the line leaves between its words. */
function Leader({ colour }: { colour: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) =>
    setWidth(event.nativeEvent.layout.width);
  const dots = Math.max(0, Math.floor(width / TAGS_KNOBS.LEADER_PITCH_PX));
  return (
    <View onLayout={onLayout} pointerEvents="none" style={styles.leader}>
      {Array.from({ length: dots }, (_, index) => (
        <View
          key={index}
          style={[
            styles.dot,
            {
              backgroundColor: colour,
              left: index * TAGS_KNOBS.LEADER_PITCH_PX,
            },
          ]}
        />
      ))}
    </View>
  );
}

/** `RAINY OR LIVE` → `Rainy or live`: the filter said as a title. */
function sentenceCase(text: string): string {
  const lower = text.toLocaleLowerCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

function fold(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

const styles = StyleSheet.create({
  root: { flex: 1, marginTop: TAGS_KNOBS.HEAD_TOP_PX },
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: TAGS_KNOBS.EYEBROW_ROW_PX,
    justifyContent: 'space-between',
  },
  title: {
    height: TAGS_KNOBS.TITLE_ROW_PX,
    includeFontPadding: false,
    lineHeight: TAGS_KNOBS.TITLE_ROW_PX,
    marginTop: space.sm,
    textAlignVertical: 'center',
  },
  count: {
    height: TAGS_KNOBS.EYEBROW_ROW_PX,
    includeFontPadding: false,
    marginTop: space.sm,
  },
  body: { paddingBottom: space.xl, paddingTop: TAGS_KNOBS.BODY_TOP_PX },
  join: {
    alignItems: 'center',
    columnGap: space.md,
    flexDirection: 'row',
    marginBottom: space.lg,
  },
  dialWord: { ...type.eyebrow, fontSize: 12, letterSpacing: 0 },
  runningHead: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: TAGS_KNOBS.HEAD_GAP_PX,
    paddingLeft: TAGS_KNOBS.NAME_LEFT_PX,
  },
  runningWord: { fontFamily: font.mono, fontSize: 9, letterSpacing: 2 },
  runningRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    marginLeft: 10,
  },
  none: { paddingLeft: TAGS_KNOBS.NAME_LEFT_PX },
  line: {
    alignItems: 'center',
    flexDirection: 'row',
    height: TAGS_KNOBS.ROW_PX,
  },
  mark: {
    borderRadius: TAGS_KNOBS.MARK_PX / 2,
    height: TAGS_KNOBS.MARK_PX,
    marginLeft: TAGS_KNOBS.MARK_CENTRE_PX - TAGS_KNOBS.MARK_PX / 2,
    marginRight:
      TAGS_KNOBS.NAME_LEFT_PX -
      TAGS_KNOBS.MARK_CENTRE_PX -
      TAGS_KNOBS.MARK_PX / 2,
    width: TAGS_KNOBS.MARK_PX,
  },
  ring: { borderWidth: StyleSheet.hairlineWidth * 2 },
  name: {
    flexShrink: 1,
    fontFamily: font.display,
    fontSize: TAGS_KNOBS.NAME_SIZE_PX,
  },
  leader: {
    alignSelf: 'stretch',
    flex: 1,
    marginHorizontal: TAGS_KNOBS.LEADER_CLEAR_PX,
  },
  dot: {
    height: 1,
    position: 'absolute',
    top: TAGS_KNOBS.ROW_PX / 2 + TAGS_KNOBS.LEADER_DROP_PX,
    width: 1,
  },
  number: { fontFamily: font.mono, fontSize: 10, letterSpacing: 1.6 },
  act: {
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingBottom: space.xl,
    paddingTop: space.md,
  },
});
