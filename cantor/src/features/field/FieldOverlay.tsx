import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { MorphHost, TransformText, WriteText } from '../../motion';
import { smootherstep } from '../../motion/geometry';
import { Dial, Reveal } from '../controls';
import { FieldLegend } from './FieldLegend';
import { filterPhrase, type PhraseSegment } from './filterWords';
import {
  NOW_PLAYING_KNOBS,
  NOW_PLAYING_MARK_BOX_PX,
  NowPlayingSeat,
  lineWidth,
  type NowPlaying,
} from './NowPlaying';
import type { SkFont } from '@shopify/react-native-skia';
import { useFontScaledStyle, useMorphFont } from '../../motion/fonts';
import type { Lens } from '../../lenses';
import {
  ARRANGEMENTS,
  DATE_RESOLUTIONS,
  SONG_ORDERS,
  REPRESENTATION_WINDOWS,
  EMPTY_FILTER,
  bandAlphaAt,
  byTime,
  type Camera,
  type DateResolution,
  type Level,
  type TagFilter,
} from '../../field';
import { space, type, usePalette } from '../../theme/tokens';

type Props = {
  level: Level;
  /**
   * The live camera and the fit it is measured against, for the one thing
   * here that moves with them: how much of the header and the foot is drawn
   * while the player arrives. See `CHROME_AWAY_WINDOW`.
   */
  cameraShared: SharedValue<Camera>;
  fitScaleShared: SharedValue<number>;
  offline: boolean;
  /**
   * The phone itself has no connection: the one failure that is about the
   * whole app, said as a state in the meta line rather than as an alert.
   */
  noConnection?: boolean;
  /** How many songs play from this phone, for `NO CONNECTION · N PLAYABLE HERE`. */
  playableHere?: number;
  /**
   * Songs that just arrived from the phone, said once in the meta line
   * (`310 ARRIVED FROM THIS PHONE`); null says the count as usual.
   */
  arrived?: number | null;
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
  /**
   * The tag filter, said on the map's count line as `10 OF 64 · RAINY OR
   * LIVE`: the tag words open the tags, the conjunction flips the mode.
   */
  filter?: TagFilter;
  /** Every song in the library, for the `OF 64`; read only while filtered. */
  libraryCount?: number;
  onFlipFilter?: () => void;
  onOpenTags?: () => void;
  /** The `FIND` word at the eyebrow's right end, on the map and in a shelf. */
  onOpenFind?: () => void;
  /**
   * Find mode (gather-plan, G1): the title line is the query, the eyebrow
   * says `FIND` or `FOUND`, the count line counts what it found, and `CLOSE`
   * takes `FIND`'s seat. Null outside it.
   */
  finding?: FindChrome | null;
  /** Whether the soft keyboard is up, which in find mode is typing. */
  keyboardUp?: boolean;
  onChangeQuery?: (query: string) => void;
  onCloseFind?: () => void;
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
   * The song the player holds, as the map's one action — its face turning in
   * its clock, and its name — or null when nothing is held. It takes the same
   * seat the shelf's bulk action takes at L1, which at L0 is empty: one seat,
   * one act per level. See `NowPlaying.tsx`.
   */
  nowPlaying?: NowPlaying | null;
  onNowPlaying?: () => void;
  /**
   * How members are seated inside the shelf you are inside, and the control
   * that changes it. Order is position, so this is a dial like the axis is —
   * you watch a cluster re-form rather than watching a list re-sort.
   */
  orderKey: string;
  onChangeOrder: (key: string) => void;
  /** The lens the field is drawn in, for the legend's marks. */
  lens: Lens;
  /**
   * Whether the map's hint seat holds the key to the marks rather than the
   * gesture: true until the first cluster has been opened.
   */
  showLegend: boolean;
  /**
   * Whether the legend exists at all. True only in a session that began with
   * it unseen, so it can still leave on its own fade; every later session
   * mounts nothing for it. Its canvas is a TextureView the window composites
   * whenever the chrome animates, which is every level change.
   */
  mountLegend: boolean;
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
   * The resolution row's height, including the space above it. Fixed rather
   * than measured: it is one line of one type size, and animating a measured
   * height means the first frame of every open is the wrong size.
   *
   * The tick and the rise the row arrives on belong to the controls
   * themselves; see `DIAL_KNOBS` and `REVEAL_KNOBS`.
   */
  RESOLUTION_ROW_PX: 26,
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
  /**
   * The targets sit one space apart, so they reach up and down a finger's
   * height and barely sideways: a wide slop on `OR` would take `RAINY`'s taps.
   */
  PHRASE_HIT_SLOP: { top: 14, bottom: 14, left: 3, right: 3 },
  /**
   * How much of a held song's name the filter's words leave beside its mark,
   * at the least. Forty-eight was five letters — `STC SC` — on a row also
   * carrying the count and three press targets, which read as packed on the
   * Xiaomi. A dozen letters is a name you can read as it passes.
   */
  HELD_NAME_MIN_PX: 120,
  /**
   * The `FIND` word's target: a finger's height, generous out to the screen
   * edge and up, and only a few points inward, where `NEW SONG`'s own target
   * hangs over the same line.
   */
  FIND_HIT_SLOP: { top: 16, bottom: 12, left: 8, right: 24 },
  /**
   * The `FIND`/`CLOSE` seat's width: `CLOSE` at the eyebrow's size and
   * tracking, with a little air. Fixed, so the word can morph in place.
   */
  FIND_SEAT_WIDTH_PX: 76,
} as const;

