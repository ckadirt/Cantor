import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { SongDetail, SongHeader } from '../../core/protocol';
import type { LocalAudioState } from '../../audio/native';
import { formatBytes } from '../../lenses';
import { nameLensFacePath } from '../../lenses/nameLens';
import { Canvas, Path } from '@shopify/react-native-skia';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { easeSmoother, TransformText, WriteText } from '../../motion';
import {
  Ledger,
  LedgerFoot,
  LedgerGap,
  LEDGER_VALUE_PX,
  Row,
} from '../controls';
import { Membership, type MembershipEntry } from './Membership';
import { plainTagsOf, playlistsOf } from '../../playlists/playlists';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS — the sheet's two pages, and the mark that identifies it. */
export const SONG_SHEET_KNOBS = {
  /** Enough of a digest to compare by eye, short enough to read. */
  DIGEST_PREFIX_CHARS: 12,
  /** The face in the header seat, at the size every other panel's glyph takes. */
  SEAT_PX: 27,
  /** How long the header's name takes to become the other page's name. */
  PAGE_NAME_MS: 260,
  /**
   * How long the blind itself takes, being tapped open rather than pulled.
   *
   * A released drag only has to finish what a finger started; this trip is
   * always the whole screen, and at the house rate that came to the 220 ms
   * floor — brisk for a surface that covers everything.
   */
  BLIND_MS: 460,
  /**
   * The second beat, and how long it waits for the first.
   *
   * The sheet waits for the blind rather than running underneath it:
   * everything in the frame moving at one instant is the lurch `ROW_ARRIVAL`
   * warns about, and the point of a beat is that the shape lands before the
   * words do. The wait is shorter than the blind on purpose — the axis starts
   * drawing while the last of the surface is still arriving, so the two read
   * as one sentence rather than as two events.
   */
  ARRIVAL_WAIT_MS: 330,
  ARRIVAL_MS: 900,
  /**
   * Windows on that one clock, in the order the eye is given them: the mark
   * traces itself, the axis draws down out of it, the name writes on, and the
   * facts land on the axis that is now there to hold them.
   */
  FACE_WINDOW: [0, 0.34] as const,
  SPINE_WINDOW: [0.16, 0.52] as const,
  WRITE_WINDOW: [0.3, 0.86] as const,
  ROWS_FROM: 0.42,
  /** How far each row is behind the one above it, as a fraction of the beat. */
  ARRIVAL_LAG: 0.075,
  /** The stretch one row takes to land, of that same beat. */
  ARRIVAL_RISE: 0.34,
  /** The rise itself: `Reveal`'s own measure, so nothing arrives differently. */
  ARRIVAL_RISE_PX: 6,
  /** The hem's page marks: one short rule per page, the current one inked. */
  MARK_W_PX: 22,
  MARK_GAP_PX: 6,
  /**
   * How long the foot's act takes to become the other act.
   *
   * `Unpin` and `Keep it here` are the same object seen from either side of
   * one state, the way `SONG` and `RECORD` are — but they are not the same
   * size, and a morph's legibility is a matter of how far the ink has to
   * travel rather than of which panel it is in. At the header's 260 ms this
   * word changed between two frames and read as a swap, which is the thing
   * the morph exists to not be; the eye never caught the glyphs moving. The
   * foot's word is `type.heading` at 20 px against the header's 11, carries
   * twice the letters, and is the one act the page is for, so it is given the
   * time to be seen doing it. Still short of the engine's own 700 ms default.
   */
  ACT_MS: 640,
  /**
   * The seats those morphing words take.
   *
   * A morphing line is drawn on a canvas that fills its container, so the slot
   * has to be reserved rather than measured from the glyphs — `motion/README`
   * asks for a fixed height and this is where it comes from. The display line
   * is `type.heading` at 20 px on the engine's default 1.35 leading; the note
   * under it is `type.eyebrow` at 11, in the 16 px slot every eyebrow uses.
   */
  ACT_SLOT_PX: 28,
  NOTE_SLOT_PX: 16,
} as const;

