module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./node_modules/react-native-gesture-handler/jestSetup.js'],
  // reanimated's worklets runtime needs native modules; use the official mock
  moduleNameMapper: {
    '^react-native-reanimated$': 'react-native-reanimated/mock',
    '^react-native-worklets$': 'react-native-worklets/src/mock',
  },
  // react-navigation and friends ship untranspiled ESM
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-screens|react-native-safe-area-context|react-native-reanimated|react-native-worklets|react-native-gesture-handler|@shopify/react-native-skia|moti)/)',
  ],
};