/**
 * KNOBS — the title line becoming the query (find-motion.html, frame III).
 *
 * One linear clock; `Field` leaves on the first part of it and the query
 * arrives on the rest, each rising, so the two never stand in the same place
 * at full ink.
 */
export const FIND_TITLE_KNOBS = {
  /** The whole crossing, both ways. */
  CROSS_MS: 500,
  /** How far each line travels as it crosses: both rise. */
  SHIFT_PX: 10,
  /** When on the clock the query starts to arrive. */
  QUERY_FROM: 0.3,
  /** When on the clock `Field` is gone. */
  TITLE_GONE_AT: 0.7,
  /**
   * The query's glyphs, lifted onto the title's baseline: a `TextInput`
   * centres its line in the slot a little lower than the engine sets the
   * title (measured on the Xiaomi: 7 px, 2.5 dp).
   */
  QUERY_BASELINE_PX: -2.5,
} as const;

/** What find mode's chrome says. */
export type FindChrome = Readonly<{
  query: string;
  /** Songs found, and the groups they came from. */
  songCount: number;
  groupCount: number;
}>;

/**
 * KNOB — where the header and the foot give the screen to the player, in
 * multiples of FIT: they leave across exactly the span the song band opens on
 * (`REPRESENTATION_WINDOWS.song`, 12→27), and stay gone at every distance past
 * it, the grain included.
 *
 * They used to be hidden outright on the commit React's level became `song` —
 * a cut at 13·FIT, a commit late, while the camera was still moving and the
 * player had barely begun to arrive. React hears the camera only at
 * thresholds, so nothing that moves with it can be faded from React state
 * (`cantor/AGENTS.md`); this is read from the live camera on the UI thread,
 * the same number `SongSurface` fades the player's readout in on.
 */
export const CHROME_AWAY_WINDOW = [
  REPRESENTATION_WINDOWS.song[0],
  REPRESENTATION_WINDOWS.song[1],
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
] as const;

/*
 * Char styles for the animated lines, hoisted to module scope — house rule 3.
 * A fresh style object every render defeats the components' memo and re-records
 * a ticking canvas.
 */
const CHROME_STYLES = {
  eyebrow: type.eyebrow,
  title: type.title,
  /** `FIND` and `CLOSE` share the eyebrow's right end. */
  find: { ...type.eyebrow, textAlign: 'right' } as const,
  /** The action is pinned to the meta row's right end; see `ACTION_WIDTH_PX`. */
  action: { ...type.eyebrow, textAlign: 'right' } as const,
  hint: { ...type.eyebrow, textAlign: 'center' } as const,
} as const;

/**
 * What the eyebrow says: how the map is cut (`BY WEEK`), and inside a cluster
 * what kind of cluster it is (`ALBUM`, over the album's name). The depth
 * numbers this used to show were the code's words for the levels, not a
 * listener's. L2 and L3 never show the header; see `showHeader`.
 */
function eyebrowLine(
  level: Level,
  noun: string,
  finding: FindChrome | null = null,
): string {
  if (finding !== null) return hasQuery(finding) ? 'FOUND' : 'FIND';
  if (level === 'field') return `BY ${noun}`;
  if (level === 'shelf') return noun;
  return level === 'song' ? 'SONG' : 'GRAIN';
}

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

/** The same noun for every axis that does not cut time, by arrangement key. */
const AXIS_NOUN: Readonly<Record<string, string>> = {
  playlist: 'PLAYLIST',
  album: 'ALBUM',
  artist: 'ARTIST',
};

