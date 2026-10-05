import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AppState,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FieldScreen } from './src/screens/FieldScreen';
import { Onboarding } from './src/onboarding/Onboarding';
import { FieldGroupLab } from './src/dev/FieldGroupLab';
import { MotionLab } from './src/dev/MotionLab';
import { PerfHud, PerfProfiler } from './src/dev/PerfHud';
import { getIdentityPhrase } from './src/identity/mnemonic';
import {
  createAndStoreIdentity,
  loadStoredIdentity,
} from './src/identity/secureIdentity';
import type { AppIdentity } from './src/identity/derive';
import { space, touch, type, usePalette } from './src/theme/tokens';

// Dev workbench for the motion engine (src/dev/MotionLab). Flip to true to
// iterate on shapes/text morphs with the scrubber; never ship it on.
const MOTION_LAB = false;
// Visual-only group stress cases. Never enabled in release builds.
const FIELD_GROUP_LAB = false;
// Frame and commit readout over the field (src/dev/PerfHud). Not gated on
// __DEV__, so it can be read on a production-mode bundle; never ship it on.
const PERF_HUD = false;

type IdentityBoot =
  | { state: 'loading' }
  | { state: 'onboarding' }
  | { state: 'identity-error'; message: string }
  | { state: 'ready'; identity: AppIdentity };

export default function App() {
  const pal = usePalette();
  const scheme = useColorScheme();
  const [boot, setBoot] = useState<IdentityBoot>({ state: 'loading' });
  const [identityLoadAttempt, setIdentityLoadAttempt] = useState(0);

  useEffect(() => {
    // A retained playback surface can return in a new Android Activity. Its
    // window is new even though React's StatusBar props have not changed.
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      StatusBar.setBackgroundColor(pal.bg);
      StatusBar.setBarStyle(scheme === 'dark' ? 'light-content' : 'dark-content');
    });
    return () => subscription.remove();
  }, [pal.bg, scheme]);

  useEffect(() => {
    let active = true;
    loadStoredIdentity()
      .then(identity => {
        if (active) {
          setBoot(
            identity ? { state: 'ready', identity } : { state: 'onboarding' },
          );
        }
      })
      .catch(error => {
        if (active) {
          setBoot({ state: 'identity-error', message: readError(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [identityLoadAttempt]);

  const retryIdentityLoad = useCallback(() => {
    setBoot({ state: 'loading' });
    setIdentityLoadAttempt(attempt => attempt + 1);
  }, []);

  const finishOnboarding = useCallback(() => {
    createAndStoreIdentity(getIdentityPhrase())
      .then(identity => setBoot({ state: 'ready', identity }))
      .catch(error =>
        Alert.alert('Could not protect identity', readError(error)),
      );
  }, []);

  return (
    <GestureHandlerRootView style={styles.flex}>
      <SafeAreaProvider>
        <StatusBar
          barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
          backgroundColor={pal.bg}
        />
        {__DEV__ && FIELD_GROUP_LAB ? (
          <PerfProfiler>
            <FieldGroupLab />
          </PerfProfiler>
        ) : MOTION_LAB ? (
          <MotionLab />
        ) : boot.state === 'loading' ? (
          <View style={[styles.loading, { backgroundColor: pal.bg }]}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>
              OPENING CANTOR
            </Text>
          </View>
        ) : boot.state === 'identity-error' ? (
          <View style={[styles.identityError, { backgroundColor: pal.bg }]}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>IDENTITY LOCKED</Text>
            <Text style={[type.title, { color: pal.ink }]}>Could not open identity</Text>
            <Text style={[type.body, { color: pal.muted }]}>{boot.message}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry identity load"
              onPress={retryIdentityLoad}
              style={[styles.retry, { borderColor: pal.ink }]}>
              <Text style={[type.mono, { color: pal.ink }]}>Retry</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {boot.state === 'ready' ? (
              <PerfProfiler>
                <FieldScreen identity={boot.identity} />
              </PerfProfiler>
            ) : (
              <View style={[styles.flex, { backgroundColor: pal.bg }]} />
            )}
            {boot.state === 'onboarding' ? (
              <Onboarding
                onDone={finishOnboarding}
                onRestored={identity => setBoot({ state: 'ready', identity })}
              />
            ) : null}
          </>
        )}
        {PERF_HUD ? <PerfHud /> : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  identityError: {
    flex: 1,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  retry: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
    marginTop: space.sm,
    borderWidth: 1,
  },
});
