/**
 * Panel 1 — what Cantor is. Orient before identity.
 *
 * Blackout. A licence clause in the grey voice of the usual terms writes
 * itself: the songs you make belong to the company, and you are lent them.
 * A pen blacks it out bar by bar, the way a redacted document looks. The
 * only words it spares — "All rights … remain with … you" — lift out of the
 * page on shallow arcs, grow to reading size, and close into one sentence:
 * All rights remain with you.
 *
 * One linear clock, a smootherstep window per gesture. Words use WriteText
 * both ways (write, and the erase under a bar); bars are one Skia canvas.
 * The clause is wrapped here, from the real font metrics, so the bars and
 * the flights know exactly where every word sits.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import { Canvas, Rect, type SkFont } from '@shopify/react-native-skia';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { smootherstep, useMorphFont, WriteText } from '../../motion';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

/* ------------------------------------------------------------- motion knobs */
/** The whole story, clause to sentence, on one linear clock. */
const STORY_MS = 6000;
/** Lets the body finish rising before the first stroke. */
const STORY_DELAY_MS = 350;

type Win = readonly [number, number];
// Act I — the clause writes itself, line by line.
const W_EYEBROW: Win = [0, 0.1];
const W_LINE: Win = [0.02, 0.2];
const LINE_LAG = 0.035;
// Act II — the pen blacks out each run of words, in reading order.
const W_BAR: Win = [0.3, 0.36];
const BAR_LAG = 0.035;
/** The spared words come up from grey to ink while the pen works. */
const W_SPARED: Win = [0.34, 0.5];
// Act III — the bars wipe away, the spared words fly and grow.
const W_EYEBROW_OUT: Win = [0.5, 0.58];
const W_WIPE: Win = [0.56, 0.64];
const WIPE_LAG = 0.012;
const W_FLIGHT: Win = [0.6, 0.8];
const FLIGHT_LAG = 0.035;
const W_STOP: Win = [0.82, 0.88]; // the full stop the sentence never had
const W_LEDGER: Win = [0.86, 1];

/* ------------------------------------------------------------- layout knobs */
// The clause is the panels' prose size (type.small); the sentence sits a
// step under the frame's title so the title keeps the top of the hierarchy.
const CLAUSE_SIZE = type.small.fontSize;
const CLAUSE_LINE_H = type.small.lineHeight;
const SENTENCE_SIZE = 20; // the spared words' reading size
const SENTENCE_LINE_H = (CLAUSE_LINE_H * SENTENCE_SIZE) / CLAUSE_SIZE;
const EYEBROW_H = 15;
const EYEBROW_GAP = 9; // eyebrow → first clause line
const BAR_H = 13; // the redaction's height, centred on its line
const BAR_PAD = 2; // how far a bar runs past its words
const SLACK = 6; // extra width per text slot so a run can never wrap
/** Peak rise of a flight above its straight line, as a share of its length. */
const ARC_RATIO = 0.18;
const LEDGER_GAP = 6; // sentence bottom → ledger top
const LEDGER_H = 15;

const EYEBROW = 'THE USUAL TERMS';
const LEDGER = 'NO LICENCE · NO LOCKOUTS · NO RULES';

/** The clause, split where the pen leaves words alone. */
const CLAUSE: readonly { text: string; spared?: number }[] = [
  { text: 'All rights', spared: 0 },
  { text: 'in the songs you make' },
  { text: 'remain with', spared: 1 },
  { text: 'the Company. Subject to an active subscription,' },
  { text: 'you', spared: 2 },
  { text: 'are granted a limited, revocable licence to use them.' },
];

const CLAUSE_STYLE: TextStyle = {
  fontFamily: type.body.fontFamily,
  fontSize: CLAUSE_SIZE,
  lineHeight: CLAUSE_LINE_H,
};
const SENTENCE_STYLE: TextStyle = {
  fontFamily: type.body.fontFamily,
  fontSize: SENTENCE_SIZE,
  lineHeight: SENTENCE_LINE_H,
};
const EYEBROW_STYLE: TextStyle = { ...type.eyebrow, fontSize: 10, letterSpacing: 1.8 };

