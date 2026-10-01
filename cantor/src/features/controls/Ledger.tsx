import React, { useContext } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  ARRIVAL_KNOBS,
  StaveHeight,
  useArrivalClock,
  windowed,
} from './Arrival';
import { Caret } from './Caret';
import { PanelPressable } from './PanelPressable';
import { Underway, useReach } from './state';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — the one axis every panel is drawn on.
 *
 * These are measured from the *ledger's own* left edge, not the phone's. The
 * curtain already inset its content by `space.lg`, so a panel that added the
 * page margin again would push its spine 24 px to the right of every other
 * panel's. Everything here is therefore 24 less than the number in
 * `docs/interfacealpha/ledger.html`, which is drawn in frame coordinates.
 */
export const LEDGER_KNOBS = {
  /**
   * The label column: right-aligned mono at 10 px, about fourteen characters.
   *
   * `Placements` and `Diagnostics` are the longest labels in the app and both
   * fit. A right-aligned column punishes long words, which is the pressure
   * that turned `WHERE IT RUNS` into `Engine` — and the reason this variant
   * was chosen over the three that tolerate a grey band of a label.
   */
  LABEL_PX: 96,
  /** Between the label column and the value column; the spine lives in here. */
  GUTTER_PX: space.lg,
  /**
   * Where the hairline stands: 10 px past the end of the labels.
   *
   * Not centred in the gutter. Nearer the label than the value, so the labels
   * read as hanging from the spine rather than as pushing it away — at the
   * centre it became a divider between two columns, which is a different
   * drawing.
   */
  SPINE_PX: 96 + 10,
  /** 22 px of line in 9 above and 9 below: a 40 px row. */
  ROW_PAD_PX: 9,
  LINE_PX: 22,
  /**
   * A Folio rest: the only separator. The spine is actually broken between
   * two measures, and that break *is* the heading, which is why nothing in any
   * panel is ever titled. Half a 48 dp control, so the rhythm falls on 8.
   */
  REST_PX: 24,
  /** Each fact's mark on the spine, where its label ends. */
  TICK_PX: 4,
  LABEL_SIZE_PX: 10,
  LABEL_TRACKING: 1.4,
  /**
   * The longest label the column holds on one line, in mono characters at
   * `LABEL_SIZE_PX` and `LABEL_TRACKING` (about 7.4 px each in 96 px).
   * Labels never wrap: a longer one moves into the value column, in full, and
   * the label column stays empty.
   */
  LABEL_MAX_CHARS: 12,
  /**
   * The most words a note may have and still be set in spaced mono capitals.
   * Mono is for states and counts; anything longer, or anything that ends as
   * a sentence does, is set in Spectral 13 instead.
   */
  STATE_MAX_WORDS: 4,
  /** Full target height; scroll containers clip hitSlop outside their bounds. */
  DIAL_ITEM_PX: touch.min,
} as const;

/** Where the value column begins, for anything that has to line up with it. */
export const LEDGER_VALUE_PX = LEDGER_KNOBS.LABEL_PX + LEDGER_KNOBS.GUTTER_PX;

/**
 * The quiet mono line under a value, as a plain style object.
 *
 * Hoisted out of the stylesheet because a note that *morphs* rather than being
 * replaced has to hand its exact metrics to the motion engine, and the engine
 * reads `fontFamily` and `fontSize` off the object it is given — a registered
 * style would arrive as an id. One definition either way: `styles.note` spreads
 * this, so a note drawn as glyphs and a note drawn as text cannot drift.
 */
export const LEDGER_NOTE_STYLE = {
  fontFamily: font.mono,
  fontSize: LEDGER_KNOBS.LABEL_SIZE_PX,
  letterSpacing: 1.2,
  lineHeight: 16,
} as const;

/**
 * The spine, and everything hanging from it.
 *
 * One hairline at a fixed measure with every label ending against it and every
 * value beginning after it. Two panels drawn on one axis look like one
 * instrument; that is the entire argument for this component existing rather
 * than each sheet laying its own rows out.
 */
