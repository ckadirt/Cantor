/**
 * Panel 2 — the phone is the permanent control centre; compute is a separate,
 * interchangeable role. The phone sits on the left with the Cantor set on its
 * screen; a fan of dashed links reaches out to a tidy column of the places
 * that role can live, each a single-weight line drawing with its label and
 * status on one row.
 *
 * The whole sentence is native Cantor motion: Skia paths trace in and labels
 * use WriteText, all reading from one linear clock through smootherstep windows.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import { Canvas, DashPathEffect, Path, Skia, type SkPath } from '@shopify/react-native-skia';
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
import { smootherstep, WriteText } from '../../motion';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { cantorSegments } from '../cantorBars';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

// ---- choreography ----------------------------------------------------------
// One linear clock. The phone draws first and the Cantor set grows on its
// screen; the links fan out one by one, each node forms as its link lands,
// its name writes, and its status surfaces last.
const DIAG_MS = 2400;
const DIAG_DELAY_MS = 250;
type Win = readonly [number, number];
const W_PHONE: Win = [0, 0.2];
const W_PHONE_DETAIL: Win = [0.14, 0.26];
const W_SET_START = 0.18; // first Cantor row; each deeper row follows
const W_SET_STEP = 0.05;
const W_CONTROL_LABEL: Win = [0.24, 0.44];
const W_CONTROL_TAG: Win = [0.38, 0.52];
const NODE_STEP = 0.065; // lag between consecutive nodes
const W_LINK: Win = [0.28, 0.46];
const W_ICON: Win = [0.4, 0.58];
const W_LABEL: Win = [0.48, 0.68];
const W_TAG: Win = [0.6, 0.72];
const W_CAPTION: Win = [0.82, 1];

const CAPTION =
  'Start and steer songs here. Choose the compute node that makes them.';

// ---- geometry knobs --------------------------------------------------------
const DIAG_H = 204;
const CAPTION_GAP = space.md;
const ROW_Y0 = 22; // first node row centre
const ROW_STEP = 40;
const PHONE = { cx: 42, w: 58, h: 108, r: 12 };
const PHONE_CY = ROW_Y0 + ROW_STEP * 2 - 6; // level with the middle row, lifted for its label
const LINK_GAP = 8; // clear air between a link and what it joins
const ICON_HALF_W = 16;
const ICON_COLUMN = 0.47; // icon centres, as a fraction of the width
const LABEL_INSET = 30; // icon centre → label start
const PHONE_STROKE = 1.6;
const ICON_STROKE = 1.4;
const LINK_STROKE = 1;
const DASH: number[] = [3, 4];
const LABEL_H = 15;
const TAG_H = 16;
const CHAR_W = 7.6; // mono advance at LABEL_STYLE, letter spacing included

const LABEL_STYLE: TextStyle = {
  ...type.eyebrow,
  fontSize: 10,
  letterSpacing: 1.6,
};

const labelWidth = (label: string) => Math.ceil(label.length * CHAR_W) + 4;

type NodeKey = 'pc' | 'gpu' | 'mac' | 'cloud' | 'phone';
type NodeDef = { key: NodeKey; label: string; ready: boolean };

// NOW first, SOON after, so the column reads top-down as "today, then next".
const NODES: readonly NodeDef[] = [
  { key: 'pc', label: 'PC', ready: true },
  { key: 'gpu', label: 'GPU', ready: true },
  { key: 'mac', label: 'MAC', ready: true },
  { key: 'cloud', label: 'CANTOR CLOUD', ready: false },
  { key: 'phone', label: 'ON PHONE', ready: false },
];

const CONTROL_LABEL = 'THIS PHONE';

type Tone = 'ink' | 'muted' | 'faint';
type Piece = {
  key: string;
  path: SkPath;
  win: Win;
  tone: Tone;
  width: number;
  dashed?: boolean;
  cap?: 'round' | 'butt';
};

type Row = NodeDef & {
  y: number;
  labelX: number;
  labelWin: Win;
  tagWin: Win;
};

type Diagram = { pieces: Piece[]; rows: Row[]; iconX: number };

const shift = (win: Win, by: number): Win => [
  Math.min(win[0] + by, 1),
  Math.min(win[1] + by, 1),
];

// ---- drawings --------------------------------------------------------------
// Every node is drawn in the same ~32×24 box at one stroke weight, so the
// column reads as a set rather than as five borrowed icons.

function roundedRect(path: SkPath, x: number, y: number, w: number, h: number, r: number) {
  path.addRRect(Skia.RRectXY(Skia.XYWHRect(x, y, w, h), r, r));
}

function line(path: SkPath, x1: number, y1: number, x2: number, y2: number) {
  path.moveTo(x1, y1);
  path.lineTo(x2, y2);
}

function monitorPath(x: number, y: number): SkPath {
  const p = Skia.Path.Make();
  roundedRect(p, x - 14, y - 11, 28, 17, 2);
  line(p, x, y + 6, x, y + 10);
  line(p, x - 7, y + 10, x + 7, y + 10);
  return p;
}

/** A graphics card: two fans on a board, its bracket and edge connector. */
function gpuPath(x: number, y: number): SkPath {
  const p = Skia.Path.Make();
  p.moveTo(x - 16, y - 11);
  p.lineTo(x - 13, y - 11);
  p.lineTo(x - 13, y + 11);
  roundedRect(p, x - 13, y - 8, 29, 14, 2);
  p.addCircle(x - 4, y - 1, 4);
  p.addCircle(x + 8, y - 1, 4);
  line(p, x - 6, y + 9, x + 10, y + 9);
  return p;
}