/* ------------------------------------------------------------------- layout */

type Run = { text: string; x: number; y: number; w: number; line: number; order: number };
type Spared = {
  text: string;
  /** Box at sentence size; its centre sits at `from` at clause scale. */
  w: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  line: number;
};
type Layout = {
  runs: Run[];
  spared: Spared[];
  stop: { x: number; y: number; w: number };
  lines: number;
  sentenceTop: number;
  height: number;
};

function measure(font: SkFont, text: string) {
  return font.getGlyphWidths(font.getGlyphIDs(text)).reduce((sum, v) => sum + v, 0);
}

/**
 * Greedy word wrap over the clause, keeping each spared phrase whole.
 * Redacted words on one line merge into a single run, so a bar covers a run.
 */
function layoutClause(w: number, small: SkFont, large: SkFont): Layout {
  const scale = CLAUSE_SIZE / SENTENCE_SIZE;
  const gap = measure(small, ' ');
  type Token = { text: string; w: number; spared?: number };
  const tokens: Token[] = [];
  for (const part of CLAUSE) {
    if (part.spared !== undefined) {
      tokens.push({ text: part.text, w: measure(large, part.text) * scale, spared: part.spared });
    } else {
      for (const word of part.text.split(' ')) {
        tokens.push({ text: word, w: measure(small, word) });
      }
    }
  }

  const top = EYEBROW_H + EYEBROW_GAP;
  const runs: Run[] = [];
  const sparedAt: { x: number; y: number; line: number }[] = [];
  let line = 0;
  let x = 0;
  let open: Run | null = null;
  for (const token of tokens) {
    const start = x === 0 ? 0 : x + gap;
    if (start + token.w > w && x > 0) {
      line += 1;
      x = 0;
      open = null;
    }
    const at = x === 0 ? 0 : x + gap;
    const y = top + line * CLAUSE_LINE_H;
    if (token.spared !== undefined) {
      sparedAt[token.spared] = { x: at + token.w / 2, y: y + CLAUSE_LINE_H / 2, line };
      open = null;
    } else if (open) {
      open.text += ` ${token.text}`;
      open.w = at + token.w - open.x;
    } else {
      open = { text: token.text, x: at, y, w: token.w, line, order: runs.length };
      runs.push(open);
    }
    x = at + token.w;
  }
  const lines = line + 1;

  // The sentence: the spared phrases on one line, then a full stop. It
  // settles at the top of the stage on the text column's left edge, where
  // every other panel starts its content, so "All rights" barely moves.
  const bigSpace = measure(large, ' ');
  const texts = CLAUSE.filter(p => p.spared !== undefined).map(p => p.text);
  const widths = texts.map(t => measure(large, t));
  const stopW = measure(large, '.');
  const sentenceTop = 0;
  let tx = 0;
  const spared: Spared[] = texts.map((text, i) => {
    const to = { x: tx + widths[i] / 2, y: sentenceTop + SENTENCE_LINE_H / 2 };
    tx += widths[i] + (i < texts.length - 1 ? bigSpace : 0);
    return { text, w: widths[i], from: sparedAt[i], to, line: sparedAt[i].line };
  });

  const height = Math.max(
    top + lines * CLAUSE_LINE_H,
    sentenceTop + SENTENCE_LINE_H + LEDGER_GAP + LEDGER_H,
  );
  return { runs, spared, stop: { x: tx, y: sentenceTop, w: stopW }, lines, sentenceTop, height };
}

const shift = (win: Win, by: number): Win => [win[0] + by, win[1] + by];

function useWindowProgress(clock: SharedValue<number>, win: Win) {
  return useDerivedValue(() =>
    Math.min(1, Math.max(0, (clock.value - win[0]) / (win[1] - win[0]))),
  );
}