type Props = {
  visible: boolean;
  song: SongHeader;
  nodeLabel: string;
  audioState: LocalAudioState;
  /** Null until the node answers; undefined nodes stay honest about it. */
  detail: SongDetail | null;
  detailError: string | null;
  /**
   * Why the last act did not happen, said where the acts are. Not the same
   * thing as `detailError`, which is the node's answer about the recipe: a
   * refused rename is not a fact about how the song was made, and the recipe
   * lives on a page you may not be looking at.
   */
  problem: string | null;
  busy: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
  onToggleFavourite: () => void;
  /** Every playlist that exists anywhere, so the peel has a vocabulary. */
  knownPlaylists: readonly string[];
  /** Every plain tag used anywhere, for the same reason. */
  knownTags: readonly string[];
  onTogglePlaylist: (name: string, member: boolean) => void;
  onToggleTag: (name: string, member: boolean) => void;
  /** True when the song is at the node's tag bound and may hold no more. */
  full: boolean;
  /** Why a typed name cannot be used, checked before a patch is sent. */
  playlistProblem: (name: string) => string | null;
  tagProblem: (name: string) => string | null;
  /**
   * Where this sheet was opened from, and how much of the song it accounts
   * for. A mark is a placement, not a song: one delete must never silently
   * remove three.
   */
  scopeLabel: string | null;
  placementCount: number;
  /**
   * What the delivery artifact weighs — which is what a copy here weighs, and
   * what fetching one would cost. Whether there *is* a copy here is
   * `audioState`, not this: the node's number exists either way.
   */
  deliveryBytes: number | null;
  masterBytes: number | null;
  onPin: () => void;
  onUnpin: () => void;
  onRemoveDownload: () => void;
  /** Ending the song, on this phone and on the node, with no undo. */
  onDelete: () => void;
};

/**
 * Everything about one song that is not the act of listening to it, on two
 * pages.
 *
 * The front page is what you *do* with a song: its name, the places it is
 * kept, the words it carries, where its audio is and the one act that changes
 * that. The back page is what a song *is* — when it was made, the prompt it
 * came from, the machine and the model, every parameter that model declared,
 * what it weighs on each machine — and, at its foot, the act that ends it.
 *
 * Splitting them is what lets the front page be short. Twelve rows of
 * forensics under the two or three things anybody opens this sheet to do made
 * the forensics look like the subject; one horizontal gesture, which the sheet
 * was not using for anything, makes them a place you go rather than a thing
 * you scroll past.
 *
 * Delete is on the back page on purpose. The foot is the loudest object in
 * every Cantor panel — the composer puts `Make it` there — and a destructive
 * act drawn that well is an invitation. Reading what a song cost and what it
 * weighs is the honest preamble to ending it.
 */
