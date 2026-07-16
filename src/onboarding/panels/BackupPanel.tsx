/**
 * Panel 4 — keep it safe. Soft confirmation, not a quiz: Continue unlocks once
 * they say they've saved the words. Revisitable in Settings later.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { Button, Checkbox, PanelBody } from './kit';
import { getIdentityPhrase } from '../../identity/mnemonic';
import { SIGILS } from '../sigils';
import { space, touch, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

/* -------------------------------------------------------------- layout knobs */
const PHRASE_COLUMNS = 4;
const PHRASE_WORD_H = 18;
const PHRASE_BOX_PAD = 8;
const PHRASE_COLUMN_GAP = 8;
const PHRASE_ROW_GAP = 4;
const PHRASE_WORD_SIZE = 13;

function Body({
  onNext,
  phraseHandoffActive = false,
  onPhraseTarget,
}: PanelBodyProps) {
  const pal = usePalette();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const phraseRef = useRef<View>(null);
  const words = getIdentityPhrase();
  const rows = Array.from(
    { length: Math.ceil(words.length / PHRASE_COLUMNS) },
    (_, row) => words.slice(row * PHRASE_COLUMNS, (row + 1) * PHRASE_COLUMNS),
  );

  const copy = () => {
    Clipboard.setString(getIdentityPhrase().join(' '));
    setCopied(true);
  };
  const reportPhraseTarget = useCallback(() => {
    if (!phraseHandoffActive || !onPhraseTarget) {
      return;
    }
    phraseRef.current?.measureInWindow((x, y, width) => {
      const innerWidth = width - PHRASE_BOX_PAD * 2;
      const wordWidth =
        (innerWidth - PHRASE_COLUMN_GAP * (PHRASE_COLUMNS - 1)) /
        PHRASE_COLUMNS;
      onPhraseTarget({
        words: words.map((word, index) => {
          const row = Math.floor(index / PHRASE_COLUMNS);
          const column = index % PHRASE_COLUMNS;
          return {
            key: `${index}-${word}`,
            text: word,
            x:
              x +
              PHRASE_BOX_PAD +
              column * (wordWidth + PHRASE_COLUMN_GAP),
            y:
              y +
              PHRASE_BOX_PAD +
              row * (PHRASE_WORD_H + PHRASE_ROW_GAP),
            width: wordWidth,
          };
        }),
      });
    });
  }, [onPhraseTarget, phraseHandoffActive, words]);

  return (
    <PanelBody
      footer={<Button label="Continue" onPress={onNext} disabled={!saved} />}>
      <Text style={[type.small, styles.body, { color: pal.muted }]}>
        These twelve words are the only way back to your identity if you lose this
        device. This recovery key is also needed to sync your identity on other
        devices. Cantor cannot recover it for you. Keep it somewhere safe.
      </Text>

      <View
        ref={phraseRef}
        accessible
        accessibilityLabel={words.join(', ')}
        onLayout={reportPhraseTarget}
        style={[styles.phraseBox, { backgroundColor: pal.line }]}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.phraseRow}>
            {row.map((word, columnIndex) => (
              <View
                key={`${rowIndex}-${columnIndex}-${word}`}
                style={styles.wordSlot}>
                {!phraseHandoffActive && (
                  <Text style={[styles.word, { color: pal.ink }]}>{word}</Text>
                )}
              </View>
            ))}
          </View>
        ))}
      </View>

      <Pressable
        onPress={copy}
        accessibilityRole="button"
        style={[styles.copy, { borderColor: pal.ink }]}>
        <Text style={[type.mono, { color: pal.ink }]}>
          {copied ? 'COPIED' : 'COPY PHRASE'}
        </Text>
      </Pressable>

      <View style={styles.confirm}>
        <Checkbox
          checked={saved}
          onToggle={() => setSaved(s => !s)}
          label="I’ve saved my words somewhere safe"
        />
      </View>
      <Text style={[type.small, styles.note, { color: pal.faint }]}>
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
  body: { marginBottom: space.sm },
  phraseBox: {
    padding: PHRASE_BOX_PAD,
    rowGap: PHRASE_ROW_GAP,
    marginBottom: space.sm,
  },
  phraseRow: { flexDirection: 'row', columnGap: PHRASE_COLUMN_GAP },
  wordSlot: { flex: 1, height: PHRASE_WORD_H, overflow: 'hidden' },
  word: {
    fontFamily: type.mono.fontFamily,
    fontSize: PHRASE_WORD_SIZE,
  },
  copy: {
    borderWidth: 1,
    minHeight: touch.min,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirm: { marginTop: space.sm },
  note: { marginTop: space.xs },
});
