import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';
import { font, space, touch, usePalette } from '../../theme/tokens';

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
   * The only separator. Ledger has no section headings — a gap in the spine
   * *is* the heading, which is why nothing in any panel is ever titled.
   */
  GAP_PX: 14,
  LABEL_SIZE_PX: 10,
  LABEL_TRACKING: 1.4,
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
  return (
    <View style={[styles.ledger, style]}>
      <Spine arrival={arrival} colour={pal.line} />
      {children}
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
    arrival === undefined
      ? {}
      : { transform: [{ scaleY: arrival.value }] },
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
  note,
  control = false,
}: {
  children: React.ReactNode;
  label?: string;
  /** Align labels with text inside a 48 dp control without adding row padding twice. */
  control?: boolean;
  /** The quiet mono line under a value: a consequence, or a state. */
  note?: string;
}) {
  const pal = usePalette();
  return (
    <View style={[styles.row, control && styles.controlRow]}>
      <Text
        style={[
          styles.label,
          control && styles.controlLabel,
          { color: pal.faint },
        ]}
      >
        {label === undefined ? '' : label.toUpperCase()}
      </Text>
      <View style={styles.value}>
        {children}
        {note === undefined ? null : (
          <Text style={[styles.note, { color: pal.faint }]}>
            {note.toUpperCase()}
          </Text>
        )}
      </View>
    </View>
  );
}

/** A breath in the spine. The only thing this design has instead of headings. */
export function LedgerGap() {
  return <View style={styles.gap} />;
}

/** Footer geometry matches the selected HTML: rule at x106, action at x130. */
export function LedgerFoot({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const pal = usePalette();
  return (
    <View style={[styles.foot, { borderTopColor: pal.ink }, style]}>
      {children}
    </View>
  );
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
  gap: { height: LEDGER_KNOBS.GAP_PX },
  foot: {
    borderTopWidth: 1,
    marginLeft: LEDGER_KNOBS.SPINE_PX - space.lg,
    marginRight: -space.lg,
    paddingBottom: 0,
    paddingLeft: space.lg,
    paddingTop: 0,
  },
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
