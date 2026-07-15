/**
 * Panel 2 — where the work happens. Instead of prose rows, a live diagram:
 * this phone, connected peer-to-peer to your PC and to Cantor's cloud. The
 * drawing traces itself in (the app's Create gesture — path trim on thin
 * strokes), the labels use the same Write gesture as everything else, and
 * the whole choreography rides one linear clock with smootherstep windows.
 * Only on-device runs today; PC and cloud carry honest "soon" tags.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View, type TextStyle } from 'react-native';
import {
  Canvas,
  DashPathEffect,
  Path,
  Skia,
  type SkPath,
} from '@shopify/react-native-skia';
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
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

// ---- choreography ----------------------------------------------------------
// One linear clock; every element owns a smootherstep window on it. The phone
// draws first, links reach out, the peers form as the links arrive, labels
// write themselves, and the status tags surface last.
const DIAG_MS = 2100;
const DIAG_DELAY_MS = 250; // let the body finish rising before ink appears
type Win = readonly [number, number];
const W_PHONE: Win = [0, 0.2];
const W_PHONE_HOME: Win = [0.16, 0.24];
const W_LINK_PC: Win = [0.2, 0.4];
const W_PC_SCREEN: Win = [0.36, 0.56];
const W_PC_BASE: Win = [0.52, 0.6];
const W_LINK_CLOUD: Win = [0.3, 0.5];
const W_CLOUD: Win = [0.46, 0.7];
const W_LABEL_PHONE: Win = [0.22, 0.5];
const W_LABEL_PC: Win = [0.56, 0.82];
const W_LABEL_CLOUD: Win = [0.64, 0.9];
const W_TAG_NOW: Win = [0.5, 0.66];
const W_TAG_PC: Win = [0.8, 0.94];
const W_TAG_CLOUD: Win = [0.86, 1];
const W_CAPTION: Win = [0.78, 0.98];

/** One quiet line under the drawing; the diagram carries the argument. */
const CAPTION =
  'Only the engine changes — the songs stay yours. ' +
  'This phone works today; PC and cloud pair up soon.';

// ---- geometry --------------------------------------------------------------
const DIAG_H = 212; // canvas height, dp; label rows live inside it
const STROKE = 1.8; // device outlines
const LINK_STROKE = 1.4;
const DASH: number[] = [7, 6];
const LABEL_H = 16;

const LABEL_STYLE: TextStyle = { ...type.eyebrow, textAlign: 'center' };

// Label + tag sit side by side under each device (like the sketch). Mono
// metrics are uniform, so fixed widths are exact: 11pt ≈ 6.6/char + 2 spacing.
const STATION_META = [
  { label: 'THIS DEVICE', labelW: 104, tag: 'NOW', tagW: 40, strong: true },
  { label: 'YOUR PC', labelW: 70, tag: 'SOON', tagW: 48, strong: false },
  { label: 'CANTOR’S CLOUD', labelW: 130, tag: 'SOON', tagW: 48, strong: false },
] as const;
const ROW_GAP = 8;

type Piece = {
  key: string;
  path: SkPath;
  win: Win;
  tone: 'ink' | 'muted' | 'faint';
  width: number;
  dashed?: boolean;
};

type Station = { x: number; labelY: number };

function buildDiagram(w: number): { pieces: Piece[]; stations: Station[] } {
  // Anchors — fractions of the canvas, phone left of centre, peers stacked
  // on the right like the corners of a small constellation.
  const phone = { cx: w * 0.23, cy: DIAG_H * 0.44, w: 60, h: 116, r: 14 };
  const pc = { cx: w * 0.74, cy: DIAG_H * 0.19, w: 92, h: 58, r: 6 };
  const cloudScale = 0.82; // of the authored 128×72 box
  const cloud = {
    cx: w * 0.73,
    cy: DIAG_H * 0.66,
    hw: 64 * cloudScale,
    hh: 36 * cloudScale,
  };

  const phoneBody = Skia.Path.Make();
  phoneBody.addRRect(
    Skia.RRectXY(
      Skia.XYWHRect(phone.cx - phone.w / 2, phone.cy - phone.h / 2, phone.w, phone.h),
      phone.r,
      phone.r,
    ),
  );
  const phoneHome = Skia.Path.Make();
  phoneHome.moveTo(phone.cx - 8, phone.cy + phone.h / 2 - 12);
  phoneHome.lineTo(phone.cx + 8, phone.cy + phone.h / 2 - 12);

  const pcScreen = Skia.Path.Make();
  pcScreen.addRRect(
    Skia.RRectXY(
      Skia.XYWHRect(pc.cx - pc.w / 2, pc.cy - pc.h / 2, pc.w, pc.h),
      pc.r,
      pc.r,
    ),
  );
  const pcBase = Skia.Path.Make();
  pcBase.moveTo(pc.cx - pc.w / 2 - 12, pc.cy + pc.h / 2 + 5);
  pcBase.lineTo(pc.cx + pc.w / 2 + 12, pc.cy + pc.h / 2 + 5);

  // A soft cumulus authored in a 128×72 box, then scaled and moved into place.
  const cloudPath = Skia.Path.MakeFromSVGString(
    'M 24 64 L 104 64 ' +
      'C 118 64 126 54 122 44 ' +
      'C 130 36 122 24 110 26 ' +
      'C 108 12 90 6 78 14 ' +
      'C 70 2 50 2 44 14 ' +
      'C 32 8 20 14 22 26 ' +
      'C 10 28 6 40 14 48 ' +
      'C 16 58 20 64 24 64 Z',
  )!;
  const m = Skia.Matrix();
  m.translate(cloud.cx - cloud.hw, cloud.cy - cloud.hh);
  m.scale(cloudScale, cloudScale);
  cloudPath.transform(m);

  // Peer-to-peer links, leaving from the phone's right edge.
  const linkPc = Skia.Path.Make();
  linkPc.moveTo(phone.cx + phone.w / 2 + 10, phone.cy - 22);
  linkPc.lineTo(pc.cx - pc.w / 2 - 20, pc.cy + 8);
  const linkCloud = Skia.Path.Make();
  linkCloud.moveTo(phone.cx + phone.w / 2 + 10, phone.cy + 22);
  linkCloud.lineTo(cloud.cx - cloud.hw - 10, cloud.cy + 4);

  return {
    pieces: [
      { key: 'phone', path: phoneBody, win: W_PHONE, tone: 'ink', width: STROKE },
      { key: 'home', path: phoneHome, win: W_PHONE_HOME, tone: 'ink', width: STROKE },
      { key: 'link-pc', path: linkPc, win: W_LINK_PC, tone: 'faint', width: LINK_STROKE, dashed: true },
      { key: 'pc-screen', path: pcScreen, win: W_PC_SCREEN, tone: 'muted', width: STROKE },
      { key: 'pc-base', path: pcBase, win: W_PC_BASE, tone: 'muted', width: STROKE },
      { key: 'link-cloud', path: linkCloud, win: W_LINK_CLOUD, tone: 'faint', width: LINK_STROKE, dashed: true },
      { key: 'cloud', path: cloudPath, win: W_CLOUD, tone: 'muted', width: STROKE },
    ],
    stations: [
      { x: phone.cx, labelY: phone.cy + phone.h / 2 + 12 },
      { x: pc.cx, labelY: pc.cy + pc.h / 2 + 5 + 12 },
      { x: cloud.cx, labelY: cloud.cy + cloud.hh + 12 },
    ],
  };
}