/* ------------------------------------------------------------------- pieces */

/** A redacted run: it writes with its line, and is gone once its bar covers it. */
function RunText({ run, clock }: { run: Run; clock: SharedValue<number> }) {
  const pal = usePalette();
  const write = shift(W_LINE, run.line * LINE_LAG);
  const covered = shift(W_BAR, run.order * BAR_LAG)[1];
  const progress = useDerivedValue(() => {
    const c = clock.value;
    if (c >= covered) {
      return 0; // under ink: nothing left to see when the bar wipes away
    }
    return Math.min(1, Math.max(0, (c - write[0]) / (write[1] - write[0])));
  });
  return (
    <View style={[styles.slot, { left: run.x, top: run.y, width: run.w + SLACK }]}>
      <WriteText
        text={run.text}
        charStyle={CLAUSE_STYLE}
        color={pal.muted}
        progress={progress}
        style={{ width: run.w + SLACK, height: CLAUSE_LINE_H }}
      />
    </View>
  );
}

/** The redaction bar over one run: grows left to right, later wipes away. */
function Bar({ run, clock, color }: { run: Run; clock: SharedValue<number>; color: string }) {
  const grow = shift(W_BAR, run.order * BAR_LAG);
  const wipe = shift(W_WIPE, run.order * WIPE_LAG);
  const x0 = run.x - BAR_PAD;
  const full = run.w + BAR_PAD * 2;
  const x = useDerivedValue(() => x0 + full * smootherstep(wipe[0], wipe[1], clock.value));
  const width = useDerivedValue(
    () => full * (smootherstep(grow[0], grow[1], clock.value) - smootherstep(wipe[0], wipe[1], clock.value)),
  );
  return (
    <Rect
      x={x}
      y={run.y + (CLAUSE_LINE_H - BAR_H) / 2}
      width={width}
      height={BAR_H}
      color={color}
    />
  );
}

/**
 * A spared phrase. Laid out at sentence size and shown at clause scale, so
 * it is crisp where it lands; it writes grey with its line, comes up to ink
 * while the pen works, then flies on an arc to its place in the sentence.
 */
function SparedText({ spared, index, clock }: {
  spared: Spared;
  index: number;
  clock: SharedValue<number>;
}) {
  const pal = usePalette();
  const write = useWindowProgress(clock, shift(W_LINE, spared.line * LINE_LAG));
  const flight = shift(W_FLIGHT, index * FLIGHT_LAG);
  const small = CLAUSE_SIZE / SENTENCE_SIZE;
  const { from, to, w } = spared;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const style = useAnimatedStyle(() => {
    const c = clock.value;
    const u = smootherstep(flight[0], flight[1], c);
    const lift = ARC_RATIO * dist * 4 * u * (1 - u);
    const ink = smootherstep(W_SPARED[0], W_SPARED[1], c);
    const k = small + (1 - small) * u;
    // The slot scales about its own centre, and its slack sits right of the
    // ink; shift by that slack at the current scale so the ink stays put.
    const cx = from.x + (to.x - from.x) * u + (SLACK * k) / 2;
    return {
      opacity: 0.55 + 0.45 * ink,
      transform: [
        { translateX: cx - (w + SLACK) / 2 },
        { translateY: from.y + (to.y - from.y) * u - lift - SENTENCE_LINE_H / 2 },
        { scale: k },
      ],
    };
  });
  return (
    <Animated.View style={[styles.slot, { width: w + SLACK }, style]}>
      <WriteText
        text={spared.text}
        charStyle={SENTENCE_STYLE}
        color={pal.ink}
        progress={write}
        style={{ width: w + SLACK, height: SENTENCE_LINE_H }}
      />
    </Animated.View>
  );
}

