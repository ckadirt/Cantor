import React from 'react';
import { StatusBar } from 'react-native';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SongsProvider, useSongs } from './src/state/songs';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { CreateScreen } from './src/screens/CreateScreen';
import { GeneratingScreen } from './src/screens/GeneratingScreen';
import { SongScreen } from './src/screens/SongScreen';
import { color } from './src/theme/tokens';
import type { RootStackParamList } from './src/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: color.bg,
    card: color.bg,
    text: color.chalk,
    border: color.line,
    primary: color.brass,
  },
};

function Root() {
  const { identity } = useSongs();
  return (
    <Stack.Navigator
      initialRouteName={identity ? 'Library' : 'Onboarding'}
      screenOptions={{ headerShown: false, animation: 'fade' }}>
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="Library" component={LibraryScreen} />
      <Stack.Screen name="Create" component={CreateScreen} />
      <Stack.Screen name="Generating" component={GeneratingScreen} />
      <Stack.Screen name="Song" component={SongScreen} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={color.bg} />
        <SongsProvider>
          <NavigationContainer theme={theme}>
            <Root />
          </NavigationContainer>
        </SongsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
