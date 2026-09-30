import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { LEDGER_KNOBS } from './Ledger';
import { PanelPressable } from './PanelPressable';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/**
 * KNOBS — Folio, the one frame every blind is drawn in
 * (`docs/interfacealpha/folio.html#anatomy` and `#measures`).
 *
 * Like `LEDGER_KNOBS`, these are measured from the curtain's content edge,
 * which is already inset by the page margin: the drawing's x = 130 spine is
 * `LEDGER_KNOBS.SPINE_PX` here.
 */
export const FOLIO_KNOBS = {
  /** The clef: a drawing of the page's subject, right-aligned on the spine. */
  CLEF_PX: 64,
  /** Above the clef, so it stands level with the title's cap height. */
  CLEF_TOP_PX: 22,
  HEAD_TOP_PX: 4,
  HEAD_BOTTOM_PX: 22,
  /** Eyebrow, title and meta: the field's own header, seated on the axis. */
  EYEBROW_LINE_PX: 16,
  NAV_SIZE_PX: 10,
  NAV_TRACKING: 1.6,
  TITLE_SIZE_PX: 26,
  TITLE_LINE_PX: 32,
  TITLE_GAP_PX: 8,
  META_SIZE_PX: 10.5,
  META_TRACKING: 1.4,
  META_GAP_PX: 9,
  /** Scrolling content fades into paper this far before the coda's bar. */
  FADE_PX: 28,
  /** The final double bar: hairline, gap, two points of ink. */
  BAR_HAIRLINE_PX: 1,
  BAR_GAP_PX: 2,
  BAR_INK_PX: 2,
  /** The page's one act, after the bar, in the display face. */
  ACT_SIZE_PX: 22,
  ACT_LINE_PX: 28,
  ACT_TOP_PX: 17,
  /** Above the act when a reason sits between it and the bar. */
  ACT_AFTER_WHY_PX: 8,
  WHY_TOP_PX: 14,
  CODA_BOTTOM_PX: 8,
  /** A page with no act still ends on the bar, in this much room. */
  BARE_CODA_PX: 26,
} as const;

/** Where the coda's act begins: one gutter past the spine. */
const CODA_INSET_PX = LEDGER_KNOBS.SPINE_PX + LEDGER_KNOBS.GUTTER_PX;
/**
 * An act is a 48 dp target with its 28 px line centred in it, so the seat
 * above it gives back the half of the difference the target already adds.
 */
const ACT_TARGET_SLACK_PX = (touch.min - FOLIO_KNOBS.ACT_LINE_PX) / 2;

/** The coda's act, as a plain style object a morphing word can be handed. */
export const FOLIO_ACT_STYLE = {
  fontFamily: font.display,
  fontSize: FOLIO_KNOBS.ACT_SIZE_PX,
  lineHeight: FOLIO_KNOBS.ACT_LINE_PX,
} as const;

/** The mono line under the act: a consequence, four words at most. */
export const FOLIO_NOTE_STYLE = {
  fontFamily: font.mono,
  fontSize: 10,
  letterSpacing: 1.2,
  lineHeight: 15,
} as const;

/** The eyebrow as a plain style, for a caller that morphs it. */
export const FOLIO_EYEBROW_STYLE = {
  fontFamily: font.mono,
  fontSize: 11,
  letterSpacing: 2,
} as const;

/** The meta line as a plain style, for a caller that morphs it. */
export const FOLIO_META_STYLE = {
  fontFamily: font.mono,
  fontSize: FOLIO_KNOBS.META_SIZE_PX,
  letterSpacing: FOLIO_KNOBS.META_TRACKING,
} as const;

/** The title as a plain style: the display face at 26 on a 32 px line. */
export const FOLIO_TITLE_STYLE = {
  fontFamily: font.display,
  fontSize: FOLIO_KNOBS.TITLE_SIZE_PX,
  letterSpacing: type.title.letterSpacing,
  lineHeight: FOLIO_KNOBS.TITLE_LINE_PX,
} as const;

/**
 * The one word at the right end of the eyebrow row: `CLOSE` at a blind's top
 * level, the way back one level in (`‹ NODES`). There is always exactly one.
 */
export type FolioNav = Readonly<{
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}>;

type HeadProps = {
  /** A drawing of the subject, at `FOLIO_KNOBS.CLEF_PX`. */
  clef?: React.ReactNode;
  /** Where you are. A string is set in the eyebrow's mono; a node is placed as is. */
  eyebrow: React.ReactNode;
  nav: FolioNav;
  /** What this is, in the display face. A node for an editable title. */
  title: React.ReactNode;
  /** Its state, four words at most. */
  meta?: React.ReactNode;
};

