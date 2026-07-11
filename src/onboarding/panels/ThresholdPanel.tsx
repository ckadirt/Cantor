/**
 * Panel 5 — the threshold. Hilbert's defence of Cantor's set theory, read here
 * as the benediction into the app: you've been given your keys, now cross over.
 * No eyebrow, no title — the frame's letters morph away and the quote stands
 * alone under the lemniscate.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

function Body({ onDone }: PanelBodyProps) {
  const pal = usePalette();
  return (
    <PanelBody center footer={<Button label="Enter" onPress={onDone} filled />}>
      <View style={styles.block}>
        <Text style={[styles.quote, { color: pal.ink }]}>
          “No one shall expel us from the paradise which Cantor has created for
          us.”
        </Text>
        <Text style={[type.eyebrow, styles.attrib, { color: pal.faint }]}>
          DAVID HILBERT · 1926
        </Text>
      </View>
    </PanelBody>
  );
}

export const thresholdPanel: PanelDef = {
  key: 'threshold',
  eyebrow: '',
  title: '',
  sigil: SIGILS.threshold,
  Body,
};

const styles = StyleSheet.create({
  block: { alignItems: 'center', paddingHorizontal: space.sm },
  quote: {
    fontFamily: type.title.fontFamily,
    fontSize: 24,
    lineHeight: 34,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  attrib: { marginTop: space.lg, textAlign: 'center' },
});