/** What one cluster on this axis is called: `WEEK`, `PLAYLIST`. */
export function axisNoun(
  arrangementKey: string,
  dateResolution: DateResolution,
): string {
  return arrangementKey === byTime.key
    ? CLUSTER_NOUN[dateResolution]
    : AXIS_NOUN[arrangementKey] ?? 'GROUP';
}

function hasQuery(finding: FindChrome): boolean {
  return finding.query.trim().length > 0;
}

/**
 * Find's count line: `4 SONGS · 4 WEEKS`, in the axis's noun; `TYPE A NAME`
 * before a letter.
 */
export function findCountLine(finding: FindChrome, noun: string): string {
  if (!hasQuery(finding)) return 'TYPE A NAME';
  if (finding.songCount === 0) return 'NO SONGS';
  const songs = `${finding.songCount} ${
    finding.songCount === 1 ? 'SONG' : 'SONGS'
  }`;
  return `${songs} · ${finding.groupCount} ${noun}${
    finding.groupCount === 1 ? '' : 'S'
  }`;
}

function FieldOverlayImpl({
  level,
  cameraShared,
  fitScaleShared,
  offline,
  noConnection = false,
  playableHere = 0,
  arrived = null,
  storageError,
  onOpenEngines,
  onOpenComposer,
  arrangementKey,
  onChangeArrangement,
  dateResolution,
  onChangeDateResolution,
  songCount,
  groupCount,
  filter = EMPTY_FILTER,
  libraryCount = 0,
  onFlipFilter,
  onOpenTags,
  onOpenFind,
  finding = null,
  keyboardUp = false,
  onChangeQuery,
  onCloseFind,
  groupLabel,
  shelfAction,
  onShelfAction,
  nowPlaying = null,
  onNowPlaying,
  orderKey,
  onChangeOrder,
  lens,
  showLegend,
  mountLegend,
}: Props) {
  const pal = usePalette();
  // L2 and L3 belong to the player, which draws its own name and metadata in
  // this corner. Two headers in one place is the fault this step exists to
  // remove, so at those levels the breadcrumb carries the depth alone.
  const showHeader = level === 'field' || level === 'shelf';
  /*
   * What the header and the foot say, held at the last level they were shown.
   *
   * They stay mounted at L2 and are only hidden. Unmounting them is tearing
   * down a handful of Skia text canvases and two dials on the UI thread, and it
   * happened on the frame the camera crossed into a song — mid-descent — as
   * one frame of about eighty milliseconds: the player stopped, then appeared.
   * Hidden, they must not keep morphing to say things nobody can see, so while
   * hidden they are drawn from the last props they showed.
   */
  const live = {
    level,
    offline,
    noConnection,
    playableHere,
    arrived,
    arrangementKey,
    dateResolution,
    songCount,
    groupCount,
    filter,
    libraryCount,
    groupLabel,
    shelfAction,
    nowPlaying,
    orderKey,
    finding,
    keyboardUp,
  };
  const shown = useRef(live);
  if (showHeader) shown.current = live;
  const h = shown.current;
  const onDateAxis = h.arrangementKey === byTime.key;
  // The header's one act: the shelf's bulk action inside a shelf; on the map,
  // the song the player holds — unless the count line is saying something
  // longer than a count, which this would run into.
  // While typing, the header is the query and its count, nothing else.
  const typing = h.finding !== null && h.keyboardUp;
  // The found shelf is find's, not a place to fetch from: its count line is
  // the long one, and the action ran into it.
  const action =
    h.level === 'shelf' && h.finding === null ? h.shelfAction : null;
  /*
   * The title behind the query: what it said before find opened, held until
   * the camera is back somewhere with a name of its own. Standing in the
   * found shelf the screen hands us no name (`groupLabel` null at L1), and
   * the line coming back would otherwise say `Group` over the leaving query.
   */
  const title = h.level === 'shelf' ? h.groupLabel ?? 'Group' : 'Field';
  const restTitle = useRef(title);
  if (h.finding === null && !(h.level === 'shelf' && h.groupLabel === null)) {
    restTitle.current = title;
  }
  const held =
    h.level === 'field' &&
    h.finding === null &&
    !h.noConnection &&
    h.arrived == null
      ? h.nowPlaying
      : null;
  const noun = axisNoun(h.arrangementKey, h.dateResolution);
  // The filter is said on the map's count line only: inside a shelf the line
  // is the shelf's own count, and its right end is the bulk action's.
  const saysFilter =
    h.level === 'field' &&
    h.finding === null &&
    !h.noConnection &&
    h.arrived == null &&
    h.filter.tags.length > 0;
  const countLine = h.noConnection
    ? `NO CONNECTION · ${h.playableHere ?? 0} PLAYABLE HERE`
    : h.finding !== null
    ? findCountLine(h.finding, noun)
    : h.arrived != null && h.level === 'field'
    ? `${h.arrived} ARRIVED FROM THIS PHONE`
    : saysFilter
    ? `${metaLine(h.level, h.songCount, h.groupCount, noun, h.libraryCount)}${
        h.offline ? ' · OFFLINE' : ''
      } ·`
    : `${metaLine(h.level, h.songCount, h.groupCount, noun)}${
        h.offline ? ' · OFFLINE' : ''
      }`;
  // What the count line leaves the held song: the row, less the count's own
  // ink and the air kept after it. Measured the way the engine lays it out.
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const onRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  const countStyle = useFontScaledStyle(CHROME_STYLES.eyebrow);
  const countFont = useMorphFont(countStyle);
  const tracking = countStyle.letterSpacing ?? 0;
  // Where the phrase starts: one space after the count's own ink.
  const phraseLeft =
    countFont === null ? 0 : lineWidth(countFont, tracking, `${countLine} `);
  // A held song keeps its mark and the start of its name at the row's end;
  // the phrase names fewer tags rather than running under them.
  const heldReserve =
    held === null
      ? 0
      : NOW_PLAYING_KNOBS.COUNT_GAP_PX +
        NOW_PLAYING_MARK_BOX_PX +
        NOW_PLAYING_KNOBS.MARK_GAP_PX +
        OVERLAY_KNOBS.HELD_NAME_MIN_PX;
  const phrase = filterPhrase(
    saysFilter ? h.filter : EMPTY_FILTER,
    text =>
      rowWidth === null ||
      countFont === null ||
      phraseLeft + lineWidth(countFont, tracking, text) - tracking <=
        rowWidth - heldReserve,
    // A held song takes the row's second half: the filter says only how
    // many tags, or the one, and the name gets room to be read.
    held === null ? 'names' : 'brief',
  );
  const room =
    rowWidth === null || countFont === null
      ? null
      : rowWidth -
        (phrase.text.length > 0
          ? phraseLeft + lineWidth(countFont, tracking, phrase.text)
          : lineWidth(countFont, tracking, countLine)) -
        NOW_PLAYING_KNOBS.COUNT_GAP_PX;
  const legendShown = showLegend && h.level === 'field' && h.finding === null;
  // The key and the hint share one seat; they cross rather than cut.
  const legendIn = useSharedValue(legendShown ? 1 : 0);
  useEffect(() => {
    legendIn.value = withTiming(legendShown ? 1 : 0, {
      duration: OVERLAY_KNOBS.HEADER_CHANGE_MS,
    });
  }, [legendIn, legendShown]);
  const legendStyle = useAnimatedStyle(() => ({ opacity: legendIn.value }));
  // `away` decides touches, the screen reader and the frozen words; how much
  // is drawn follows the camera itself.
  const away = !showHeader;
  const present = useAnimatedStyle(
    () => ({
      opacity:
        1 -
        bandAlphaAt(
          cameraShared.value.scale,
          fitScaleShared.value,
          CHROME_AWAY_WINDOW,
        ),
    }),
    [cameraShared, fitScaleShared],
  );
  /**
   * The same, for the lines the header and foot hand to the overlay's one
   * canvas (`MorphHost`): that canvas is not inside their views, so it does
   * not fade with them by itself.
   */
  const presentOpacity = useDerivedValue(() =>
    1 - bandAlphaAt(cameraShared.value.scale, fitScaleShared.value, CHROME_AWAY_WINDOW),
  );
  /*
   * The title line becoming the query. Not `h`: entering find happens at L0
   * or L1, where the header is always shown.
   */
  const inFind = finding !== null;
  const reducedMotion = useReducedMotion();
  const query = useRef<TextInput>(null);
  const crossing = useSharedValue(inFind ? 1 : 0);
  useEffect(() => {
    crossing.value = reducedMotion
      ? inFind
        ? 1
        : 0
      : withTiming(inFind ? 1 : 0, {
          duration: FIND_TITLE_KNOBS.CROSS_MS,
          easing: Easing.linear,
        });
    if (inFind) {
      // The field holds its own text (see the input below): a new find
      // starts empty.
      query.current?.clear();
      query.current?.focus();
    } else {
      query.current?.blur();
      Keyboard.dismiss();
    }
  }, [crossing, inFind, reducedMotion]);
  const titleLeaving = useAnimatedStyle(() => {
    const gone = smootherstep(0, FIND_TITLE_KNOBS.TITLE_GONE_AT, crossing.value);
    return {
      opacity: 1 - gone,
      transform: [{ translateY: -FIND_TITLE_KNOBS.SHIFT_PX * gone }],
    };
  });
  const queryArriving = useAnimatedStyle(() => {
    const here = smootherstep(FIND_TITLE_KNOBS.QUERY_FROM, 1, crossing.value);
    return {
      opacity: here,
      transform: [{ translateY: FIND_TITLE_KNOBS.SHIFT_PX * (1 - here) }],
    };
  });
  const queryStyle = useFontScaledStyle(CHROME_STYLES.title);
  // The field's dials and hint leave in find mode; once the keyboard is down
  // on a query, the hint is the shelf's.
  // Find with nothing typed offers the tags in this seat (decision 10).
  const tagsDoor = h.finding !== null && !hasQuery(h.finding);
  const hint = legendShown
    ? ''
    : tagsDoor
    ? 'TAGS'
    : h.finding !== null
    ? !typing && h.finding.songCount > 0
      ? HINTS.shelf
      : ''
    : h.level === 'field'
    ? `${HINTS.field} ${noun}`
    : HINTS.shelf;
  const orderOpen =
    h.level === 'shelf' &&
    (h.finding === null || (!typing && hasQuery(h.finding)));
  /*
   * The two lines a letter in find changes, a render behind it. A morph is
   * planned while it renders — the count line's glyph outlines, about 30 ms
   * on the Xiaomi's debug build — and the field's cut is sent only once the
   * whole tree has rendered, so planning the header first held every letter's
   * gather back by that long. Deferred, React commits the field first and
   * plans the header in the render after, which a quicker letter replaces.
   */
  const eyebrowText = useDeferredValue(eyebrowLine(h.level, noun, h.finding));
  const countText = useDeferredValue(countLine);
  return (
    <MorphHost style={StyleSheet.absoluteFill}>
      <EdgeTab
        accessibilityLabel="Open the composer"
        colour={pal.faint}
        edge="top"
        label="NEW SONG"
        onPress={onOpenComposer}
      />
      {/*
        box-none, not none: the count is not touchable but the shelf action
        beside it is, and it is the only thing in this corner that is.
      */}
      <Animated.View
        accessibilityElementsHidden={away}
        importantForAccessibility={away ? 'no-hide-descendants' : 'auto'}
        pointerEvents={away ? 'none' : 'box-none'}
        style={[styles.header, present]}
        testID="field-header"
      >
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
        <View style={styles.eyebrowRow} pointerEvents="box-none">
          <TransformText
            text={eyebrowText}
            charStyle={CHROME_STYLES.eyebrow}
            color={pal.muted}
            duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            hosted
            hostOpacity={presentOpacity}
            style={styles.eyebrowSlot}
          />
          {/*
              The one free seat in the header (find-plan, decision 8): the
              eyebrow's right end. `NEW SONG` hangs over the line's centre, so
              the word stays at the far end and its target reaches no further
              in than its own width.
            */}
          {/*
              In find mode the seat says `CLOSE`, the eyebrow's one way back,
              where every blind keeps it. A word changing is a morph.
            */}
          <Pressable
            accessibilityLabel={
              h.finding !== null
                ? 'Close find'
                : 'Find a song, or show only some tags'
            }
            accessibilityRole="button"
            hitSlop={OVERLAY_KNOBS.FIND_HIT_SLOP}
            onPress={h.finding !== null ? onCloseFind : onOpenFind}
            style={styles.find}
          >
            {({ pressed }) => (
              <TransformText
                text={h.finding !== null ? 'CLOSE' : 'FIND'}
                charStyle={CHROME_STYLES.find}
                color={
                  pressed ? pal.muted : h.finding !== null ? pal.ink : pal.faint
                }
                duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
                style={styles.eyebrowSlot}
              />
            )}
          </Pressable>
        </View>
        {/*
            The title and the query share one seat and never stand in it at
            full ink together: the title leaves upward on the first part of
            the crossing and the query rises in on the rest. Both stay
            mounted, so neither crossing waits on a commit.
          */}
        <View style={styles.titleSlot} pointerEvents="box-none">
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, titleLeaving]}
            importantForAccessibility={inFind ? 'no-hide-descendants' : 'auto'}
          >
            <TransformText
              text={restTitle.current}
              charStyle={CHROME_STYLES.title}
              color={pal.ink}
              duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View
            pointerEvents={inFind ? 'auto' : 'none'}
            style={[StyleSheet.absoluteFill, queryArriving]}
            importantForAccessibility={inFind ? 'auto' : 'no-hide-descendants'}
          >
            <TextInput
              ref={query}
              accessibilityLabel="Find a song"
              autoCapitalize="none"
              autoCorrect={false}
              cursorColor={pal.ink}
              onChangeText={onChangeQuery}
              placeholder="a song…"
              placeholderTextColor={pal.faint}
              returnKeyType="search"
              selectionColor={pal.line}
              style={[queryStyle, styles.query, { color: pal.ink }]}
              // Uncontrolled: the field is the query's one owner, and React
              // hears it. While typing, the overlay renders a step behind the
              // field (`FindDeferredOverlay`), and a controlled value a step
              // behind would write old letters back. Left as it was on
              // leaving, so the query fades out as typed.
              defaultValue=""
            />
          </Animated.View>
        </View>
        <View
          onLayout={onRowLayout}
          style={styles.metaRow}
          pointerEvents="box-none"
        >
          <View style={styles.metaCount} pointerEvents="none">
            <TransformText
              text={countText}
              charStyle={CHROME_STYLES.eyebrow}
              color={pal.faint}
              duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
              hosted
              hostOpacity={presentOpacity}
              style={styles.eyebrowSlot}
            />
          </View>
          {rowWidth !== null && countFont !== null ? (
            <FilterPhraseSeat
              font={countFont}
              tracking={tracking}
              left={phraseLeft}
              width={rowWidth}
              phrase={phrase}
              mode={h.filter.mode}
              onFlip={onFlipFilter}
              onOpenTags={onOpenTags}
              ink={pal.ink}
              visible={!away}
            />
          ) : null}
          {/*
              Always mounted, and empty at every level that has no bulk action.
              An action that unmounted could not be taken back off the screen:
              the engine needs the outgoing ink and a stable slot width to
              unwrite it, and an unmounted component has neither. The word
              writes itself on when you enter a shelf and unwrites itself when
              you leave — one gesture, both directions.
            */}
          <Pressable
            accessibilityElementsHidden={action === null}
            accessibilityLabel={action ?? undefined}
            accessibilityRole="button"
            hitSlop={space.md}
            importantForAccessibility={
              action === null ? 'no-hide-descendants' : 'yes'
            }
            onPress={onShelfAction}
            pointerEvents={action === null ? 'none' : 'auto'}
            style={styles.actionSlot}
          >
            {({ pressed }) => (
              <WriteText
                text={action ?? ''}
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
          <NowPlayingSeat
            changeMs={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            charStyle={CHROME_STYLES.eyebrow}
            lens={lens}
            nowPlaying={held}
            onPress={onNowPlaying}
            palette={pal}
            room={room}
            rowHeight={OVERLAY_KNOBS.EYEBROW_ROW_PX}
            visible={!away}
          />
        </View>
        {/*
            Always mounted, rising into a seat the header keeps for it. The
            header stacks downward from the top of the screen, so the seat
            costs nothing at L0 — it is below everything — and the control
            arrives by coming up into focus rather than by existing suddenly.
          */}
        <Reveal duration={OVERLAY_KNOBS.HEADER_CHANGE_MS} open={orderOpen}>
          <View style={styles.orderRow} pointerEvents="box-none">
            <Text
              style={[type.eyebrow, styles.orderLabel, { color: pal.line }]}
              pointerEvents="none"
            >
              ORDER
            </Text>
            <Dial
              activeKey={h.orderKey}
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
      </Animated.View>

      {/* An alert clears the player's transport as well as the dial. */}
      {storageError ? (
        <Text
          accessibilityRole="alert"
          style={[type.small, styles.alert, { color: pal.ink }]}
        >
          {storageError}
        </Text>
      ) : null}
      <Animated.View
        accessibilityElementsHidden={away}
        importantForAccessibility={away ? 'no-hide-descendants' : 'auto'}
        pointerEvents={away ? 'none' : 'box-none'}
        style={[styles.foot, present]}
        testID="field-foot"
      >
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
        <Reveal open={h.level === 'field' && h.finding === null}>
          <>
            {/*
                Resolution sits over the axis it belongs to, because it is a
                property of that axis rather than a fourth arrangement, and the
                axis is the foot's last line: the foot is anchored to the bottom
                of the screen and stacks upward, so this row can rise and set
                on the date axis without moving the axis under a thumb.
              */}
            <Reveal open={onDateAxis} height={OVERLAY_KNOBS.RESOLUTION_ROW_PX}>
              <Dial
                activeKey={h.dateResolution}
                activeColour={pal.muted}
                items={DATE_RESOLUTIONS.map(resolution => ({
                  key: resolution,
                  label: CLUSTER_NOUN[resolution],
                  accessibilityLabel: `Group dates by ${resolution}`,
                }))}
                onSelect={key => onChangeDateResolution(key as DateResolution)}
                restColour={pal.line}
                textStyle={styles.resolution}
                tickColour={pal.muted}
              />
            </Reveal>
            <Dial
              activeKey={h.arrangementKey}
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
          </>
        </Reveal>
        {/*
            The hint names the one gesture worth naming, and which gesture that
            is changes with the level and with the axis. It is the same
            sentence being rewritten, so it morphs like the header does.
          */}
        {/*
            Until a cluster has been opened, the map's hint seat holds the key
            to the marks instead: what the ink means is the first thing the
            field cannot say for itself. The hint writes itself back in when
            the key leaves.
          */}
        <Pressable
          accessibilityElementsHidden={!tagsDoor}
          accessibilityLabel={tagsDoor ? 'Show only some tags' : undefined}
          accessibilityRole={tagsDoor ? 'button' : undefined}
          hitSlop={space.md}
          importantForAccessibility={tagsDoor ? 'yes' : 'no-hide-descendants'}
          onPress={tagsDoor ? onOpenTags : undefined}
          pointerEvents={tagsDoor ? 'auto' : 'none'}
          style={styles.hintSeat}
        >
          <WriteText
            text={hint}
            charStyle={CHROME_STYLES.hint}
            color={pal.faint}
            duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            hosted
            hostOpacity={presentOpacity}
            writeDuration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
            variant="transform"
            style={styles.hintSlot}
          />
          {mountLegend ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.legend, legendStyle]}
              importantForAccessibility={
                legendShown ? 'auto' : 'no-hide-descendants'
              }
            >
              <FieldLegend lens={lens} palette={pal} />
            </Animated.View>
          ) : null}
        </Pressable>
      </Animated.View>
      <EdgeTab
        accessibilityLabel="Open nodes"
        colour={pal.faint}
        edge="bottom"
        label="NODES"
        onPress={onOpenEngines}
      />
    </MorphHost>
  );
}