export function Ledger({
  arrival,
  children,
  style,
}: {
  /**
   * 0 to 1 as the panel arrives, for a spine that draws down rather than
   * appearing whole.
   *
   * Optional because most panels are pulled: a blind uncovers its own spine as
   * it unrolls, so there is nothing to draw. A panel that is *tapped* open
   * arrives all at once, and the axis existing before the facts land on it is
   * what makes that read as a sentence rather than a cut.
   */
  arrival?: SharedValue<number>;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const pal = usePalette();
  const clock = useArrivalClock();
  const staveHeight = useContext(StaveHeight);
  // Where this measure stands in the stave decides when its spine grows: the
  // line is drawn top to bottom, measure by measure, timed by position.
  const top = useSharedValue(0);
  const height = useSharedValue(0);
  const from = useDerivedValue(() => {
    const visible = staveHeight?.value ?? 0;
    const at = visible > 0 ? Math.min(top.value / visible, 1) : 0;
    return (
      ARRIVAL_KNOBS.SPINE_FROM +
      at * (ARRIVAL_KNOBS.SPINE_TO - ARRIVAL_KNOBS.SPINE_FROM)
    );
  });
  const to = useDerivedValue(() => {
    const visible = staveHeight?.value ?? 0;
    const at =
      visible > 0 ? Math.min((top.value + height.value) / visible, 1) : 1;
    return (
      ARRIVAL_KNOBS.SPINE_FROM +
      at * (ARRIVAL_KNOBS.SPINE_TO - ARRIVAL_KNOBS.SPINE_FROM)
    );
  });
  const reducedMotion = useReducedMotion();
  const landed = useAnimatedStyle(() => {
    if (arrival !== undefined) return {};
    const local = windowed(
      clock.value,
      from.value,
      from.value + ARRIVAL_KNOBS.FACT_SPAN,
    );
    return reducedMotion
      ? { opacity: local }
      : {
          opacity: local,
          transform: [{ translateY: (1 - local) * ARRIVAL_KNOBS.FACT_RISE_PX }],
        };
  });
  const grown = useDerivedValue(() =>
    arrival !== undefined
      ? arrival.value
      : windowed(clock.value, from.value, to.value),
  );
  return (
    <View
      onLayout={event => {
        top.value = event.nativeEvent.layout.y;
        height.value = event.nativeEvent.layout.height;
      }}
      style={[styles.ledger, style]}
    >
      <Spine arrival={grown} colour={pal.spine} />
      {/*
        The facts land as the spine reaches them — as one block per measure,
        not a mapper per row: a row each cost frames on the phone (F10 notes).
      */}
      <Animated.View style={landed}>{children}</Animated.View>
    </View>
  );
}

/** The hairline, drawn from the top down when a panel arrives on a tap. */
function Spine({
  arrival,
  colour,
}: {
  arrival: SharedValue<number> | undefined;
  colour: string;
}) {
  const drawn = useAnimatedStyle(() =>
    arrival === undefined ? {} : { transform: [{ scaleY: arrival.value }] },
  );
  return (
    <Animated.View
      // Decorative: the structure it draws is already carried by the labels.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.spine, { backgroundColor: colour }, drawn]}
    />
  );
}

/**
 * One fact: its name against the spine, the fact itself after it.
 *
 * `label` is omitted rather than emptied for an action, because an action takes
 * no label — it sits in the value column where every other answer has been, and
 * the column beside it carries a consequence when there is one, which is how
 * `9 KEPT` comes to sit next to forgetting an engine.
 */
export function Row({
  children,
  label,
  mark,
  note,
  control = false,
}: {
  children: React.ReactNode;
  label?: string;
  /**
   * A drawing in the label column instead of a word — a node's mark in the
   * roster — right-aligned against the spine as a label would be.
   */
  mark?: React.ReactNode;
  /** Align labels with text inside a 48 dp control without adding row padding twice. */
  control?: boolean;
  /** The line under a value: a state in mono, or a sentence in Spectral. */
  note?: string;
}) {
  const pal = usePalette();
  const named = (label !== undefined && label !== '') || mark !== undefined;
  // A label never wraps. One too long for the column moves into the value
  // column in full, and the label column is left empty rather than cut.
  const fits =
    label !== undefined && label.length <= LEDGER_KNOBS.LABEL_MAX_CHARS;
  return (
    <View style={[styles.row, control && styles.controlRow]}>
      {named ? (
        // The fact's mark on the ruler the spine is: level with the middle of
        // the label's first line.
        <View
          pointerEvents="none"
          style={[
            styles.tick,
            control && styles.controlTick,
            { backgroundColor: pal.spine },
          ]}
        />
      ) : null}
      {mark !== undefined ? (
        <View style={styles.mark}>{mark}</View>
      ) : (
        <Text
          numberOfLines={1}
          style={[
            styles.label,
            control && styles.controlLabel,
            { color: pal.faint },
          ]}
        >
          {fits ? label.toUpperCase() : ''}
        </Text>
      )}
      <View style={styles.value}>
        {label !== undefined && label !== '' && !fits ? (
          <Text style={[styles.movedLabel, { color: pal.faint }]}>
            {label.toUpperCase()}
          </Text>
        ) : null}
        {children}
        {note === undefined ? null : isState(note) ? (
          <Text style={[styles.note, { color: pal.faint }]}>
            {note.toUpperCase()}
          </Text>
        ) : (
          <Text style={[type.small, styles.sentence, { color: pal.muted }]}>
            {note}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Whether a note is a state (`3 KEPT`, `THIS WILL BE INSTRUMENTAL`) rather
 * than a sentence (`Choose where it runs first.`): four words at most — a
 * number is a count, not a word — and not punctuated as a sentence.
 */
export function isState(note: string): boolean {
  // Numbers are counts, not words: `10 KEPT HERE · 8 CACHED` is a state.
  const words = note
    .trim()
    .split(/\s+/)
    .filter(word => /\p{L}/u.test(word));
  return (
    words.length <= LEDGER_KNOBS.STATE_MAX_WORDS && !/[.!?…]$/.test(note.trim())
  );
}

/**
 * A door: the same ink as a fact, with the hairline caret at the value
 * column's right edge. It moves you somewhere and changes nothing.
 */
export function Door({
  accessibilityLabel,
  label,
  name = false,
  onPress,
  quiet = false,
}: {
  accessibilityLabel?: string;
  label: string;
  /** A name rather than a word: the display face at 20, as the roster sets it. */
  name?: boolean;
  onPress: () => void;
  /** Out of reach for now (an offline node): the door still opens, in faint. */
  quiet?: boolean;
}) {
  const pal = usePalette();
  return (
    <PanelPressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.door}
    >
      <Text
        numberOfLines={1}
        style={[
          name ? styles.doorName : type.body,
          styles.doorWord,
          { color: quiet ? pal.faint : pal.ink },
        ]}
      >
        {label}
      </Text>
      <View style={styles.caretSeat}>
        <Caret colour={quiet ? pal.faint : pal.ink} direction="right" />
      </View>
    </PanelPressable>
  );
}

/**
 * An act on the stave: it changes something, so it is set in muted ink. Ink
 * belongs to the one act at the coda, in the display face.
 *
 * `working` keeps the ink and grows the rule under the word; `disabled`
 * settles it to faint. A working act is refused by having nothing to call, not
 * by `disabled`, which a screen reader would announce as "busy, disabled".
 */
export function RowAct({
  accessibilityLabel,
  disabled = false,
  label,
  onPress,
  working = false,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  working?: boolean;
}) {
  const pal = usePalette();
  const { tint } = useReach(disabled, { from: pal.muted });
  return (
    <PanelPressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: working }}
      disabled={disabled}
      onPress={working ? undefined : onPress}
    >
      <View>
        <Animated.Text style={[type.body, tint]}>{label}</Animated.Text>
        <Underway charStyle={type.body} label={label} working={working} />
      </View>
    </PanelPressable>
  );
}

/**
 * A Folio measure: one group of facts, with the spine drawn once for it.
 *
 * The same object as `Ledger`; the name is the one `folio.html` uses, where a
 * page is a stave and its sections are measures separated by `Rest`s.
 */
export const Measure = Ledger;

/**
 * The gap between two measures. The spine stops here and starts again, so a
 * page with three sections shows three bars at a glance and needs no headings.
 */
export function Rest() {
  return <View style={styles.rest} />;
}

const styles = StyleSheet.create({
  ledger: { position: 'relative' },
  spine: {
    bottom: 0,
    left: LEDGER_KNOBS.SPINE_PX,
    position: 'absolute',
    top: 0,
    transformOrigin: 'top',
    width: StyleSheet.hairlineWidth,
  },
  row: {
    columnGap: LEDGER_KNOBS.GUTTER_PX,
    flexDirection: 'row',
    paddingVertical: LEDGER_KNOBS.ROW_PAD_PX,
  },
  controlRow: { paddingVertical: 0 },
  controlLabel: { paddingTop: (touch.min - LEDGER_KNOBS.LINE_PX) / 2 },
  label: {
    fontFamily: font.mono,
    fontSize: LEDGER_KNOBS.LABEL_SIZE_PX,
    letterSpacing: LEDGER_KNOBS.LABEL_TRACKING,
    lineHeight: LEDGER_KNOBS.LINE_PX,
    textAlign: 'right',
    includeFontPadding: false,
    width: LEDGER_KNOBS.LABEL_PX,
  },
  value: { flex: 1, minWidth: 0 },
  note: { ...LEDGER_NOTE_STYLE, marginTop: 3 },
  sentence: { marginTop: 3 },
  movedLabel: { ...LEDGER_NOTE_STYLE, lineHeight: LEDGER_KNOBS.LINE_PX },
  door: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.md,
    justifyContent: 'space-between',
  },
  doorWord: { flexShrink: 1 },
  doorName: { fontFamily: font.display, fontSize: 20, lineHeight: 24 },
  mark: {
    alignItems: 'flex-end',
    paddingTop: LEDGER_KNOBS.ROW_PAD_PX,
    width: LEDGER_KNOBS.LABEL_PX,
  },
  /** The caret's rotated square needs its own box to turn in. */
  caretSeat: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'center',
    marginRight: space.xs,
    width: 18,
  },
  rest: { height: LEDGER_KNOBS.REST_PX },
  tick: {
    height: StyleSheet.hairlineWidth,
    left: LEDGER_KNOBS.SPINE_PX - LEDGER_KNOBS.TICK_PX,
    position: 'absolute',
    top: LEDGER_KNOBS.ROW_PAD_PX + LEDGER_KNOBS.LINE_PX / 2,
    width: LEDGER_KNOBS.TICK_PX,
  },
  controlTick: { top: touch.min / 2 },
  /** The seat a dial takes inside a row, sized by `DIAL_ITEM_PX`. */
  dialItem: {
    justifyContent: 'center',
    minHeight: LEDGER_KNOBS.DIAL_ITEM_PX,
  },
  /**
   * The seat a *stated* value takes, so a step that resolved itself does not
   * sit tighter to its label than the step below it that did not.
   */
  stated: { justifyContent: 'center', minHeight: LEDGER_KNOBS.LINE_PX },
});

/** Shared so a dial in any panel takes the same seat. */
export const LEDGER_DIAL_ITEM = styles.dialItem;
export const LEDGER_STATED = styles.stated;