function laptopPath(x: number, y: number): SkPath {
  const p = Skia.Path.Make();
  roundedRect(p, x - 11, y - 11, 22, 15, 2);
  p.moveTo(x - 15, y + 7);
  p.lineTo(x + 15, y + 7);
  p.lineTo(x + 13, y + 10);
  p.lineTo(x - 13, y + 10);
  p.close();
  return p;
}

/** The same soft cumulus the first draft used, authored in a 128×72 box. */
function cloudPath(x: number, y: number): SkPath {
  const p = Skia.Path.MakeFromSVGString(
    'M 24 64 L 104 64 ' +
      'C 118 64 126 54 122 44 ' +
      'C 130 36 122 24 110 26 ' +
      'C 108 12 90 6 78 14 ' +
      'C 70 2 50 2 44 14 ' +
      'C 32 8 20 14 22 26 ' +
      'C 10 28 6 40 14 48 ' +
      'C 16 58 20 64 24 64 Z',
  )!;
  const s = 0.24;
  const m = Skia.Matrix();
  m.translate(x - 64 * s, y - 38 * s);
  m.scale(s, s);
  p.transform(m);
  return p;
}

function handsetPath(x: number, y: number): SkPath {
  const p = Skia.Path.Make();
  roundedRect(p, x - 7.5, y - 12, 15, 24, 3);
  line(p, x - 2.5, y + 8, x + 2.5, y + 8);
  return p;
}

const ICONS: Record<NodeKey, (x: number, y: number) => SkPath> = {
  pc: monitorPath,
  gpu: gpuPath,
  mac: laptopPath,
  cloud: cloudPath,
  phone: handsetPath,
};

function buildDiagram(w: number): Diagram {
  const { cx, w: pw, h: ph, r } = PHONE;
  const cy = PHONE_CY;
  const top = cy - ph / 2;
  const bottom = cy + ph / 2;
  const iconX = Math.round(w * ICON_COLUMN);

  const body = Skia.Path.Make();
  roundedRect(body, cx - pw / 2, top, pw, ph, r);
  const detail = Skia.Path.Make();
  line(detail, cx - 6, top + 9, cx + 6, top + 9);
  line(detail, cx - 8, bottom - 10, cx + 8, bottom - 10);

  const pieces: Piece[] = [
    { key: 'phone', path: body, win: W_PHONE, tone: 'ink', width: PHONE_STROKE },
    { key: 'phone-detail', path: detail, win: W_PHONE_DETAIL, tone: 'ink', width: PHONE_STROKE },
  ];

  // The Cantor set on the phone's screen, one row per depth, each tracing in
  // after the one above it: the app's own mark as the thing being steered.
  const setW = pw - 16;
  const setX = cx - setW / 2;
  for (let depth = 0; depth < 4; depth += 1) {
    const rowY = cy - 18 + depth * 10;
    const set = Skia.Path.Make();
    for (const [sx, sw] of cantorSegments(depth)) {
      line(set, setX + sx * setW, rowY, setX + (sx + sw) * setW, rowY);
    }
    const start = W_SET_START + depth * W_SET_STEP;
    pieces.push({
      key: `set-${depth}`,
      path: set,
      win: [start, start + 0.12],
      tone: 'ink',
      width: 3,
      cap: 'butt',
    });
  }

  const rows: Row[] = NODES.map((node, i) => {
    const y = ROW_Y0 + i * ROW_STEP;
    const lag = i * NODE_STEP;

    // Links leave the phone's edge slightly spread, like fibres from a
    // bundle, and arrive level with their node.
    const x1 = cx + pw / 2 + LINK_GAP;
    const y1 = cy + (y - cy) * 0.22;
    const x2 = iconX - ICON_HALF_W - LINK_GAP;
    const mid = (x1 + x2) / 2;
    const link = Skia.Path.Make();
    link.moveTo(x1, y1);
    link.cubicTo(mid, y1, mid, y, x2, y);

    pieces.push(
      {
        key: `link-${node.key}`,
        path: link,
        win: shift(W_LINK, lag),
        tone: node.ready ? 'muted' : 'faint',
        width: LINK_STROKE,
        dashed: true,
      },
      {
        key: `icon-${node.key}`,
        path: ICONS[node.key](iconX, y),
        win: shift(W_ICON, lag),
        tone: node.ready ? 'ink' : 'muted',
        width: ICON_STROKE,
      },
    );

    return {
      ...node,
      y,
      labelX: iconX + LABEL_INSET,
      labelWin: shift(W_LABEL, lag),
      tagWin: shift(W_TAG, lag),
    };
  });

  return { pieces, rows, iconX };
}

