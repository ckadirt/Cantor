/**
 * Panel 3 — the reveal. The 12-word identity, freshly minted on-device.
 *
 * No grid: each slot first WRITES the word's true entropy — the 11 bits that
 * are its index in the BIP39 wordlist — then morphs those bits into the word
 * (the engine's Write and Transform gestures). While bits are on screen every
 * slot is 11 characters wide, so the cascade never reflows; when the last
 * word lands, one condense beat relaxes the slots to their words and the
 * phrase settles into prose.
 *
 * Flicker law notes: RevealWord is memoized with stable prop identities
 * (module-const styles, per-word booleans), so a cascade commit re-records
 * only the one canvas whose text changes — and that canvas is quiescent at
 * both of its commits (before its write, after its morph). The condense is a
 * shared-value width ramp: no React commit at all.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { MorphText, smootherstep } from '../../motion';
import { Button, PanelBody } from './kit';
import { getIdentityPhrase, wordBits } from '../../identity/mnemonic';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

// The ceremony: each slot writes its 11 bits, holds them, morphs to the word;
// after the last morph the whole phrase condenses to word-width in one beat.
const WRITE_BASE_MS = 400;
const WRITE_STAGGER_MS = 90;
const BITS_WRITE_MS = 650;
const MORPH_AFTER_MS = 950; // write start → morph start, per word
const RESOLVE_MS = 480;
const CONDENSE_MS = 420;
const CONDENSE_AFTER_MS =
  WRITE_BASE_MS + 11 * WRITE_STAGGER_MS + MORPH_AFTER_MS + RESOLVE_MS + 150;

// Word geometry — mono metrics are uniform, so widths are exact.
const WORD_SIZE = 15;
const MONO_ADVANCE = WORD_SIZE * 0.6;
const WORD_H = 20;
const BITS_LEN = 11;
const BITS_W = BITS_LEN * MONO_ADVANCE + 2;

const WORD_STYLE: TextStyle = {
  fontFamily: type.mono.fontFamily,
  fontSize: WORD_SIZE,
};

/** Stable identity — a fresh object here would defeat MorphText's memo. */
const SLOT_TEXT_STYLE = { width: BITS_W, height: WORD_H } as const;

const RevealWord = React.memo(function RevealWordImpl({
  word,
  index,
  written,
  resolved,
  condense,
}: {
  word: string;
  index: number;
  written: boolean;
  resolved: boolean;
  condense: SharedValue<number>;
}) {
  const pal = usePalette();
  const bits = useMemo(() => wordBits(word), [word]);
  const wordW = word.length * MONO_ADVANCE + 2;
  const slotStyle = useAnimatedStyle(() => ({
    width: BITS_W + (wordW - BITS_W) * smootherstep(0, 1, condense.value),
  }));
  return (
    <View style={styles.word}>
      <Text style={[styles.num, { color: pal.faint }]}>
        {String(index + 1).padStart(2, '0')}
      </Text>
      <Animated.View style={[styles.slot, slotStyle]}>
        <MorphText
          text={resolved ? word : written ? bits : ''}
          charStyle={WORD_STYLE}
          color={resolved ? pal.ink : pal.faint}
          variant="transform"
          appearance="write"
          writeDuration={BITS_WRITE_MS}
          duration={RESOLVE_MS}
          style={SLOT_TEXT_STYLE}
        />
      </Animated.View>
    </View>
  );
});

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [writtenCount, setWrittenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const condense = useSharedValue(0);
  const words = getIdentityPhrase();

  useEffect(() => {
    if (reduced) {
      setWrittenCount(words.length);
      setResolvedCount(words.length);
      condense.value = 1;
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    words.forEach((_, i) => {
      const t0 = WRITE_BASE_MS + i * WRITE_STAGGER_MS;
      timers.push(
        setTimeout(() => setWrittenCount(n => Math.max(n, i + 1)), t0),
      );
      timers.push(
        setTimeout(
          () => setResolvedCount(n => Math.max(n, i + 1)),
          t0 + MORPH_AFTER_MS,
        ),
      );
    });
    timers.push(
      setTimeout(() => {
        condense.value = withTiming(1, {
          duration: CONDENSE_MS,
          easing: Easing.out(Easing.cubic),
        });
      }, CONDENSE_AFTER_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [words, reduced, condense]);

  const toggle = () => setOpen(o => !o);

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <Text style={[type.small, styles.lede, { color: pal.muted }]}>
        These twelve words are your identity in Cantor. They were just created on
        this device — no password behind them, and no one else has them.
      </Text>

      <View style={styles.phrase} accessible accessibilityLabel={words.join(', ')}>
        {words.map((w, i) => (
          <RevealWord
            key={`${i}-${w}`}
            word={w}
            index={i}
            written={i < writtenCount}
            resolved={i < resolvedCount}
            condense={condense}
          />
        ))}
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
          Your device generated 128 random bits and turned them into these words
          — the digits you saw are each word&#8217;s real slice of them. Cantor
          derives a cryptographic key from the words that is your identity —
          sharing a song means signing it with that key, and anyone can verify
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.lg,
    rowGap: space.sm,
    paddingVertical: space.sm,
  },
  word: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  slot: { height: WORD_H, overflow: 'hidden' },
  num: {
    fontFamily: type.mono.fontFamily,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  howHead: { marginTop: space.xl },
  howBody: { marginTop: space.sm },
});
