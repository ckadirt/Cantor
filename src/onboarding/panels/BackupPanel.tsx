/**
 * Panel 4 — keep it safe. Soft confirmation, not a quiz: Continue unlocks once
 * they say they've saved the words. Revisitable in Settings later.
 *
 * The phrase reads as prose inside one quiet gray box; a small two-square
 * mark in its corner copies it (squares and hairlines, like the rest of the
 * kit — no icon font).
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { Button, Checkbox, PanelBody } from './kit';
import { getIdentityPhrase } from '../../identity/mnemonic';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

/* -------------------------------------------------------------- layout knobs */
const PROSE_SIZE = 13;
const PROSE_LINE_H = 22;
const BOX_PAD = space.md;
/** Keeps the prose clear of the copy mark in the corner. */
const PROSE_CLEARANCE = 28;
/** The copy mark: two offset squares sharing one corner. */
const MARK = 14;
const MARK_SQUARE = 10;

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = getIdentityPhrase();

  const copy = () => {
    Clipboard.setString(getIdentityPhrase().join(' '));
    setCopied(true);
  };

  return (
    <PanelBody
      footer={<Button label="Continue" onPress={onNext} disabled={!saved} />}>
      <View
        accessible
        accessibilityLabel={words.join(', ')}
        style={[styles.phraseBox, { backgroundColor: pal.line }]}>
        <Text style={[styles.prose, { color: pal.ink }]}>{words.join(' ')}</Text>
        <Pressable
          onPress={copy}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy phrase'}
          style={styles.copy}>
          {copied ? (
            <Text style={[styles.copiedTick, { color: pal.muted }]}>✓</Text>
          ) : (
            <View style={styles.mark}>
              <View
                style={[styles.markSquare, styles.markBack, { borderColor: pal.muted }]}
              />
              <View
                style={[
                  styles.markSquare,
                  styles.markFront,
                  { borderColor: pal.muted, backgroundColor: pal.line },
                ]}
              />
            </View>
          )}
        </Pressable>
      </View>

      <Text style={[type.small, styles.note, { color: pal.muted }]}>
        If you lose this device, these words are the only way back. Cantor
        cannot recover them — keep them somewhere safe.
      </Text>

      <View style={styles.confirm}>
        <Checkbox
          checked={saved}
          onToggle={() => setSaved(s => !s)}
          label="I’ve saved my words somewhere safe"
        />
      </View>
      <Text style={[type.small, styles.settings, { color: pal.faint }]}>
        You can see them anytime in Settings.
      </Text>
    </PanelBody>
  );
}

export const backupPanel: PanelDef = {
  key: 'backup',
  eyebrow: 'Keep it safe',
  title: 'Write these down',
  sigil: SIGILS.backup,
  Body,
};

const styles = StyleSheet.create({
  phraseBox: {
    padding: BOX_PAD,
    marginBottom: space.md,
  },
  prose: {
    fontFamily: type.mono.fontFamily,
    fontSize: PROSE_SIZE,
    lineHeight: PROSE_LINE_H,
    paddingRight: PROSE_CLEARANCE,
  },
  copy: {
    position: 'absolute',
    top: space.sm,
    right: space.sm,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copiedTick: { fontFamily: type.mono.fontFamily, fontSize: 12 },
  mark: { width: MARK, height: MARK },
  markSquare: {
    position: 'absolute',
    width: MARK_SQUARE,
    height: MARK_SQUARE,
    borderWidth: 1,
  },
  markBack: { top: 0, right: 0 },
  markFront: { bottom: 0, left: 0 },
  confirm: { marginTop: space.sm },
  note: { marginBottom: space.sm },
  settings: { marginTop: space.xs },
});