function SongSheetImpl({
  visible,
  song,
  nodeLabel,
  audioState,
  detail,
  detailError,
  problem,
  busy,
  onClose,
  onRename,
  onToggleFavourite,
  knownPlaylists,
  knownTags,
  onTogglePlaylist,
  onToggleTag,
  full,
  playlistProblem,
  tagProblem,
  scopeLabel,
  placementCount,
  deliveryBytes,
  masterBytes,
  onPin,
  onUnpin,
  onRemoveDownload,
  onDelete,
}: Props) {
  const pal = usePalette();
  const [title, setTitle] = useState(song.title);
  const [page, setPage] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [width, setWidth] = useState(0);
  const pager = useRef<ScrollView | null>(null);
  const reducedMotion = useReducedMotion();
  /**
   * The second beat, 0 to 1.
   *
   * Driven from `visible` rather than from mount: the sheet is mounted by the
   * same commit that opens the blind, so a clock started on mount would run
   * while the surface carrying it was still on its way up.
   */
  const arrival = useSharedValue(0);
  useEffect(() => {
    if (!visible) {
      arrival.value = 0;
      return;
    }
    arrival.value = reducedMotion
      ? 1
      : withDelay(
          SONG_SHEET_KNOBS.ARRIVAL_WAIT_MS,
          withTiming(1, {
            duration: SONG_SHEET_KNOBS.ARRIVAL_MS,
            easing: easeSmoother,
          }),
        );
  }, [arrival, reducedMotion, song.id, visible]);

  // Adopt the node's title whenever a different song is shown, or the node
  // renames this one under us.
  useEffect(() => {
    setTitle(song.title);
  }, [song.id, song.title]);

  // A sheet that opens on a different song must never open on the back page
  // already asking to destroy it.
  useEffect(() => {
    setConfirming(false);
    setPage(0);
    pager.current?.scrollTo({ x: 0, animated: false });
  }, [song.id, visible]);

  const downloaded = audioState === 'cached' || audioState === 'pinned';
  const mine = useMemo(() => playlistsOf(song.tags), [song.tags]);
  const words = useMemo(() => plainTagsOf(song.tags), [song.tags]);
  const placeEntries = useMemo(
    () => merge(mine, knownPlaylists),
    [mine, knownPlaylists],
  );
  const wordEntries = useMemo(
    () => merge(words, knownTags),
    [words, knownTags],
  );

  const onPagerEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.x;
      setPage(offset > width / 2 ? 1 : 0);
    },
    [width],
  );
  const onFrame = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <View onLayout={onFrame} style={styles.sheet}>
      <View style={[styles.header, { borderColor: pal.line }]}>
        <Pressable
          accessibilityLabel={
            song.favorite ? 'Remove from favourites' : 'Make a favourite'
          }
          accessibilityRole="button"
          accessibilityState={{ selected: song.favorite }}
          disabled={busy}
          hitSlop={space.sm}
          onPress={onToggleFavourite}
          style={styles.seat}
        >
          <Face arrival={arrival} song={song} colour={pal.ink} />
          <Text
            style={[styles.star, { color: song.favorite ? pal.ink : pal.line }]}
          >
            {song.favorite ? '★' : '☆'}
          </Text>
        </Pressable>
        {/*
              One object, two strings: the header does not swap a word for
              another, it becomes it, on the same clock as the page it names.
            */}
        <TransformText
          text={page === 0 ? 'SONG' : 'RECORD'}
          charStyle={type.eyebrow}
          color={pal.muted}
          duration={SONG_SHEET_KNOBS.PAGE_NAME_MS}
          style={styles.nameSlot}
        />
        <Pressable
          accessibilityLabel="Close song"
          accessibilityRole="button"
          hitSlop={space.sm}
          onPress={onClose}
        >
          <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
        </Pressable>
      </View>

      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onPagerEnd}
        ref={pager}
        style={styles.pager}
      >
        <View style={{ width }}>
          <Front
            arrival={arrival}
            audioState={audioState}
            busy={busy}
            problem={problem}
            downloaded={downloaded}
            deliveryBytes={deliveryBytes}
            full={full}
            nodeLabel={nodeLabel}
            onPin={onPin}
            onRemoveDownload={onRemoveDownload}
            onRename={() => {
              const next = title.trim();
              if (next.length > 0 && next !== song.title) onRename(next);
            }}
            onTitle={setTitle}
            onTogglePlaylist={onTogglePlaylist}
            onToggleTag={onToggleTag}
            onUnpin={onUnpin}
            placeEntries={placeEntries}
            placementCount={placementCount}
            playlistProblem={playlistProblem}
            scopeLabel={scopeLabel}
            tagProblem={tagProblem}
            title={title}
            usedTags={song.tags.length}
            wordEntries={wordEntries}
          />
        </View>
        <View style={{ width }}>
          <Back
            busy={busy}
            confirming={confirming}
            detail={detail}
            detailError={detailError}
            deliveryBytes={deliveryBytes}
            masterBytes={masterBytes}
            nodeLabel={nodeLabel}
            downloaded={downloaded}
            onDelete={() => {
              setConfirming(false);
              onDelete();
            }}
            onKeep={() => setConfirming(false)}
            onAsk={() => setConfirming(true)}
            placementCount={placementCount}
            song={song}
          />
        </View>
      </ScrollView>

      {/*
            Two short rules at the hem, the current one inked: a page mark, not
            a scrollbar. The same hairline the dial uses, doing the same job.
          */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.hem}
      >
        <View
          style={[
            styles.mark,
            { backgroundColor: page === 0 ? pal.ink : pal.line },
          ]}
        />
        <View
          style={[
            styles.mark,
            { backgroundColor: page === 1 ? pal.ink : pal.line },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * The title, written on and then handed over to the field that edits it.
 *
 * `WriteText` traces the exact glyph outlines and resolves them into filled
 * ones — Manim's `DrawBorderThenFill`, driven here from the sheet's own clock
 * rather than its internal one, so the name arrives on the beat the axis was
 * drawn on rather than on a timer of its own.
 *
 * The hand-off is the delicate part and it obeys the Flicker Law: the real
 * `TextInput` is mounted the whole time, holding the layout the canvas is
 * drawn over, and ownership of the glyphs passes on the *same shared value* in
 * the same frame — never on a React commit, which is what would let both draw
 * the word at once or neither draw it for a frame.
 */
function Subject({
  arrival,
  busy,
  colour,
  onBlur,
  onChangeText,
  title,
}: {
  arrival: SharedValue<number>;
  busy: boolean;
  colour: string;
  onBlur: () => void;
  onChangeText: (value: string) => void;
  title: string;
}) {
  const written = useDerivedValue(() =>
    windowed(
      arrival.value,
      SONG_SHEET_KNOBS.WRITE_WINDOW[0],
      SONG_SHEET_KNOBS.WRITE_WINDOW[1],
    ),
  );
  const drawn = useAnimatedStyle(() => ({
    opacity: written.value >= 1 ? 0 : 1,
  }));
  const real = useAnimatedStyle(() => ({
    opacity: written.value >= 1 ? 1 : 0,
  }));
  return (
    <View>
      <Animated.View style={real}>
        <TextInput
          accessibilityLabel="Song title"
          editable={!busy}
          multiline
          onBlur={onBlur}
          onChangeText={onChangeText}
          scrollEnabled={false}
          style={[type.title, styles.titleField, { color: colour }]}
          value={title}
        />
      </Animated.View>
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, drawn]}
      >
        {/*
          The canvas fills its container absolutely, so the slot has to have a
          size — `motion/README.md` says to reserve one and this is where it
          comes from: the field underneath, which is already holding exactly
          the space the written word will occupy.
        */}
        <WriteText
          charStyle={type.title}
          color={colour}
          progress={written}
          style={StyleSheet.absoluteFill}
          text={title}
        />
      </Animated.View>
    </View>
  );
}