function Stage({ w, small, large, clock }: {
  w: number;
  small: SkFont;
  large: SkFont;
  clock: SharedValue<number>;
}) {
  const pal = usePalette();
  const layout = useMemo(() => layoutClause(w, small, large), [w, small, large]);
  const eyebrow = useDerivedValue(() => {
    const c = clock.value;
    const on = Math.min(1, Math.max(0, (c - W_EYEBROW[0]) / (W_EYEBROW[1] - W_EYEBROW[0])));
    const off = Math.min(1, Math.max(0, (c - W_EYEBROW_OUT[0]) / (W_EYEBROW_OUT[1] - W_EYEBROW_OUT[0])));
    return Math.min(on, 1 - off);
  });
  const stop = useWindowProgress(clock, W_STOP);
  const ledger = useWindowProgress(clock, W_LEDGER);

  return (
    <View
      style={[styles.stage, { width: w, height: layout.height }]}
      accessible
      accessibilityLabel="The usual terms: all rights in the songs you make remain with the company, and you are granted a revocable licence. Blacked out, it reads: all rights remain with you. No licence, no lockouts, no rules.">
      <View style={[styles.slot, { width: w }]}>
        <WriteText
          text={EYEBROW}
          charStyle={EYEBROW_STYLE}
          color={pal.muted}
          progress={eyebrow}
          style={{ width: w, height: EYEBROW_H }}
        />
      </View>
      {layout.runs.map(run => (
        <RunText key={run.order} run={run} clock={clock} />
      ))}
      <Canvas style={[StyleSheet.absoluteFill, { width: w, height: layout.height }]}>
        {layout.runs.map(run => (
          <Bar key={run.order} run={run} clock={clock} color={pal.ink} />
        ))}
      </Canvas>
      {layout.spared.map((spared, i) => (
        <SparedText key={spared.text} spared={spared} index={i} clock={clock} />
      ))}
      <View
        style={[
          styles.slot,
          { left: layout.stop.x, top: layout.sentenceTop, width: layout.stop.w + SLACK },
        ]}>
        <WriteText
          text="."
          charStyle={SENTENCE_STYLE}
          color={pal.ink}
          progress={stop}
          style={{ width: layout.stop.w + SLACK, height: SENTENCE_LINE_H }}
        />
      </View>
      <View
        style={[
          styles.slot,
          { top: layout.sentenceTop + SENTENCE_LINE_H + LEDGER_GAP, width: w },
        ]}>
        <WriteText
          text={LEDGER}
          charStyle={EYEBROW_STYLE}
          color={pal.muted}
          progress={ledger}
          style={{ width: w, height: LEDGER_H }}
        />
      </View>
    </View>
  );
}

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const w = width - space.lg * 2;
  const clock = useSharedValue(0);
  // The wrap needs real metrics; the bundled face streams in over Metro in
  // dev, so hold the clock until it has arrived (as the threshold does).
  const small = useMorphFont(CLAUSE_STYLE);
  const large = useMorphFont(SENTENCE_STYLE);
  const ready = small !== null && large !== null;

  useEffect(() => {
    if (reduced) {
      clock.value = 1;
      return;
    }
    if (!ready) {
      return;
    }
    clock.value = 0;
    clock.value = withDelay(
      STORY_DELAY_MS,
      withTiming(1, { duration: STORY_MS, easing: Easing.linear }),
    );
    return () => cancelAnimation(clock);
  }, [clock, ready, reduced]);

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <Text style={[type.small, styles.lede, { color: pal.muted }]}>
        Cantor composes full songs for you.
      </Text>
      {ready ? <Stage w={w} small={small} large={large} clock={clock} /> : null}
    </PanelBody>
  );
}

export const whatPanel: PanelDef = {
  key: 'what',
  eyebrow: 'What Cantor is',
  title: 'Music that’s only yours',
  sigil: SIGILS.what,
  Body,
};

const styles = StyleSheet.create({
  lede: { marginBottom: space.lg },
  stage: { position: 'relative' },
  slot: { position: 'absolute', left: 0, top: 0 },
});
