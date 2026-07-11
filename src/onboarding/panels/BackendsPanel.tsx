/**
 * Panel 2 — where the work happens. Cantor is open: you pick the engine.
 * Only on-device runs today; PC and cloud are honest "Soon" rows.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, PanelBody } from './kit';
import { SIGILS } from '../sigils';
import { space, type, usePalette } from '../../theme/tokens';
import type { PanelBodyProps, PanelDef } from './types';

type Backend = { name: string; desc: string; status: string; ready: boolean };

const BACKENDS: Backend[] = [
  {
    name: 'On this device',
    desc: 'Private, offline, free. Slower — your phone does the work.',
    status: 'Available now',
    ready: true,
  },
  {
    name: 'On your PC',
    desc: 'Pair your computer for full speed, still under your own roof.',
    status: 'Soon',
    ready: false,
  },
  {
    name: 'In Cantor’s cloud',
    desc: 'Fastest, nothing to set up.',
    status: 'Soon',
    ready: false,
  },
];

function Body({ onNext }: PanelBodyProps) {
  const pal = usePalette();
  return (
    <PanelBody footer={<Button label="Continue" onPress={onNext} />}>
      <View style={styles.list}>
        {BACKENDS.map((b, i) => (
          <View
            key={b.name}
            style={[
              styles.row,
              { borderTopColor: pal.line },
              i === 0 && styles.first,
            ]}>
            <View style={styles.rowHead}>
              <Text style={[type.heading, { color: pal.ink }]}>{b.name}</Text>
              <Text
                style={[type.eyebrow, { color: b.ready ? pal.ink : pal.faint }]}>
                {b.status.toUpperCase()}
              </Text>
            </View>
            <Text style={[type.small, { color: pal.muted }]}>{b.desc}</Text>
          </View>
        ))}
      </View>
    </PanelBody>
  );
}

export const backendsPanel: PanelDef = {
  key: 'backends',
  eyebrow: 'Where songs are made',
  title: 'You choose where the work happens',
  sigil: SIGILS.backends,
  Body,
};

const styles = StyleSheet.create({
  list: { marginTop: space.xs },
  row: { borderTopWidth: 1, paddingVertical: space.md, gap: space.xs },
  first: { borderTopWidth: 0, paddingTop: 0 },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
});