/**
 * `23 SONGS · 5 WEEKS`, or what the current axis counts instead; `10 OF 64`
 * on the map while a filter holds `libraryCount` songs back to `songCount`.
 */
export function metaLine(
  level: Level,
  songCount: number,
  groupCount: number,
  noun: string,
  libraryCount: number | null = null,
): string {
  const songs = `${songCount} ${songCount === 1 ? 'SONG' : 'SONGS'}`;
  if (level === 'shelf') return songs;
  // The axis's noun drops: the filter's own words take that half of the line.
  if (libraryCount !== null) return `${songCount} OF ${libraryCount}`;
  if (songCount === 0) return 'NO SONGS YET';
  // The axis's own noun: at L0 the bulk action's slot is empty and overlaid
  // (`actionSlot`), so `8 SONGS · 3 PLAYLISTS` has the whole row.
  return `${songs} · ${groupCount} ${noun}${groupCount === 1 ? '' : 'S'}`;
}

/**
 * The filter's words on the count line, in ink after the faint count, and the
 * press targets inside them.
 *
 * One line drawn once, with its targets laid over it rather than one canvas
 * per word: the phrase writes on and off as one gesture, and `OR` becoming
 * `AND` morphs in place, which a row of separate words could not do. The slot
 * is the whole row wide and slides to the count's end, so its width never
 * changes — the engine needs a stable slot to unwrite into.
 */