/** Where `arrival` has got to inside one window of the beat, as 0..1. */
function windowed(value: number, from: number, to: number): number {
  'worklet';
  return Math.min(Math.max((value - from) / (to - from), 0), 1);
}

/**
 * The song's own contour, where every other panel keeps a glyph — and the
 * first thing the sheet says.
 *
 * Trimmed on rather than faded in: the contour is one closed path, so running
 * `end` from 0 to 1 draws it the way a hand would. That is the same gesture
 * `WriteText` makes of a word and the one the player's ring already makes of a
 * measured minute, so the sheet opens in the app's own handwriting and nothing
 * new is asked of the geometry.
 */
function Face({
  arrival,
  song,
  colour,
}: {
  arrival: SharedValue<number>;
  song: SongHeader;
  colour: string;
}) {
  const size = SONG_SHEET_KNOBS.SEAT_PX;
  const traced = useDerivedValue(() =>
    windowed(
      arrival.value,
      SONG_SHEET_KNOBS.FACE_WINDOW[0],
      SONG_SHEET_KNOBS.FACE_WINDOW[1],
    ),
  );
  const path = useMemo(
    () =>
      nameLensFacePath(
        {
          seed: song.seed,
          id: song.id,
          model: song.model,
          durationMs: song.duration_ms,
        },
        size / 2.6,
      ),
    [song.duration_ms, song.id, song.model, song.seed, size],
  );
  return (
    <Canvas style={{ width: size, height: size }}>
      <Path
        color={colour}
        end={traced}
        path={path}
        start={0}
        style="stroke"
        strokeWidth={1}
        transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}
      />
    </Canvas>
  );
}

