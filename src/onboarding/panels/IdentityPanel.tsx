/**
 * Panel 3 — the reveal. The 12-word identity, created on-device. The mechanics
 * (BIP39, ed25519) live behind an expandable "How does this work?" for the
 * curious; everyone else just meets their words and moves on.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Button, PanelBody } from './kit';
import { PLACEHOLDER_PHRASE } from './phrase';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const words = PLACEHOLDER_PHRASE;
  const half = Math.ceil(words.length / 2);

  const toggle = () => setOpen(o => !o);

  const column = (from: number, to: number) => (
    <View style={styles.col}>
      {words.slice(from, to).map((w, i) => (
        <View key={w} style={styles.word}>
          <Text style={[styles.num, { color: pal.faint }]}>
            {String(from + i + 1).padStart(2, '0')}
          </Text>
          <Text style={[styles.wordText, { color: pal.ink }]}>{w}</Text>
        </View>
      ))}
    </View>
  );

  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <Text style={[type.small, styles.lede, { color: pal.muted }]}>
        These twelve words are your identity in Cantor. They were just created on
        this device — no password behind them, and no one else has them.
      </Text>

      <View style={[styles.grid, { borderColor: pal.line }]}>
        {column(0, half)}
        <View style={[styles.divider, { backgroundColor: pal.line }]} />
        {column(half, words.length)}
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
  grid: {
    flexDirection: 'row',
    borderWidth: 1,
    paddingVertical: space.sm,
  },
  col: { flex: 1, paddingHorizontal: space.md, gap: space.sm, paddingVertical: space.xs },
  divider: { width: 1 },
  word: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  num: {
    fontFamily: type.mono.fontFamily,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  wordText: { fontFamily: type.mono.fontFamily, fontSize: 15 },
  howHead: { marginTop: space.lg },
  howBody: { marginTop: space.sm },
});
