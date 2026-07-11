/** Panel 1 — what Cantor is. Orient before identity. */
import React from 'react';
import { Text } from 'react-native';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <Text style={[type.body, { color: pal.muted }]}>
        Cantor composes songs on your device. No account, no email, no server
        holding your work.
      </Text>
    </PanelBody>
  );
}

export const whatPanel: PanelDef = {
  key: 'what',
  eyebrow: 'What Cantor is',
  title: 'Music that’s only yours',
  sigil: SIGILS.what,
  Body,
};
