import React, { useState } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MainScreen } from './src/screens/MainScreen';
import { Onboarding } from './src/onboarding/Onboarding';
import { MotionLab } from './src/dev/MotionLab';
import { usePalette } from './src/theme/tokens';

// Dev workbench for the motion engine (src/dev/MotionLab). Flip to true to
// iterate on shapes/text morphs with the scrubber; never ship it on.
const MOTION_LAB = false;

export default function App() {
  const pal = usePalette();
  const scheme = useColorScheme();
  // in-memory only for now; persistence comes with the real flow
  const [onboarded, setOnboarded] = useState(false);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar
          barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
          backgroundColor={pal.bg}
        />
        {MOTION_LAB ? (
          <MotionLab />
        ) : (
          <>
            <MainScreen />
            {!onboarded && <Onboarding onDone={() => setOnboarded(true)} />}
          </>
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