/** What you do with a song. */
function Front({
  arrival,
  audioState,
  busy,
  downloaded,
  deliveryBytes,
  full,
  nodeLabel,
  onPin,
  onRemoveDownload,
  onRename,
  onTitle,
  onTogglePlaylist,
  onToggleTag,
  onUnpin,
  placeEntries,
  placementCount,
  playlistProblem,
  problem,
  scopeLabel,
  tagProblem,
  title,
  usedTags,
  wordEntries,
}: {
  arrival: SharedValue<number>;
  audioState: LocalAudioState;
  busy: boolean;
  downloaded: boolean;
  deliveryBytes: number | null;
  full: boolean;
  nodeLabel: string;
  onPin: () => void;
  onRemoveDownload: () => void;
  onRename: () => void;
  onTitle: (value: string) => void;
  onTogglePlaylist: (name: string, member: boolean) => void;
  onToggleTag: (name: string, member: boolean) => void;
  onUnpin: () => void;
  placeEntries: readonly MembershipEntry[];
  placementCount: number;
  playlistProblem: (name: string) => string | null;
  problem: string | null;
  scopeLabel: string | null;
  tagProblem: (name: string) => string | null;
  title: string;
  usedTags: number;
  wordEntries: readonly MembershipEntry[];
}) {
  const pal = usePalette();
  const pinned = audioState === 'pinned';
  // The axis exists before the facts land on it, and after the mark that
  // opened the sheet: one clock, read at three different stretches of itself.
  const spine = useDerivedValue(() =>
    windowed(
      arrival.value,
      SONG_SHEET_KNOBS.SPINE_WINDOW[0],
      SONG_SHEET_KNOBS.SPINE_WINDOW[1],
    ),
  );
  const frees =
    deliveryBytes === null ? null : `FREES ${formatBytes(deliveryBytes)}`;
  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.body}>
        {/*
          The title is the subject, not a field: a panel with one subject puts
          it above the spine. Renaming is tapping the word, which is what the
          composer's caption already does — there was never a box, only a
          title someone might change.
        */}
        <Arriving arrival={arrival} index={0} style={styles.subject}>
          <Subject
            arrival={arrival}
            busy={busy}
            colour={pal.ink}
            onBlur={onRename}
            onChangeText={onTitle}
            title={title}
          />
          <Text style={[type.eyebrow, styles.scope, { color: pal.faint }]}>
            {scopeSummary(scopeLabel, nodeLabel, placementCount)}
          </Text>
        </Arriving>

        <Ledger arrival={spine}>
          <Arriving arrival={arrival} index={1}>
            <Row control label="Playlists">
              <Membership
                addPlaceholder="new playlist"
                busy={busy}
                empty="In no playlist."
                entries={placeEntries}
                full={full}
                note={budget(usedTags)}
                onToggle={onTogglePlaylist}
                problemOf={playlistProblem}
              />
            </Row>
          </Arriving>
          <Arriving arrival={arrival} index={2}>
            <Row control label="Tags">
              <Membership
                addPlaceholder="add a tag"
                busy={busy}
                empty="No tags."
                entries={wordEntries}
                full={full}
                note={budget(usedTags)}
                onToggle={onToggleTag}
                problemOf={tagProblem}
              />
            </Row>
          </Arriving>
          <LedgerGap />
          <Arriving arrival={arrival} index={3}>
            <Row
              label="Offline"
              note={weight(deliveryBytes, downloaded, nodeLabel)}
            >
              <Text style={[type.body, { color: pal.ink }]}>
                {whereItIs(audioState, nodeLabel)}
              </Text>
            </Row>
          </Arriving>
          {downloaded ? (
            <Arriving arrival={arrival} index={4}>
              <Row
                label={frees ?? 'FREES THE COPY'}
                note={`STAYS ON ${nodeLabel.toUpperCase()}`}
              >
                <Act
                  busy={busy}
                  label="Remove from this phone"
                  onPress={onRemoveDownload}
                />
              </Row>
            </Arriving>
          ) : null}
        </Ledger>
      </ScrollView>

      {/*
        The foot carries what you most often want from a song: whether its
        audio is here, and the one word that changes that.
      */}
      {/*
        What is wrong sits above the act rather than in a banner or beside the
        control that caused it: the eye is already on its way to the foot.
      */}
      {problem === null ? null : (
        <Text style={[type.eyebrow, styles.problem, { color: pal.ink }]}>
          {problem.toUpperCase()}
        </Text>
      )}
      <LedgerFoot>
        {/*
          One act, two strings. Keeping a song and letting go of it are the two
          sides of one switch, so the foot does not swap a word for another —
          the word becomes the other word, and the promise under it follows on
          the same clock. Two Acts taking turns is what this used to be, and it
          read as the foot being rebuilt every time you touched it.
        */}
        <Act
          busy={busy || (!pinned && !downloaded)}
          display
          label={pinned ? 'Unpin' : 'Keep it here'}
          morph
          onPress={pinned ? onUnpin : onPin}
        />
        <TransformText
          charStyle={type.eyebrow}
          color={pal.faint}
          duration={SONG_SHEET_KNOBS.ACT_MS}
          style={styles.footNoteSlot}
          text={pinned ? 'KEPT UNTIL YOU SAY SO' : 'NEVER PURGED ONCE KEPT'}
        />
      </LedgerFoot>
    </View>
  );
}

