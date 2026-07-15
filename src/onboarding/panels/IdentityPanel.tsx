/**
 * Panel 3 — the reveal. The 12-word identity, freshly minted on-device.
 *
 * No grid: the words flow like the phrase they are. Each one starts as the
 * raw material it came from — a scramble of letters — and morphs into its
 * real self in a reading-order cascade (the engine's Transform gesture), so
 * the screen tells the true story: random bits just became your name.
 * The mechanics live behind "How does this work?" for the curious.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { TransformText } from '../../motion';
import { Button, PanelBody } from './kit';
import { getIdentityPhrase } from '../../identity/mnemonic';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

// The cascade: after the body settles, one word resolves at a time.
const BASE_DELAY_MS = 600;
const STAGGER_MS = 110;
const RESOLVE_MS = 480;

// Word geometry — mono metrics are uniform, so widths are exact.
const WORD_SIZE = 15;
const MONO_ADVANCE = WORD_SIZE * 0.6;
const WORD_H = 20;

const WORD_STYLE: TextStyle = {
  fontFamily: type.mono.fontFamily,
  fontSize: WORD_SIZE,
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Same-length noise for a word — what 128 random bits look like. */
function scrambleFor(word: string): string {
  let s = '';
  for (let i = 0; i < word.length; i++) {
    s += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }
  return s;
}

function RevealWord({
  word,
  index,
  resolved,
}: {
  word: string;
  index: number;
  resolved: boolean;
}) {
  const pal = usePalette();
  const scramble = useMemo(() => scrambleFor(word), [word]);
  return (
    <View style={styles.word}>
      <Text style={[styles.num, { color: pal.faint }]}>
        {String(index + 1).padStart(2, '0')}
      </Text>
      <TransformText
        text={resolved ? word : scramble}
        charStyle={WORD_STYLE}
        color={resolved ? pal.ink : pal.faint}
        duration={RESOLVE_MS}
        style={{ width: word.length * MONO_ADVANCE + 2, height: WORD_H }}
      />
    </View>
  );
}

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [resolvedCount, setResolvedCount] = useState(0);
  const words = getIdentityPhrase();

  useEffect(() => {
    if (reduced) {
      setResolvedCount(words.length);
      return;
    }
    const timers = words.map((_, i) =>
      setTimeout(
        () => setResolvedCount(n => Math.max(n, i + 1)),
        BASE_DELAY_MS + i * STAGGER_MS,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [words, reduced]);

  const toggle = () => setOpen(o => !o);

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <Text style={[type.small, styles.lede, { color: pal.muted }]}>
        These twelve words are your identity in Cantor. They were just created on
        this device — no password behind them, and no one else has them.
      </Text>

      <View style={styles.phrase} accessible accessibilityLabel={words.join(', ')}>
        {words.map((w, i) => (
          <RevealWord key={`${i}-${w}`} word={w} index={i} resolved={i < resolvedCount} />
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
          Your device generated 128 random bits and turned them into these words.
          Cantor derives a cryptographic key from them that is your identity —
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
    rowGap: space.md,
    paddingVertical: space.sm,
  },
  word: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  num: {
    fontFamily: type.mono.fontFamily,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  howHead: { marginTop: space.xl },
  howBody: { marginTop: space.sm },
});