function FilterPhraseSeat({
  font,
  tracking,
  left,
  width,
  phrase,
  mode,
  onFlip,
  onOpenTags,
  ink,
  visible,
}: {
  font: SkFont;
  tracking: number;
  /** Where the phrase begins, from the row's left edge. */
  left: number;
  width: number;
  phrase: ReturnType<typeof filterPhrase>;
  mode: TagFilter['mode'];
  onFlip?: () => void;
  onOpenTags?: () => void;
  ink: string;
  visible: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const shown = phrase.text.length > 0;
  const x = useSharedValue(left);
  useEffect(() => {
    x.value = reducedMotion
      ? left
      : withTiming(left, { duration: OVERLAY_KNOBS.HEADER_CHANGE_MS });
  }, [left, reducedMotion, x]);
  const seat = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.phraseSeat, { width }, seat]}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <WriteText
          text={phrase.text}
          charStyle={CHROME_STYLES.eyebrow}
          color={ink}
          duration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
          writeDuration={OVERLAY_KNOBS.HEADER_CHANGE_MS}
          variant="transform"
          style={styles.eyebrowSlot}
        />
      </View>
      {shown && visible
        ? phrase.segments.map(segment => (
            <PhraseTarget
              key={`${segment.kind}:${segment.start}`}
              font={font}
              tracking={tracking}
              text={phrase.text}
              segment={segment}
              mode={mode}
              onPress={segment.kind === 'join' ? onFlip : onOpenTags}
            />
          ))
        : null}
    </Animated.View>
  );
}