/** What a song is, and the act that ends it. */
function Back({
  busy,
  confirming,
  detail,
  detailError,
  deliveryBytes,
  downloaded,
  masterBytes,
  nodeLabel,
  onAsk,
  onDelete,
  onKeep,
  placementCount,
  song,
}: {
  busy: boolean;
  confirming: boolean;
  detail: SongDetail | null;
  detailError: string | null;
  deliveryBytes: number | null;
  downloaded: boolean;
  masterBytes: number | null;
  nodeLabel: string;
  onAsk: () => void;
  onDelete: () => void;
  onKeep: () => void;
  placementCount: number;
  song: SongHeader;
}) {
  const pal = usePalette();
  const made = new Date(song.created_at);
  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.body}>
        <LedgerGap />
        <Ledger>
          <Row label="Made" note={clockOf(made)}>
            <Text style={[type.body, { color: pal.ink }]}>{dateOf(made)}</Text>
          </Row>
          <Row label="Length">
            <Text style={[type.body, { color: pal.ink }]}>
              {duration(song.duration_ms)}
            </Text>
          </Row>
          <LedgerGap />
          {detailError !== null ? (
            <Row label="Recipe">
              <Text style={[type.body, { color: pal.muted }]}>
                {detailError}
              </Text>
            </Row>
          ) : detail === null ? (
            <Row label="Recipe">
              <Text style={[type.body, { color: pal.muted }]}>
                {`Asking ${nodeLabel}\u2026`}
              </Text>
            </Row>
          ) : (
            <>
              <Row label="Prompt">
                <Text style={[type.body, { color: pal.ink }]}>
                  {detail.generation.caption}
                </Text>
              </Row>
              <Row label="Words">
                <Text
                  style={[
                    type.body,
                    {
                      color: detail.generation.lyrics ? pal.ink : pal.faint,
                    },
                  ]}
                >
                  {detail.generation.lyrics ?? 'instrumental'}
                </Text>
              </Row>
              <LedgerGap />
              <Fact label="Engine" value={`${detail.engine} · ${nodeLabel}`} />
              <Fact label="Model" mono value={song.model} />
              <Fact
                label="Seed"
                value={`${
                  song.seed === undefined ? 'unset' : String(song.seed)
                } · ${detail.attempts} attempt${
                  detail.attempts === 1 ? '' : 's'
                }`}
              />
              {/*
                Whatever the chosen model declared. This is the one block whose
                length is not known at build time, which is why it sits between
                two gaps rather than inside a fixed set of rows.
              */}
              {declared(detail).length === 0 ? null : (
                <>
                  <LedgerGap />
                  {declared(detail).map(([name, value]) => (
                    <Fact key={name} label={name} value={value} />
                  ))}
                </>
              )}
              <LedgerGap />
              <Fact
                label="Here"
                mono
                value={
                  downloaded && deliveryBytes !== null
                    ? formatBytes(deliveryBytes)
                    : 'nothing'
                }
              />
              <Fact
                label={`On ${nodeLabel}`}
                mono
                value={
                  masterBytes === null ? 'unknown' : formatBytes(masterBytes)
                }
              />
              {detail.component_digests.map((digest, index) => (
                <Fact
                  key={digest}
                  label={index === 0 ? 'Digest' : ''}
                  mono
                  value={digest.slice(0, SONG_SHEET_KNOBS.DIGEST_PREFIX_CHARS)}
                />
              ))}
            </>
          )}
        </Ledger>
      </ScrollView>

      {/*
        The end of the song, where arriving deliberately is worth more than a
        dialog — and it asks anyway.
      */}
      <LedgerFoot>
        {confirming ? (
          <View style={styles.confirm}>
            <Act busy={busy} display label="Delete it" onPress={onDelete} />
            <Act busy={busy} label="Keep it" onPress={onKeep} />
          </View>
        ) : (
          <Act busy={busy} display label="Delete everywhere" onPress={onAsk} />
        )}
        <Text style={[type.eyebrow, styles.footNote, { color: pal.faint }]}>
          {cost(downloaded ? deliveryBytes : null, masterBytes, nodeLabel)}
        </Text>
        <Text style={[type.eyebrow, styles.footHard, { color: pal.ink }]}>
          {confirming ? 'THERE IS NO UNDO' : noUndo(placementCount)}
        </Text>
      </LedgerFoot>
    </View>
  );
}

