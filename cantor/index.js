/**
 * @format
 */

// Secure entropy polyfill (crypto.getRandomValues → Android SecureRandom).
// Must load before anything that might mint identity material.
import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
