import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { space, touch, type, usePalette } from '../../theme/tokens';

type Props = {
  visible: boolean;
  backends: readonly BackendRecord[] | null;
  snapshots: Readonly<Record<string, ConnectionSnapshot>>;
  refreshing: boolean;
  onClose: () => void;
  onPair: () => void;
  onRefresh: () => void;
};

/** Conventional management belongs in a sheet, not in the zoom hierarchy. */
function EnginesSheetImpl({
  visible,
  backends,
  snapshots,
  refreshing,
  onClose,
  onPair,
  onRefresh,
}: Props) {
  const pal = usePalette();
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
    >
      <View style={styles.scrim}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: pal.bg, borderColor: pal.line },
          ]}
        >
          <View style={styles.header}>
            <Text style={[type.title, { color: pal.ink }]}>Engines</Text>
            <Pressable
              accessibilityLabel="Close engines"
              accessibilityRole="button"
              onPress={onClose}
            >
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>
          {backends === null ? (
            <Text style={[type.body, { color: pal.muted }]}>
              Loading paired nodes…
            </Text>
          ) : backends.length === 0 ? (
            <Text style={[type.body, { color: pal.muted }]}>
              No engine is paired yet.
            </Text>
          ) : (
            backends.map(backend => {
              const snapshot = snapshots[backend.nodePubkey];
              const phase = snapshot?.phase ?? 'disconnected';
              return (
                <View
                  key={backend.nodePubkey}
                  style={[styles.backend, { borderColor: pal.line }]}
                >
                  <Text style={[type.heading, { color: pal.ink }]}>
                    {backend.lastNodeInfo?.name ?? backend.petname}
                  </Text>
                  <Text style={[type.small, { color: pal.muted }]}>
                    {phase.toUpperCase()} ·{' '}
                    {backend.lastNodeInfo?.models.length ?? 0} MODELS
                  </Text>
                  {snapshot?.error ? (
                    <Text
                      accessibilityRole="alert"
                      style={[type.small, { color: pal.ink }]}
                    >
                      {snapshot.error}
                    </Text>
                  ) : null}
                </View>
              );
            })
          )}
          <View style={styles.actions}>
            <Action label="Pair a backend" onPress={onPair} />
            <Action
              label={refreshing ? 'Refreshing…' : 'Refresh libraries'}
              onPress={onRefresh}
              disabled={refreshing}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        disabled && styles.actionDisabled,
        { borderColor: pal.ink },
      ]}
    >
      <Text style={[type.mono, { color: pal.ink }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: '#00000055', flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopWidth: 1, gap: space.md, padding: space.lg },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backend: {
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
    paddingTop: space.md,
  },
  actions: { gap: space.sm, marginTop: space.sm },
  action: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: touch.min,
  },
  actionDisabled: { opacity: 0.45 },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const EnginesSheet = React.memo(EnginesSheetImpl);
