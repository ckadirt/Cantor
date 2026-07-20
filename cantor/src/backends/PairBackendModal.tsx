import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { space, touch, type, usePalette } from '../theme/tokens';
import { parsePairingUri } from './pairing';
import type { PairingRequest } from './types';

const SCANNER_HEIGHT = 330;
const SCANNER_GUIDE_SIZE = 220;

type Props = {
  visible: boolean;
  onClose: () => void;
  onPair: (request: PairingRequest) => void;
};

export function PairBackendModal({ visible, onClose, onPair }: Props) {
  const pal = usePalette();
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [error, setError] = useState<string | null>(null);
  const lastValue = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }
    lastValue.current = null;
    setError(null);
  }, [visible]);

  const accept = useCallback(
    (value: string) => {
      if (lastValue.current === value) {
        return;
      }
      lastValue.current = value;
      try {
        onPair(parsePairingUri(value));
      } catch (caught) {
        lastValue.current = null;
        setError(readError(caught));
      }
    },
    [onPair],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      const value = codes.find(code =>
        code.value?.startsWith('cantor://pair'),
      )?.value;
      if (value) {
        accept(value);
      }
    },
  });

  const paste = async () => {
    lastValue.current = null;
    const value = await Clipboard.getString();
    if (!value.trim()) {
      setError('The clipboard does not contain a pairing URI.');
      return;
    }
    accept(value);
  };

  const requestCamera = async () => {
    try {
      const granted = await requestPermission();
      if (!granted) {
        setError(
          'Camera permission was not granted. You can paste the URI instead.',
        );
      }
    } catch (caught) {
      setError(readError(caught));
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: pal.bg }]}>
        <View style={styles.header}>
          <Text style={[type.title, { color: pal.ink }]}>Pair a backend</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close pairing"
            onPress={onClose}
            hitSlop={12}
          >
            <Text style={[type.mono, { color: pal.muted }]}>CLOSE</Text>
          </Pressable>
        </View>

        <Text style={[type.body, styles.intro, { color: pal.muted }]}>
          Run `cantor-node pair`, then point this camera at its terminal QR.
        </Text>

        <View
          style={[
            styles.scanner,
            { borderColor: pal.line, backgroundColor: pal.line },
          ]}
        >
          {hasPermission && device ? (
            <>
              <Camera
                style={StyleSheet.absoluteFill}
                device={device}
                isActive={visible}
                codeScanner={codeScanner}
              />
              <View
                pointerEvents="none"
                style={[styles.guide, { borderColor: pal.bg }]}
              />
            </>
          ) : (
            <View style={styles.cameraMessage}>
              <Text
                style={[
                  type.small,
                  styles.cameraMessageText,
                  { color: pal.muted },
                ]}
              >
                {hasPermission
                  ? 'No rear camera is available.'
                  : 'Camera permission is needed to scan the QR.'}
              </Text>
              {!hasPermission ? (
                <Action label="Allow camera" onPress={() => requestCamera()} />
              ) : null}
            </View>
          )}
        </View>

        {error ? (
          <Text
            accessibilityRole="alert"
            style={[type.small, styles.error, { color: pal.ink }]}
          >
            {error}
          </Text>
        ) : null}

        <View style={styles.fallback}>
          <View style={[styles.rule, { backgroundColor: pal.line }]} />
          <Text style={[type.eyebrow, { color: pal.faint }]}>OR</Text>
          <View style={[styles.rule, { backgroundColor: pal.line }]} />
        </View>
        <Action label="Paste pairing URI" onPress={() => paste()} />
      </View>
    </Modal>
  );
}

function Action({ label, onPress }: { label: string; onPress: () => void }) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.action, { borderColor: pal.ink }]}
    >
      <Text style={[type.mono, { color: pal.ink }]}>{label}</Text>
    </Pressable>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.xl },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  intro: { marginTop: space.md, marginBottom: space.lg },
  scanner: {
    height: SCANNER_HEIGHT,
    overflow: 'hidden',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guide: {
    width: SCANNER_GUIDE_SIZE,
    height: SCANNER_GUIDE_SIZE,
    borderWidth: 1,
  },
  cameraMessage: {
    padding: space.lg,
    alignItems: 'center',
    gap: space.md,
  },
  cameraMessageText: { textAlign: 'center' },
  error: { marginTop: space.md },
  fallback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginVertical: space.lg,
  },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  action: {
    minHeight: touch.min,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
});