/**
 * One word of the phrase you can press. Unmarked: the words are already ink
 * against a faint count, and rules under them were three more marks on the
 * header's busiest line.
 */
function PhraseTarget({
  font,
  tracking,
  text,
  segment,
  mode,
  onPress,
}: {
  font: SkFont;
  tracking: number;
  text: string;
  segment: PhraseSegment;
  mode: TagFilter['mode'];
  onPress?: () => void;
}) {
  const word = text.slice(segment.start, segment.end);
  const x = lineWidth(font, tracking, text.slice(0, segment.start));
  // The last letter's tracking is air after the word, not the word.
  const wordWidth = Math.max(0, lineWidth(font, tracking, word) - tracking);
  const join = segment.kind === 'join';
  return (
    <Pressable
      accessibilityLabel={
        join
          ? mode === 'all'
            ? 'Songs with every tag. Show songs with any of them'
            : 'Songs with any of the tags. Show songs with all of them'
          : `Filtered by ${text.toLocaleLowerCase()}. Choose tags`
      }
      accessibilityRole="button"
      hitSlop={OVERLAY_KNOBS.PHRASE_HIT_SLOP}
      onPress={onPress}
      style={[styles.phraseTarget, { left: x, width: wordWidth }]}
    />
  );
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
  eyebrowRow: { position: 'relative' },
  find: {
    height: OVERLAY_KNOBS.EYEBROW_ROW_PX,
    justifyContent: 'center',
    position: 'absolute',
    right: 0,
    top: 0,
    width: OVERLAY_KNOBS.FIND_SEAT_WIDTH_PX,
  },
  /** The query sits where the title's glyphs do, with no field chrome. */
  query: {
    height: OVERLAY_KNOBS.TITLE_ROW_PX,
    marginTop: FIND_TITLE_KNOBS.QUERY_BASELINE_PX,
    includeFontPadding: false,
    margin: 0,
    padding: 0,
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
  /** The count takes the room the action does not, and morphs inside it. */
  metaCount: { flex: 1 },
  phraseSeat: {
    bottom: 0,
    height: OVERLAY_KNOBS.EYEBROW_ROW_PX,
    left: 0,
    position: 'absolute',
  },
  phraseTarget: {
    bottom: 0,
    height: OVERLAY_KNOBS.EYEBROW_ROW_PX,
    position: 'absolute',
  },
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
  hintSlot: { height: OVERLAY_KNOBS.EYEBROW_ROW_PX },
  hintSeat: { justifyContent: 'center', marginTop: space.md },
  legend: {
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
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

/**
 * The overlay, a render behind while a query is being typed.
 *
 * A letter in find re-renders the screen to send the field its cut, and the
 * overlay's subtree was a third of that render (10–12 ms on the Xiaomi's debug
 * build) for chrome that can follow a frame later: the count, the eyebrow,
 * the foot. Deferred, the overlay keeps the props it had through the urgent
 * render, which commits the cut, and takes the new ones in the render after.
 * Opening and leaving find are not deferred: the title line crosses at once.
 */
export function FindDeferredOverlay(props: Props) {
  const deferred = useDeferredValue(props);
  const typing = props.finding !== null && deferred.finding !== null;
  return <FieldOverlay {...(typing ? deferred : props)} />;
}
