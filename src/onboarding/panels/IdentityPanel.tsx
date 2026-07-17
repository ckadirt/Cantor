/**
 * Panel 3 — the reveal. The 12-word identity, freshly minted on-device.
 *
 * Each fixed slot starts with the word's true entropy — the 11 bits that are
 * its index in the BIP39 wordlist — then morphs those bits into the word. The
 * three-column grid and slot widths never change, so neither representation can
 * reflow the phrase while the reveal is running.
 *
 * Flicker law notes: every source and destination is installed in one sequence
 * canvas before its shared UI clock starts. There are no text swaps, width
 * commits, or ownership hand-offs through React during the cascade. The only
 * later commit reveals Continue after the canvas paints its terminal frame.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  runOnJS,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import {
  MorphTextSequence,
  useMorphFont,
  type MorphTextSequenceItem,
} from '../../motion';
import { Button, PanelBody } from './kit';
import { getIdentityPhrase, wordBits } from '../../identity/mnemonic';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

/* -------------------------------------------------------------- motion knobs */
/** Lets all 12 prebuilt canvas models paint their source before time advances. */
const CANVAS_PREPARE_MS = 600;
/** All 12 bit groups use this simultaneous DrawBorderThenFill runtime. */
const BITS_WRITE_MS = 800;
/** Quiet beat between the completed write and the first word morph. */
const BITS_HOLD_MS = 180;
/** Delay between consecutive word morph starts. */
const MORPH_STAGGER_MS = 100;
/** Runtime of each byte-to-word transform. */
const MORPH_MS = 480;
/** Soft reveal after the last word is completely settled. */
const BUTTON_REVEAL_MS = 180;

/* -------------------------------------------------------------- layout knobs */
/** A stable three-column phrase: four rows before, during, and after the morph. */
const WORDS_PER_ROW = 3;
/** Reference size; narrow viewports step the whole phrase down from here. */
const WORD_SIZE = 13;
/** The phrase never shrinks below this, even on the narrowest columns. */
const MIN_WORD_SIZE = 9;
/** Estimated mono advance — only until the real font metrics arrive. */
const MONO_ADVANCE = WORD_SIZE * 0.6;
const WORD_H = 20;
const BITS_LEN = 11;
/** Slack over the measured bits width so layout can never wrap a digit. */
const BITS_PAD = 2;
const NUMBER_W = 16;
const NUMBER_SLOT_GAP = 4;
const NUMBER_LINE_H = 13;
const CONTINUE_SLOT_H = 48;

