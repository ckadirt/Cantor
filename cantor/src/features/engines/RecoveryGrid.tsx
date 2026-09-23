import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Canvas,
  Points,
  Skia,
  Text as SkText,
  type SkFont,
  type SkPoint,
} from '@shopify/react-native-skia';
import { mulberry32, smootherstep, useMorphFont } from '../../motion';
import { font, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the twelve words, at rest as dust and revealed as ink.
 *
 * Every hidden block is the same size on purpose. A cloud shaped like its word
 * would give away each word's length, and the concealed state is on screen
 * whenever settings is open — it has to say nothing at all.
 */
export const RECOVERY_KNOBS = {
  /** Two columns, read down: 01–06 on the left, 07–12 on the right. */
  COLUMNS: 2,
  ROW_PX: 30,
  /** The room the `01` takes before its word begins. */
  INDEX_W_PX: 26,
  INDEX_SIZE_PX: 10,
  /** The one width every hidden word is drawn at, about a six-letter word. */
  BLOCK_W_PX: 58,
  /** How tall the cloud is: a little more than the face's x-height. */
  BLOCK_H_PX: 11,
  /** Motes per word. Enough to trace an eight-letter word's outline. */
  PARTICLES: 72,
  /** Share of each word's motes drawn faint, as the halo round the core. */
  HALO_SHARE: 0.4,
  CORE_ALPHA: 0.62,
  HALO_ALPHA: 0.26,
  DOT_PX: 1.6,
  /** How far a mote wanders from its seat while the words are hidden. */
  DRIFT_PX: 1.2,
  /** One full cycle of that wandering; the loop is seamless, so it can be slow. */
  DRIFT_MS: 7000,
  /** The whole reveal, first mote of 01 leaving to the fill of 12 settling. */
  REVEAL_MS: 1400,
  /**
   * A held breath before a reveal leaves the dust.
   *
   * A reveal starts as Cantor comes back from the device-lock prompt, and the
   * first frames after a resume are the least reliable the app draws. Starting
   * at once spent the first motion of the clock where nobody could see it. Hiding needs no
   * such wait — nothing arrives and nothing resumes.
   */
  REVEAL_DELAY_MS: 220,
  /** Of that clock, how much is spent starting one word after the last. */
  WORD_CASCADE: 0.35,
  /** Within a word, how much of its clock the motes spend leaving, left to right. */
  MOTE_LAG: 0.35,
  /** Within a word, where every mote has landed on the outline. */
  LANDED: 0.78,
  /** Within a word, where the fill starts to come up under the landed motes. */
  FILL_FROM: 0.66,
} as const;

const K = RECOVERY_KNOBS;
const ROWS = Math.ceil(12 / K.COLUMNS);
export const RECOVERY_GRID_HEIGHT_PX = ROWS * K.ROW_PX;

const WORD_STYLE = type.body;
const INDEX_STYLE = { fontFamily: font.mono, fontSize: K.INDEX_SIZE_PX } as const;
const TURN = 2 * Math.PI;

/** Where one word sits: its left edge after the index, and its baseline. */
type Seat = { x: number; baseline: number; mid: number };

/** One layer of a word's cloud as flat arrays, ready to cross into a worklet. */
type Cloud = {
  /** Each mote's place in left-to-right order: the landing point it takes. */
  id: number[];
  hx: number[];
  hy: number[];
  k1: number[];
  k2: number[];
  p1: number[];
  p2: number[];
};

/** Where a word's motes land, indexed by mote `id`. */
type Landing = { tx: number[]; ty: number[]; lag: number[] };

/**
 * Twelve words drawn as diffuse clouds of motes until they are revealed, when
 * each cloud condenses onto its word's glyph outline and the fill comes up
 * under it.
 *
 * `words` is null until the owner has proved who they are; the clouds are
 * seeded from the seat index alone, so the hidden grid is identical for every
 * phrase. `revealed` is the gesture, and runs both ways: hiding scatters the
 * words back into dust on the same clock reversed. The owner keeps `words`
 * mounted until that has finished (`REVEAL_MS`), and a null `words` snaps to
 * dust at once, which is what backgrounding the app asks for.
 */
export function RecoveryGrid({
  revealed,
  words,
}: {
  revealed: boolean;
  words: readonly string[] | null;
}) {
  const pal = usePalette();
  const reducedMotion = useReducedMotion();
  const wordFont = useMorphFont(WORD_STYLE);
  const indexFont = useMorphFont(INDEX_STYLE);
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(0);
  const drift = useSharedValue(0);
  const landings = useSharedValue<readonly (Landing | null)[]>([]);

  useEffect(() => {
    if (reducedMotion) return;
    drift.value = 0;
    drift.value = withRepeat(
      withTiming(1, { duration: K.DRIFT_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(drift);
  }, [drift, reducedMotion]);

  const seats = useMemo(() => {
    if (width <= 0 || wordFont === null) return [];
    const xHeight = wordFont.measureText('x').height || WORD_STYLE.fontSize * 0.45;
    const column = width / K.COLUMNS;
    return Array.from({ length: 12 }, (_, i): Seat => {
      const col = Math.floor(i / ROWS);
      const row = i % ROWS;
      const baseline = row * K.ROW_PX + K.ROW_PX / 2 + xHeight / 2;
      return { x: col * column + K.INDEX_W_PX, baseline, mid: baseline - xHeight / 2 };
    });
  }, [width, wordFont]);

  const built = useMemo(
    () =>
      words === null || wordFont === null
        ? []
        : seats.map((seat, i) => buildLanding(wordFont, words[i] ?? '', seat)),
    [seats, wordFont, words],
  );

  // The landings and the clock are written together, landings first, from
  // this one effect. The cells sit inside the canvas, whose reconciler commits
  // after this one: when each cell wrote its own landing, the clock had
  // already started, the first frames took the no-outline crossfade, and the
  // words faded up, snapped back to dust, and only then condensed.
  useEffect(() => {
    if (words === null) {
      cancelAnimation(progress);
      progress.value = 0;
      landings.value = [];
      return;
    }
    landings.value = built;
    const run = withTiming(revealed ? 1 : 0, {
      duration: reducedMotion ? K.REVEAL_MS / 3 : K.REVEAL_MS,
      easing: Easing.linear,
    });
    progress.value = revealed ? withDelay(K.REVEAL_DELAY_MS, run) : run;
  }, [built, landings, progress, reducedMotion, revealed, words]);

  const onLayout = (event: LayoutChangeEvent) =>
    setWidth(event.nativeEvent.layout.width);

  return (
    <View
      accessible
      accessibilityLabel={
        revealed && words
          ? words.map((word, i) => `${i + 1}, ${word}`).join('. ')
          : 'Twelve recovery words, hidden'
      }
      onLayout={onLayout}
      style={styles.grid}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        {seats.map((seat, i) => (
          <React.Fragment key={i}>
            {indexFont === null ? null : (
              <SkText
                color={pal.faint}
                font={indexFont}
                text={String(i + 1).padStart(2, '0')}
                x={seat.x - K.INDEX_W_PX}
                y={seat.baseline}
              />
            )}
            <WordCell
              colour={pal.ink}
              drift={drift}
              font={wordFont!}
              index={i}
              landings={landings}
              progress={progress}
              reducedMotion={reducedMotion}
              seat={seat}
              word={words?.[i] ?? null}
            />
          </React.Fragment>
        ))}
      </Canvas>
    </View>
  );
}

/**
 * One word's cloud, its landing, and its fill.
 *
 * Its own window of the grid's clock, in reading order, so the twelve resolve
 * as a sentence rather than all at once. Inside the window each mote leaves
 * after a lag proportional to its x, so a word condenses left to right the way
 * it is read; every mote has landed by `LANDED`, and the fill overlaps the last
 * of the landing so the outline never stands alone as a separate state.
 */
function WordCell({
  colour,
  drift,
  font: wordFont,
  index,
  landings,
  progress,
  reducedMotion,
  seat,
  word,
}: {
  colour: string;
  drift: SharedValue<number>;
  font: SkFont;
  index: number;
  landings: SharedValue<readonly (Landing | null)[]>;
  progress: SharedValue<number>;
  reducedMotion: boolean;
  seat: Seat;
  word: string | null;
}) {
  // The cloud depends on the seat alone, so its worklets are built once and
  // never torn down when the words arrive. Where the motes land is data handed
  // to them by the grid (`landings`): a reveal that rebuilt twelve cells'
  // mappers on the commit that started its clock lost its first frames to the
  // rebuild, and the motes jumped rather than left.
  const [core, halo] = useMemo(() => buildCloud(index, seat), [index, seat]);
  const landing = useDerivedValue(() => landings.value[index] ?? null);
  const start = (index / 11) * K.WORD_CASCADE;
  const span = 1 - K.WORD_CASCADE;
  // Without an outline (reduced motion, or a runtime with no glyph paths) the
  // motes stay where they are and the two states crossfade.
  const travels = useDerivedValue(() => !reducedMotion && landing.value !== null);
  const local = useDerivedValue(() =>
    Math.min(1, Math.max(0, (progress.value - start) / span)),
  );
  const corePoints = useDerivedValue(() =>
    place(core, landing.value, local.value, drift.value, travels.value),
  );
  const haloPoints = useDerivedValue(() =>
    place(halo, landing.value, local.value, drift.value, travels.value),
  );
  const dust = useDerivedValue(() =>
    travels.value
      ? 1 - smootherstep(K.LANDED, 1, local.value)
      : 1 - smootherstep(0, 1, local.value),
  );
  const coreAlpha = useDerivedValue(() => K.CORE_ALPHA * dust.value);
  const haloAlpha = useDerivedValue(() => K.HALO_ALPHA * dust.value);
  const fill = useDerivedValue(() =>
    travels.value
      ? smootherstep(K.FILL_FROM, 1, local.value)
      : smootherstep(0, 1, local.value),
  );

  return (
    <>
      <Points
        color={colour}
        mode="points"
        opacity={haloAlpha}
        points={haloPoints}
        strokeCap="round"
        strokeWidth={K.DOT_PX}
      />
      <Points
        color={colour}
        mode="points"
        opacity={coreAlpha}
        points={corePoints}
        strokeCap="round"
        strokeWidth={K.DOT_PX}
      />
      {/*
        Mounted from the start and handed the word later, never mounted with
        it. A node's animated opacity is bound after the node exists, so a fill
        mounted on the reveal's commit drew at full ink for a frame before its
        binding held it at 0 — twelve words flashing up ahead of their dust.
      */}
      <SkText
        color={colour}
        font={wordFont}
        opacity={fill}
        text={word ?? ''}
        x={seat.x}
        y={seat.baseline}
      />
    </>
  );
}

/** Where every mote is this frame: its seat, wandering, pulled toward the ink. */
function place(
  m: Cloud,
  landing: Landing | null,
  local: number,
  drift: number,
  travels: boolean,
): SkPoint[] {
  'worklet';
  const out: SkPoint[] = [];
  const settle = K.LANDED - K.MOTE_LAG;
  for (let i = 0; i < m.hx.length; i++) {
    const id = m.id[i];
    const lag = landing === null ? 0 : landing.lag[id];
    const s = travels && landing !== null ? smootherstep(lag, lag + settle, local) : 0;
    const loose = 1 - s;
    const x = m.hx[i] + loose * K.DRIFT_PX * Math.sin(TURN * (m.k1[i] * drift + m.p1[i]));
    const y = m.hy[i] + loose * K.DRIFT_PX * Math.sin(TURN * (m.k2[i] * drift + m.p2[i]));
    if (s === 0 || landing === null) {
      out.push({ x, y });
    } else {
      out.push({
        x: x + (landing.tx[id] - m.hx[i]) * s,
        y: y + (landing.ty[id] - m.hy[i]) * s,
      });
    }
  }
  return out;
}

/**
 * `PARTICLES` points spaced evenly along the word's true outline, every
 * contour included, so a counter gets its share. Null where glyph paths are
 * not available (CanvasKit in Jest).
 */
function outlineTargets(wordFont: SkFont, word: string, seat: Seat): { x: number; y: number }[] | null {
  let path;
  try {
    path = Skia.Path.MakeFromText(word, seat.x, seat.baseline, wordFont);
  } catch {
    return null;
  }
  if (!path) return null;
  const contours = [];
  const iter = Skia.ContourMeasureIter(path, false, 1);
  let total = 0;
  for (let c = iter.next(); c; c = iter.next()) {
    const length = c.length();
    if (length > 1e-3) {
      contours.push({ c, length });
      total += length;
    }
  }
  if (total <= 0) return null;
  const out: { x: number; y: number }[] = [];
  let at = 0;
  let passed = 0;
  for (let i = 0; i < K.PARTICLES; i++) {
    const d = ((i + 0.5) * total) / K.PARTICLES;
    while (at < contours.length - 1 && d > passed + contours[at].length) {
      passed += contours[at].length;
      at++;
    }
    const [pos] = contours[at].c.getPosTan(Math.min(d - passed, contours[at].length));
    out.push({ x: pos.x, y: pos.y });
  }
  return out;
}

/**
 * The cloud, seeded by seat alone and split into its core and halo. Motes are
 * numbered left to right (`id`), which is the order they are paired with the
 * outline in, so each travels a short way and the word fills in from the left.
 */
function buildCloud(index: number, seat: Seat): [Cloud, Cloud] {
  const rand = mulberry32(0x5eed + index * 7919);
  const layers: [Cloud, Cloud] = [emptyCloud(), emptyCloud()];
  for (let i = 0; i < K.PARTICLES; i++) {
    // Stratified across the width so no stretch of a block goes bare, and a
    // three-sample bell vertically so the edges thin out into nothing.
    const u = (i + rand()) / K.PARTICLES;
    const v = (rand() + rand() + rand()) / 3 - 0.5;
    const layer = layers[rand() < K.HALO_SHARE ? 1 : 0];
    layer.id.push(i);
    layer.hx.push(seat.x + u * K.BLOCK_W_PX);
    layer.hy.push(seat.mid + v * 2 * K.BLOCK_H_PX);
    layer.k1.push(1 + Math.floor(rand() * 3));
    layer.k2.push(1 + Math.floor(rand() * 3));
    layer.p1.push(rand());
    layer.p2.push(rand());
  }
  return layers;
}

/** Where mote `id` lands on this word, and how long it waits to leave. */
function buildLanding(wordFont: SkFont, word: string, seat: Seat): Landing | null {
  const targets = outlineTargets(wordFont, word, seat);
  if (targets === null) return null;
  const sorted = [...targets].sort((a, b) => a.x - b.x);
  const minX = sorted[0].x;
  const reach = Math.max(sorted[sorted.length - 1].x - minX, 1);
  return {
    tx: sorted.map(p => p.x),
    ty: sorted.map(p => p.y),
    lag: sorted.map(p => K.MOTE_LAG * ((p.x - minX) / reach)),
  };
}

function emptyCloud(): Cloud {
  return { id: [], hx: [], hy: [], k1: [], k2: [], p1: [], p2: [] };
}

const styles = StyleSheet.create({
  grid: { height: RECOVERY_GRID_HEIGHT_PX, width: '100%' },
});