/**
 * One block of the sheet, landing on the axis after it has been drawn.
 *
 * Opacity and a 6 px rise, nothing else: a layout prop driven from the UI
 * thread never reaches React Native's layout pass and snaps instead, which
 * `Reveal` documents and this obeys. The seats are permanent either way — the
 * front page is laid out at rest and only its ink arrives.
 */
function Arriving({
  arrival,
  children,
  index,
  style,
}: {
  arrival: SharedValue<number>;
  children: React.ReactNode;
  index: number;
  style?: StyleProp<ViewStyle>;
}) {
  const landed = useAnimatedStyle(() => {
    const from =
      SONG_SHEET_KNOBS.ROWS_FROM + index * SONG_SHEET_KNOBS.ARRIVAL_LAG;
    const local = windowed(
      arrival.value,
      from,
      from + SONG_SHEET_KNOBS.ARRIVAL_RISE,
    );
    return {
      opacity: local,
      transform: [
        { translateY: (1 - local) * SONG_SHEET_KNOBS.ARRIVAL_RISE_PX },
      ],
    };
  });
  return <Animated.View style={[style, landed]}>{children}</Animated.View>;
}

/**
 * An act: a word in the value column, in the panel's voice or the foot's.
 *
 * `morph` is for an act whose label is one half of a state rather than a name:
 * the word is then drawn as geometry and transformed into its opposite when
 * the state turns over. It costs a reserved slot, which is why it is asked for
 * rather than assumed — a settled `Text` still measures itself.
 */