/** Reference style: real metrics are measured at this size, then scaled. */
const WORD_STYLE: TextStyle = {
  fontFamily: type.mono.fontFamily,
  fontSize: WORD_SIZE,
};

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(reduced);
  const [phraseWidth, setPhraseWidth] = useState(0);
  const clock = useSharedValue(reduced ? 1 : 0);
  const words = getIdentityPhrase();

  // The bits width comes from the font's REAL digit advance, not an estimate
  // — an estimate a hair too small wraps the 11th digit onto its own line.
  const font = useMorphFont(WORD_STYLE);
  const refAdvance = useMemo(() => {
    if (!font) {
      return MONO_ADVANCE;
    }
    const widths = font.getGlyphWidths(font.getGlyphIDs('01'));
    return Math.max(widths[0], widths[1]);
  }, [font]);
  const columnGap = space.sm;
  const columnWidth =
    phraseWidth > 0
      ? (phraseWidth - columnGap * (WORDS_PER_ROW - 1)) / WORDS_PER_ROW
      : 0;
  const slotAvail = columnWidth - NUMBER_W - NUMBER_SLOT_GAP;
  // Each 11-bit group must fit its column whole; narrow viewports step the
  // entire phrase down in half-point sizes instead of wrapping a digit.
  const fit =
    slotAvail > 0
      ? Math.min(1, slotAvail / (refAdvance * BITS_LEN + BITS_PAD))
      : 1;
  const wordSize = Math.max(MIN_WORD_SIZE, Math.floor(WORD_SIZE * fit * 2) / 2);
  const wordStyle = useMemo<TextStyle>(
    () => ({ fontFamily: type.mono.fontFamily, fontSize: wordSize }),
    [wordSize],
  );
  // The slot width comes from measuring the ACTUAL bit strings with the SAME
  // font+size the canvas lays out with. Scaling the reference measurement down
  // is not enough: the device hints advances per size, so a 13 pt measurement
  // scaled to 11.5 pt undershoots and wraps the last digit.
  const sizedFont = useMorphFont(wordStyle);
  const bitsW = useMemo(() => {
    if (!sizedFont) {
      return (refAdvance * BITS_LEN * wordSize) / WORD_SIZE + BITS_PAD;
    }
    let widest = 0;
    for (const word of words) {
      const ids = sizedFont.getGlyphIDs(wordBits(word));
      const width = sizedFont
        .getGlyphWidths(ids)
        .reduce((sum, w) => sum + w, 0);
      widest = Math.max(widest, width);
    }
    return widest + BITS_PAD;
  }, [refAdvance, sizedFont, wordSize, words]);

  const timelineMs =
    BITS_WRITE_MS +
    BITS_HOLD_MS +
    (words.length - 1) * MORPH_STAGGER_MS +
    MORPH_MS;
  const writeWindow = useMemo(
    () => [0, BITS_WRITE_MS / timelineMs] as const,
    [timelineMs],
  );
  const rows = useMemo(
    () =>
      Array.from({ length: Math.ceil(words.length / WORDS_PER_ROW) }, (_, row) =>
        words.slice(row * WORDS_PER_ROW, (row + 1) * WORDS_PER_ROW),
      ),
    [words],
  );
  const sequenceItems = useMemo<readonly MorphTextSequenceItem[]>(() => {
    if (phraseWidth <= 0) {
      return [];
    }
    return words.map((word, index) => {
      const row = Math.floor(index / WORDS_PER_ROW);
      const column = index % WORDS_PER_ROW;
      const startMs =
        BITS_WRITE_MS + BITS_HOLD_MS + index * MORPH_STAGGER_MS;
      return {
        key: `${index}-${word}`,
        initialText: wordBits(word),
        text: word,
        x:
          column * (columnWidth + columnGap) +
          NUMBER_W +
          NUMBER_SLOT_GAP,
        y: row * (WORD_H + space.sm),
        // One extra character of layout width guards wrapping against any
        // residual metric drift; ink stays inside bitsW, so it is invisible.
        width: bitsW + wordSize,
        start: startMs / timelineMs,
        end: (startMs + MORPH_MS) / timelineMs,
      };
    });
  }, [bitsW, columnGap, columnWidth, phraseWidth, timelineMs, words, wordSize]);
  const revealContinue = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (reduced) {
      clock.value = 1;
      setReady(true);
      return;
    }
    if (phraseWidth <= 0) {
      return;
    }
    setReady(false);
    clock.value = 0;
    clock.value = withDelay(
      CANVAS_PREPARE_MS,
      withTiming(
        1,
        { duration: timelineMs, easing: Easing.linear },
        finished => {
          if (finished) {
            runOnJS(revealContinue)();
          }
        },
      ),
    );
    return () => cancelAnimation(clock);
  }, [clock, phraseWidth, reduced, revealContinue, timelineMs]);

  const toggle = () => setOpen(o => !o);

  return (
    <PanelBody
      footer={
        <View style={styles.continueSlot}>
          {ready && (
            <Animated.View entering={FadeIn.duration(BUTTON_REVEAL_MS)}>
              <Button label="Continue" onPress={onNext} />
            </Animated.View>
          )}
        </View>
      }>
      <Text style={[type.small, styles.lede, { color: pal.muted }]}>
        These twelve words are your identity in Cantor. They were just created on
        this device. There is no password behind them, and no one else has them.
      </Text>

      <View
        style={styles.phrase}
        accessible
        accessibilityLabel={words.join(', ')}
        onLayout={event => {
          const nextWidth = event.nativeEvent.layout.width;
          setPhraseWidth(current =>
            Math.abs(current - nextWidth) < 0.5 ? current : nextWidth,
          );
        }}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.phraseRow}>
            {row.map((word, columnIndex) => {
              const index = rowIndex * WORDS_PER_ROW + columnIndex;
              return (
                <View key={`${index}-${word}`} style={styles.word}>
                  <Text style={[styles.num, { color: pal.faint }]}>
                    {String(index + 1).padStart(2, '0')}
                  </Text>
                  <View style={[styles.slot, { width: bitsW }]} />
                </View>
              );
            })}
          </View>
        ))}
        {sequenceItems.length > 0 && (
          <MorphTextSequence
            items={sequenceItems}
            charStyle={wordStyle}
            color={pal.ink}
            progress={clock}
            writeWindow={writeWindow}
            style={styles.phraseCanvas}
          />
        )}
      </View>

      <Pressable onPress={toggle} style={styles.howHead} hitSlop={8}>
        <Text style={[type.eyebrow, { color: pal.muted }]}>
          {open ? '▾  ' : '▸  '}HOW DOES THIS WORK?
        </Text>
      </Pressable>
      {open && (
        <Animated.Text
          entering={FadeIn.duration(200)}
          style={[type.small, styles.howBody, { color: pal.muted }]}>
          Your device generated 128 random bits and turned them into these words.
          The digits you saw are each word&#8217;s real slice of them. Cantor derives
          a cryptographic key from the words that is your identity. Sharing a
          song means signing it with that key, and anyone can verify
          it&#8217;s you without a server. The words come from a fixed list of
          2,048 with a built-in checksum, so a typo won&#8217;t validate. Re-enter
          them on a new device and you&#8217;re back.
        </Animated.Text>
      )}
    </PanelBody>
  );
}

export const identityPanel: PanelDef = {
  key: 'identity',
  eyebrow: 'Your identity',
  title: 'This is you',
  sigil: SIGILS.identity,
  Body,
};

const styles = StyleSheet.create({
  lede: { marginBottom: space.lg },
  phrase: {
    position: 'relative',
    rowGap: space.sm,
    paddingVertical: space.sm,
  },
  phraseRow: { flexDirection: 'row', columnGap: space.sm },
  word: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: NUMBER_SLOT_GAP,
  },
  slot: { height: WORD_H, overflow: 'hidden' },
  num: {
    width: NUMBER_W,
    fontFamily: type.mono.fontFamily,
    fontSize: 10,
    lineHeight: NUMBER_LINE_H,
    includeFontPadding: false,
    fontVariant: ['tabular-nums'],
  },
  phraseCanvas: {
    position: 'absolute',
    top: space.sm,
    left: 0,
    right: 0,
    bottom: space.sm,
  },
  howHead: { marginTop: space.xl },
  howBody: { marginTop: space.sm },
  continueSlot: { minHeight: CONTINUE_SLOT_H },
});
