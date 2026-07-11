/**
 * Panel 4 — keep it safe. Soft confirmation, not a quiz: Continue unlocks once
 * they say they've saved the words. Revisitable in Settings later.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Checkbox, PanelBody } from './kit';
import { PLACEHOLDER_PHRASE } from './phrase';
import { SIGILS } from '../sigils';
import { space, touch, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // TODO(identity): copy the real phrase to the clipboard once generation is
    // wired (react-native Clipboard). Placeholder confirms the interaction.
    void PLACEHOLDER_PHRASE;
    setCopied(true);
  };

  return (
    <PanelBody
      footer={<Button label="Continue" onPress={onNext} disabled={!saved} />}>
      <Text style={[type.body, styles.body, { color: pal.muted }]}>
        If you lose this device, these twelve words are the only way back to your
        identity. Cantor can&#8217;t recover them for you — that&#8217;s the point.
      </Text>

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
  body: { marginBottom: space.lg },
  copy: {
    borderWidth: 1,
    minHeight: touch.min,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirm: { marginTop: space.lg },
  note: { marginTop: space.sm },
});