function Act({
  busy,
  display,
  label,
  morph = false,
  onPress,
}: {
  busy: boolean;
  display?: boolean;
  label: string;
  morph?: boolean;
  onPress: () => void;
}) {
  const pal = usePalette();
  const colour = busy ? pal.faint : pal.ink;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={styles.act}
    >
      {morph ? (
        <TransformText
          charStyle={display ? type.heading : type.body}
          color={colour}
          duration={SONG_SHEET_KNOBS.ACT_MS}
          style={styles.actSlot}
          text={label}
        />
      ) : (
        <Text style={[display ? type.heading : type.body, { color: colour }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function Fact({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  const pal = usePalette();
  return (
    <Row label={label}>
      <Text style={[mono ? type.mono : type.body, { color: pal.ink }]}>
        {value}
      </Text>
    </Row>
  );
}

/** `FROM DOG WALK · 3 PLACEMENTS`, and the honest singular. */
function scopeSummary(
  scopeLabel: string | null,
  nodeLabel: string,
  placementCount: number,
): string {
  const where =
    scopeLabel === null
      ? nodeLabel.toUpperCase()
      : `FROM ${scopeLabel.toUpperCase()}`;
  const marks = `${placementCount} PLACEMENT${placementCount === 1 ? '' : 'S'}`;
  return `${where} · ${marks}`;
}

/** The shared count, which is only interesting while you are adding. */
function budget(used: number): string {
  return `${used} OF 16 SHARED`;
}

/** What the copy here weighs, or what fetching one would cost. */
function weight(
  deliveryBytes: number | null,
  downloaded: boolean,
  nodeLabel: string,
): string {
  const where = `ON ${nodeLabel.toUpperCase()}`;
  if (deliveryBytes === null) return where;
  const size = formatBytes(deliveryBytes);
  return downloaded ? `${size} HERE · ${where}` : `${size} TO FETCH · ${where}`;
}

function whereItIs(audioState: LocalAudioState, nodeLabel: string): string {
  switch (audioState) {
    case 'pinned':
      return 'Downloaded on this phone';
    case 'cached':
      return 'Cached on this phone';
    case 'partial':
      return 'Arriving';
    default:
      return `On ${nodeLabel} only`;
  }
}

/** Both numbers, which is the one sentence only this act gets to make. */
function cost(
  deliveryBytes: number | null,
  masterBytes: number | null,
  nodeLabel: string,
): string {
  const here =
    deliveryBytes === null ? null : `${formatBytes(deliveryBytes)} HERE`;
  const there =
    masterBytes === null
      ? `EVERYTHING ON ${nodeLabel.toUpperCase()}`
      : `${formatBytes(masterBytes)} ON ${nodeLabel.toUpperCase()}`;
  return here === null ? there : `${here} · ${there}`;
}

function noUndo(placementCount: number): string {
  return placementCount <= 1
    ? 'NO UNDO'
    : `NO UNDO · ${placementCount} PLACEMENTS GO`;
}

/** Every parameter the model itself declared, in the order it declared them. */
function declared(detail: SongDetail): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const { steps, cfg, extensions } = detail.generation;
  if (steps !== undefined) out.push(['Steps', String(steps)]);
  if (cfg !== undefined) out.push(['Guidance', String(cfg)]);
  for (const [name, value] of Object.entries(extensions ?? {})) {
    out.push([name, String(value)]);
  }
  return out;
}

/** The names the song holds, then every other name that exists. */
function merge(
  held: readonly string[],
  known: readonly string[],
): MembershipEntry[] {
  const folded = new Set(held.map(name => name.toLocaleLowerCase()));
  return [
    ...held.map(name => ({ name, member: true })),
    ...known
      .filter(name => !folded.has(name.toLocaleLowerCase()))
      .map(name => ({ name, member: false })),
  ];
}

function duration(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function dateOf(made: Date): string {
  return Number.isNaN(made.getTime())
    ? 'unknown'
    : made.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
}

function clockOf(made: Date): string | undefined {
  if (Number.isNaN(made.getTime())) return undefined;
  return made
    .toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    .toUpperCase();
}

const styles = StyleSheet.create({
  /** The Curtain owns the surface; this is only what stands on it. */
  sheet: { flex: 1, paddingBottom: space.lg },
  header: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'space-between',
  },
  seat: { alignItems: 'center', flexDirection: 'row', minHeight: touch.min },
  star: {
    fontFamily: type.title.fontFamily,
    fontSize: 13,
    marginLeft: space.xs,
  },
  nameSlot: { flex: 1, height: 16, marginHorizontal: space.md },
  pager: { flex: 1 },
  /**
   * Clipped: `LedgerFoot` hangs its rule past the page margin by design, and
   * in a pager that margin is the next page — the front page's foot rule was
   * showing up at the left edge of the record.
   */
  page: { flex: 1, overflow: 'hidden' },
  body: { paddingBottom: space.lg },
  subject: { paddingBottom: space.md, paddingTop: space.md },
  titleField: { padding: 0 },
  scope: { marginTop: space.sm },
  act: { justifyContent: 'center', minHeight: touch.min },
  /** A morphing word needs a slot that does not resize under it. */
  actSlot: { height: SONG_SHEET_KNOBS.ACT_SLOT_PX },
  footNoteSlot: {
    height: SONG_SHEET_KNOBS.NOTE_SLOT_PX,
    marginTop: space.xs,
  },
  confirm: { alignItems: 'baseline', flexDirection: 'row', gap: space.lg },
  footNote: { marginTop: space.xs },
  problem: { marginBottom: space.xs, marginLeft: LEDGER_VALUE_PX },
  footHard: { letterSpacing: 1.6, marginTop: 2 },
  hem: {
    alignSelf: 'center',
    bottom: space.sm,
    height: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: SONG_SHEET_KNOBS.MARK_GAP_PX,
    position: 'absolute',
  },
  mark: { height: StyleSheet.hairlineWidth, width: SONG_SHEET_KNOBS.MARK_W_PX },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const SongSheet = React.memo(SongSheetImpl);