// ---- pieces ----------------------------------------------------------------

/** One stroke that traces itself in over its window (the Create gesture). */
function Trace({
  piece,
  clock,
  color,
}: {
  piece: Piece;
  clock: SharedValue<number>;
  color: string;
}) {
  const end = useDerivedValue(() =>
    smootherstep(piece.win[0], piece.win[1], clock.value),
  );
  return (
    <Path
      path={piece.path}
      style="stroke"
      strokeWidth={piece.width}
      strokeCap="round"
      strokeJoin="round"
      color={color}
      start={0}
      end={end}
    >
      {piece.dashed ? <DashPathEffect intervals={DASH} /> : null}
    </Path>
  );
}

/** The square status tag — NOW in ink, SOON in a whisper. */
function Tag({
  label,
  strong,
  clock,
  win,
}: {
  label: string;
  strong?: boolean;
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

  // The labels ride the same clock through their own linear windows.
  const phoneLabelT = useDerivedValue(() =>
    Math.min(1, Math.max(0, (clock.value - W_LABEL_PHONE[0]) / (W_LABEL_PHONE[1] - W_LABEL_PHONE[0]))),
  );
  const pcLabelT = useDerivedValue(() =>
    Math.min(1, Math.max(0, (clock.value - W_LABEL_PC[0]) / (W_LABEL_PC[1] - W_LABEL_PC[0]))),
  );
  const cloudLabelT = useDerivedValue(() =>
    Math.min(1, Math.max(0, (clock.value - W_LABEL_CLOUD[0]) / (W_LABEL_CLOUD[1] - W_LABEL_CLOUD[0]))),
  );

  const tone = { ink: pal.ink, muted: pal.muted, faint: pal.faint };
  const [phoneSt, pcSt, cloudSt] = diagram.stations;
  const captionStyle = useAnimatedStyle(() => ({
    opacity: smootherstep(W_CAPTION[0], W_CAPTION[1], clock.value),
  }));

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <View
        style={styles.stage}
        accessible
        accessibilityLabel="Diagram: this device makes songs now; your PC and Cantor's cloud connect soon."
      >
        <Canvas style={{ width: w, height: DIAG_H }}>
          {diagram.pieces.map(piece => (
            <Trace key={piece.key} piece={piece} clock={clock} color={tone[piece.tone]} />
          ))}
        </Canvas>

        {(
          [
            { st: phoneSt, t: phoneLabelT, win: W_TAG_NOW, ink: pal.ink },
            { st: pcSt, t: pcLabelT, win: W_TAG_PC, ink: pal.muted },
            { st: cloudSt, t: cloudLabelT, win: W_TAG_CLOUD, ink: pal.muted },
          ] as const
        ).map(({ st, t, win }, i) => {
          const meta = STATION_META[i];
          const rowW = meta.labelW + ROW_GAP + meta.tagW;
          return (
            <View
              key={meta.label}
              style={[styles.station, { left: st.x - rowW / 2, top: st.labelY }]}
            >
              <WriteText
                text={meta.label}
                charStyle={LABEL_STYLE}
                color={meta.strong ? pal.ink : pal.muted}
                progress={t}
                style={{ width: meta.labelW, height: LABEL_H }}
              />
              <Tag label={meta.tag} strong={meta.strong} clock={clock} win={win} />
            </View>
          );
        })}
      </View>

      <Animated.View style={captionStyle}>
        <Text style={[type.small, styles.caption, { color: pal.muted }]}>
          {CAPTION}
        </Text>
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
  stage: {
    marginTop: space.sm,
    height: DIAG_H + 2, // label rows live inside the canvas bounds
  },
  station: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  tag: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagText: {
    fontFamily: type.mono.fontFamily,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  caption: {
    marginTop: space.sm,
  },
});