// ---- pieces ----------------------------------------------------------------

/** One stroke that traces itself in over its window (the Create gesture). */
function Trace({ piece, clock, color }: { piece: Piece; clock: SharedValue<number>; color: string }) {
  const end = useDerivedValue(() => smootherstep(piece.win[0], piece.win[1], clock.value));
  return (
    <Path
      path={piece.path}
      style="stroke"
      strokeWidth={piece.width}
      strokeCap={piece.cap ?? 'round'}
      strokeJoin="round"
      color={color}
      start={0}
      end={end}>
      {piece.dashed ? <DashPathEffect intervals={DASH} /> : null}
    </Path>
  );
}

/** The square status tag — ink when it works today, a whisper when it's next. */
function Tag({ label, strong, clock, win }: {
  label: string;
  strong: boolean;
  clock: SharedValue<number>;
  win: Win;
}) {
  const pal = usePalette();
  const style = useAnimatedStyle(() => ({
    opacity: smootherstep(win[0], win[1], clock.value),
  }));
  const tone = strong ? pal.ink : pal.faint;
  return (
    <Animated.View style={[styles.tag, { borderColor: tone }, style]}>
      <Text style={[styles.tagText, { color: tone }]}>{label}</Text>
    </Animated.View>
  );
}

function useWindowClock(clock: SharedValue<number>, win: Win) {
  return useDerivedValue(() =>
    Math.min(1, Math.max(0, (clock.value - win[0]) / (win[1] - win[0]))),
  );
}

function NodeRow({ row, right, clock }: { row: Row; right: number; clock: SharedValue<number> }) {
  const pal = usePalette();
  const progress = useWindowClock(clock, row.labelWin);
  const labelW = labelWidth(row.label);
  return (
    <View
      style={[
        styles.row,
        { left: row.labelX, top: row.y - TAG_H / 2, width: right - row.labelX },
      ]}>
      <WriteText
        text={row.label}
        charStyle={LABEL_STYLE}
        color={row.ready ? pal.ink : pal.muted}
        progress={progress}
        style={{ width: labelW, height: LABEL_H }}
      />
      <Tag
        label={row.ready ? 'NOW' : 'SOON'}
        strong={row.ready}
        clock={clock}
        win={row.tagWin}
      />
    </View>
  );
}

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const w = width - space.lg * 2;
  const clock = useSharedValue(0);
  const diagram = useMemo(() => buildDiagram(w), [w]);

  useEffect(() => {
    if (reduced) {
      clock.value = 1;
      return;
    }
    clock.value = withDelay(
      DIAG_DELAY_MS,
      withTiming(1, { duration: DIAG_MS, easing: Easing.linear }),
    );
    return () => cancelAnimation(clock);
  }, [clock, reduced]);

  const controlProgress = useWindowClock(clock, W_CONTROL_LABEL);
  const captionStyle = useAnimatedStyle(() => ({
    opacity: smootherstep(W_CAPTION[0], W_CAPTION[1], clock.value),
  }));
  const tones = { ink: pal.ink, muted: pal.muted, faint: pal.faint };
  const controlW = labelWidth(CONTROL_LABEL);

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <View
        style={styles.stage}
        accessible
        accessibilityLabel="This phone controls Cantor. PC, GPU, and Mac compute now. Cantor cloud and on-phone compute are coming soon.">
        <Canvas style={{ width: w, height: DIAG_H }}>
          {diagram.pieces.map(piece => (
            <Trace key={piece.key} piece={piece} clock={clock} color={tones[piece.tone]} />
          ))}
        </Canvas>
        <View
          style={[
            styles.control,
            {
              left: PHONE.cx - controlW / 2,
              top: PHONE_CY + PHONE.h / 2 + space.sm,
              width: controlW,
            },
          ]}>
          <WriteText
            text={CONTROL_LABEL}
            charStyle={LABEL_STYLE}
            color={pal.ink}
            progress={controlProgress}
            style={{ width: controlW, height: LABEL_H }}
          />
          <Tag label="CONTROL" strong clock={clock} win={W_CONTROL_TAG} />
        </View>
        {diagram.rows.map(row => (
          <NodeRow key={row.key} row={row} right={w - 2} clock={clock} />
        ))}
      </View>
      <Animated.View style={captionStyle}>
        <Text style={[type.small, styles.caption, { color: pal.muted }]}>{CAPTION}</Text>
      </Animated.View>
    </PanelBody>
  );
}

export const backendsPanel: PanelDef = {
  key: 'backends',
  eyebrow: 'Where songs are made',
  title: 'You choose where the work happens',
  sigil: SIGILS.backends,
  Body,
};

const styles = StyleSheet.create({
  stage: { marginTop: space.sm, height: DIAG_H },
  control: { position: 'absolute', alignItems: 'center', gap: 4 },
  row: {
    position: 'absolute',
    height: TAG_H,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tag: {
    height: TAG_H,
    borderWidth: 1,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    fontFamily: type.mono.fontFamily,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  caption: { marginTop: CAPTION_GAP },
});
