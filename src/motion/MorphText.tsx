/**
 * TransformMatchingShapes for text, on the intro's substrate: glyphs drawn on
 * one Skia canvas instead of a per-character forest of RN Text views. Layout
 * comes synchronously from font metrics (no onLayout roundtrip, no ghost
 * frames), a transition is three draw calls (exits / movers / enters), and the
 * only React commit per change is swapping the flight model in.
 *
 * Same motion grammar as everything else: one linear clock, smootherstep
 * windows, flights on gentle arcs, cascaded in reading order. Retargets
 * mid-flight capture the live positions and flow on from there.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Canvas, Glyphs, type SkFont } from '@shopify/react-native-skia';
import {
  cancelAnimation,
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { smootherstep } from './geometry';
import { useMorphFont } from './fonts';
import {
  buildFlights,
  ENTER_RISE,
  ENTER_START,
  EXIT_END,
  EXIT_RISE,
  layoutText,
  MOVE_END,
  MOVE_START,
  MOVER_DIP,
  type CharBox,
  type Flights,
} from './text';

type Glyph = { id: number; pos: { x: number; y: number } };

function toGlyphs(boxes: CharBox[], rise = 0): Glyph[] {
  const out: Glyph[] = [];
  for (const b of boxes) {
    for (let i = 0; i < b.ids.length; i++) {
      out.push({ id: b.ids[i], pos: { x: b.x + b.xo[i], y: b.y + rise } });
    }
  }
  return out;
}

/** Live glyph positions at clock value t — the JS mirror of the worklet math. */
function captureBoxes(f: Flights, t: number): CharBox[] {
  const boxes: CharBox[] = [];
  for (const m of f.movers) {
    const u = smootherstep(m.a, m.b, t);
    const arc = 4 * u * (1 - u);
    boxes.push({
      ...m.box,
      x: m.fx + (m.tx - m.fx) * u + m.px * arc,
      y: m.fy + (m.ty - m.fy) * u + m.py * arc,
    });
  }
  const exitA = 1 - smootherstep(0, EXIT_END, t);
  if (exitA > 0.25) {
    const rise = EXIT_RISE * smootherstep(0, EXIT_END, t);
    for (const b of f.exits) {
      boxes.push({ ...b, y: b.y - rise });
    }
  }
  const enterA = smootherstep(ENTER_START, 1, t);
  if (enterA > 0.25) {
    for (const b of f.enters) {
      boxes.push({ ...b, y: b.y + ENTER_RISE * (1 - enterA) });
    }
  }
  return boxes;
}

type Model = {
  text: string;
  width: number;
  font: SkFont;
  flights: Flights;
  exitGlyphs: Glyph[];
  enterGlyphs: Glyph[];
  animate: boolean;
  gen: number;
};

type Props = {
  text: string;
  charStyle: TextStyle;
  color: string;
  duration?: number;
  /** Outer container — reserve a fixed height here so the page never shifts. */
  style?: StyleProp<ViewStyle>;
  /** External clock (0..1) — the component stops driving its own. */
  progress?: SharedValue<number>;
};

export function MorphText({ text, charStyle, color, duration = 700, style, progress }: Props) {
  const clock = useSharedValue(1);
  const tt = progress ?? clock;
  const reduced = useReducedMotion();
  const font = useMorphFont(charStyle);
  const [width, setWidth] = useState(0);
  const [model, setModel] = useState<Model | null>(null);
  const genRef = useRef(0);

  if (font && width > 0 && (model?.text !== text || model.width !== width || model.font !== font)) {
    const lineHeight = charStyle.lineHeight ?? (charStyle.fontSize ?? 14) * 1.35;
    const next = layoutText(text, font, charStyle.letterSpacing ?? 0, width, lineHeight);
    // Same canvas and font → animate from the live glyph positions. A fresh
    // mount (or width/font change) just sits at the new layout.
    const retarget = model !== null && model.width === width && model.font === font;
    let flights: Flights;
    if (!retarget) {
      flights = { movers: [], exits: [], enters: next };
    } else if (reduced) {
      flights = { movers: [], exits: captureBoxes(model.flights, tt.value), enters: next };
    } else {
      flights = buildFlights(captureBoxes(model.flights, tt.value), next, width);
    }
    if (!progress) {
      // Render-phase write on purpose: the first committed frame must show the
      // captured state (t=0), not the finished target.
      clock.value = retarget ? 0 : 1;
    }
    genRef.current++;
    setModel({
      text,
      width,
      font,
      flights,
      exitGlyphs: toGlyphs(flights.exits),
      enterGlyphs: toGlyphs(flights.enters),
      animate: retarget,
      gen: genRef.current,
    });
  }

  useEffect(() => {
    if (!model?.animate || progress) {
      return;
    }
    cancelAnimation(clock);
    clock.value = 0;
    clock.value = withTiming(1, { duration, easing: Easing.linear });
  }, [model, progress, duration, clock]);

  const movers = model?.flights.movers ?? [];
  const moverGlyphs = useDerivedValue(() => {
    const out: Glyph[] = [];
    for (const m of movers) {
      const u = smootherstep(m.a, m.b, tt.value);
      const arc = 4 * u * (1 - u);
      const x = m.fx + (m.tx - m.fx) * u + m.px * arc;
      const y = m.fy + (m.ty - m.fy) * u + m.py * arc;
      for (let i = 0; i < m.ids.length; i++) {
        out.push({ id: m.ids[i], pos: { x: x + m.xo[i], y } });
      }
    }
    return out;
  }, [movers]);
  const moverAlpha = useDerivedValue(() => {
    const p = smootherstep(MOVE_START, MOVE_END, tt.value);
    return 1 - MOVER_DIP * 4 * p * (1 - p);
  });
  const exitAlpha = useDerivedValue(() => 1 - smootherstep(0, EXIT_END, tt.value));
  const exitShift = useDerivedValue(() => [
    { translateY: -EXIT_RISE * smootherstep(0, EXIT_END, tt.value) },
  ]);
  const enterAlpha = useDerivedValue(() => smootherstep(ENTER_START, 1, tt.value));
  const enterShift = useDerivedValue(() => [
    { translateY: ENTER_RISE * (1 - smootherstep(ENTER_START, 1, tt.value)) },
  ]);

  return (
    <View
      style={style}
      onLayout={e => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}>
      {model && font && (
        <Canvas style={StyleSheet.absoluteFill}>
          {model.exitGlyphs.length > 0 && (
            <Glyphs
              font={font}
              glyphs={model.exitGlyphs}
              transform={exitShift}
              color={color}
              opacity={exitAlpha}
            />
          )}
          {movers.length > 0 && (
            <Glyphs font={font} glyphs={moverGlyphs} color={color} opacity={moverAlpha} />
          )}
          {model.enterGlyphs.length > 0 && (
            <Glyphs
              font={font}
              glyphs={model.enterGlyphs}
              transform={enterShift}
              color={color}
              opacity={enterAlpha}
            />
          )}
        </Canvas>
      )}
    </View>
  );
}