/**
 * The head: a clef in the label column, and the field's three header lines
 * beside it — eyebrow, title, meta. The spine starts at the clef, the way a
 * staff starts at its clef.
 */
export function FolioHead({ clef, eyebrow, nav, title, meta }: HeadProps) {
  const pal = usePalette();
  return (
    <View style={styles.head}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.headSpine, { backgroundColor: pal.spine }]}
      />
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.clef}
      >
        {clef}
      </View>
      <View style={styles.headText}>
        <View style={styles.eyebrowRow}>
          <View style={styles.eyebrow}>
            {typeof eyebrow === 'string' ? (
              <Text
                numberOfLines={1}
                style={[
                  FOLIO_EYEBROW_STYLE,
                  styles.eyebrowText,
                  { color: pal.muted },
                ]}
              >
                {eyebrow}
              </Text>
            ) : (
              eyebrow
            )}
          </View>
          <PanelPressable
            accessibilityLabel={nav.accessibilityLabel}
            accessibilityRole="button"
            hitSlop={space.md}
            onPress={nav.onPress}
            style={styles.nav}
          >
            <Text style={[styles.navText, { color: pal.muted }]}>
              {nav.label}
            </Text>
          </PanelPressable>
        </View>
        <View style={styles.title}>
          {typeof title === 'string' ? (
            <Text style={[FOLIO_TITLE_STYLE, { color: pal.ink }]}>{title}</Text>
          ) : (
            title
          )}
        </View>
        {meta === undefined || meta === null ? null : (
          <View style={styles.meta}>
            {typeof meta === 'string' ? (
              <Text
                style={[
                  FOLIO_META_STYLE,
                  styles.metaText,
                  { color: pal.faint },
                ]}
              >
                {meta}
              </Text>
            ) : (
              meta
            )}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * The stave: the page's measures, scrolling between the head and the coda.
 *
 * The last stretch of spine grows to fill whatever is left, so the line always
 * meets the coda's bar however short the page is, and content scrolls into
 * paper `FADE_PX` before the bar rather than under it. No scroll indicator: it
 * sat on the rule.
 */
export const Stave = React.forwardRef<
  ScrollView,
  ScrollViewProps & { children: React.ReactNode }
>(function StaveImpl({ children, contentContainerStyle, ...scroll }, ref) {
  const pal = usePalette();
  return (
    <View style={styles.stave}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        {...scroll}
        contentContainerStyle={[styles.staveContent, contentContainerStyle]}
      >
        {children}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={styles.tail}
        >
          <View style={[styles.tailSpine, { backgroundColor: pal.spine }]} />
        </View>
      </ScrollView>
      <PaperFade colour={pal.bg} />
    </View>
  );
});

/** The band where scrolling content goes into paper before the bar. */
function PaperFade({ colour }: { colour: string }) {
  const [width, setWidth] = React.useState(0);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      pointerEvents="none"
      style={styles.fade}
    >
      {width > 0 ? (
        <Canvas style={StyleSheet.absoluteFill}>
          <Rect x={0} y={0} width={width} height={FOLIO_KNOBS.FADE_PX}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, FOLIO_KNOBS.FADE_PX)}
              colors={[`${colour}00`, colour]}
            />
          </Rect>
        </Canvas>
      ) : null}
    </View>
  );
}

/**
 * The coda: the spine turning into the final double bar, with the page's one
 * act after it — or nothing, and the page still ends on the bar.
 *
 * `why` is a sentence that has to stand between the bar and the act (a reason
 * the act cannot run yet); `children` is the act and its note.
 */
