import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MainScreen } from './src/screens/MainScreen';
import { Onboarding } from './src/onboarding/Onboarding';
import { MotionLab } from './src/dev/MotionLab';
import { getIdentityPhrase } from './src/identity/mnemonic';
import {
  createAndStoreIdentity,
  loadStoredIdentity,
} from './src/identity/secureIdentity';
import type { AppIdentity } from './src/identity/derive';
import { type, usePalette } from './src/theme/tokens';

// Dev workbench for the motion engine (src/dev/MotionLab). Flip to true to
// iterate on shapes/text morphs with the scrubber; never ship it on.
const MOTION_LAB = false;

type IdentityBoot =
  | { state: 'loading' }
  | { state: 'onboarding' }
  | { state: 'ready'; identity: AppIdentity };

export default function App() {
  const pal = usePalette();
  const scheme = useColorScheme();
  const [boot, setBoot] = useState<IdentityBoot>({ state: 'loading' });

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
          Alert.alert('Could not open identity', readError(error));
          setBoot({ state: 'onboarding' });
        }
      });
    return () => {
      active = false;
    };
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
        {MOTION_LAB ? (
          <MotionLab />
        ) : boot.state === 'loading' ? (
          <View style={[styles.loading, { backgroundColor: pal.bg }]}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>
              OPENING CANTOR
            </Text>
          </View>
        ) : (
          <>
            {boot.state === 'ready' ? (
              <MainScreen identity={boot.identity} />
            ) : (
              <View style={[styles.flex, { backgroundColor: pal.bg }]} />
            )}
            {boot.state === 'onboarding' ? (
              <Onboarding onDone={finishOnboarding} />
            ) : null}
          </>
        )}
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
});