export function Coda({
  children,
  why,
  style,
}: {
  children?: React.ReactNode;
  why?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const pal = usePalette();
  const bare = children === undefined || children === null;
  const hasWhy = why !== undefined && why !== null && why !== false;
  return (
    <View style={[bare ? styles.bareCoda : styles.coda, style]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[styles.bar, { borderColor: pal.ink }]}
      />
      {hasWhy ? <View style={styles.why}>{why}</View> : null}
      {bare ? null : (
        <View style={hasWhy ? styles.actAfterWhy : styles.act}>{children}</View>
      )}
    </View>
  );
}

/** A reason in the coda: Spectral 13, never spaced capitals. */
export function CodaWhy({ children }: { children: React.ReactNode }) {
  const pal = usePalette();
  return <Text style={[type.small, { color: pal.muted }]}>{children}</Text>;
}

/**
 * A whole blind in one: head, stave, coda. A caller with more than one page
 * under one head (the song sheet's pager) composes the parts itself.
 */
export function Folio({
  children,
  coda,
  why,
  stave,
  ...head
}: HeadProps & {
  children: React.ReactNode;
  /** The page's one act; leave out for a page that has none. */
  coda?: React.ReactNode;
  why?: React.ReactNode;
  stave?: ScrollViewProps;
}) {
  return (
    <View style={styles.folio}>
      <FolioHead {...head} />
      <Stave {...stave}>{children}</Stave>
      <Coda why={why}>{coda}</Coda>
    </View>
  );
}

const styles = StyleSheet.create({
  folio: { flex: 1 },
  head: {
    columnGap: LEDGER_KNOBS.GUTTER_PX,
    flexDirection: 'row',
    paddingBottom: FOLIO_KNOBS.HEAD_BOTTOM_PX,
    paddingTop: FOLIO_KNOBS.HEAD_TOP_PX,
  },
  headSpine: {
    bottom: 0,
    left: LEDGER_KNOBS.SPINE_PX,
    position: 'absolute',
    top: FOLIO_KNOBS.HEAD_TOP_PX + FOLIO_KNOBS.CLEF_TOP_PX,
    width: StyleSheet.hairlineWidth,
  },
  clef: {
    alignItems: 'flex-end',
    paddingTop: FOLIO_KNOBS.CLEF_TOP_PX,
    width: LEDGER_KNOBS.LABEL_PX,
  },
  headText: { flex: 1, minWidth: 0 },
  eyebrowRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.sm,
    height: FOLIO_KNOBS.EYEBROW_LINE_PX,
  },
  eyebrow: { flex: 1, height: FOLIO_KNOBS.EYEBROW_LINE_PX, minWidth: 0 },
  eyebrowText: {
    includeFontPadding: false,
    lineHeight: FOLIO_KNOBS.EYEBROW_LINE_PX,
  },
  nav: { alignItems: 'flex-end', minHeight: FOLIO_KNOBS.EYEBROW_LINE_PX },
  navText: {
    fontFamily: font.mono,
    fontSize: FOLIO_KNOBS.NAV_SIZE_PX,
    includeFontPadding: false,
    letterSpacing: FOLIO_KNOBS.NAV_TRACKING,
    lineHeight: FOLIO_KNOBS.EYEBROW_LINE_PX,
  },
  title: { marginTop: FOLIO_KNOBS.TITLE_GAP_PX },
  meta: {
    marginTop: FOLIO_KNOBS.META_GAP_PX,
    minHeight: FOLIO_KNOBS.EYEBROW_LINE_PX,
  },
  metaText: { lineHeight: FOLIO_KNOBS.EYEBROW_LINE_PX },
  stave: { flex: 1, minHeight: 0 },
  staveContent: { flexGrow: 1 },
  tail: { flexGrow: 1, minHeight: FOLIO_KNOBS.FADE_PX },
  tailSpine: {
    bottom: 0,
    left: LEDGER_KNOBS.SPINE_PX,
    position: 'absolute',
    top: 0,
    width: StyleSheet.hairlineWidth,
  },
  fade: {
    bottom: 0,
    height: FOLIO_KNOBS.FADE_PX,
    left: -space.lg,
    position: 'absolute',
    right: -space.lg,
  },
  coda: {
    paddingBottom: FOLIO_KNOBS.CODA_BOTTOM_PX,
    paddingLeft: CODA_INSET_PX,
  },
  bareCoda: { height: FOLIO_KNOBS.BARE_CODA_PX },
  bar: {
    borderBottomWidth: FOLIO_KNOBS.BAR_INK_PX,
    borderTopWidth: FOLIO_KNOBS.BAR_HAIRLINE_PX,
    height:
      FOLIO_KNOBS.BAR_HAIRLINE_PX +
      FOLIO_KNOBS.BAR_GAP_PX +
      FOLIO_KNOBS.BAR_INK_PX,
    left: LEDGER_KNOBS.SPINE_PX,
    position: 'absolute',
    right: -space.lg,
    top: 0,
  },
  why: { paddingTop: FOLIO_KNOBS.WHY_TOP_PX },
  act: { paddingTop: FOLIO_KNOBS.ACT_TOP_PX - ACT_TARGET_SLACK_PX },
  actAfterWhy: {
    paddingTop: Math.max(0, FOLIO_KNOBS.ACT_AFTER_WHY_PX - ACT_TARGET_SLACK_PX),
  },
});
