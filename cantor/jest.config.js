module.exports = {
  preset: '@react-native/jest-preset',
  // Skia's jest env loads real CanvasKit (wasm), so geometry code actually
  // runs in tests; its jestSetup swaps the native module for the wasm one.
  testEnvironment: '@shopify/react-native-skia/jestEnv.js',
  setupFiles: [
    './node_modules/react-native-gesture-handler/jestSetup.js',
    './node_modules/@shopify/react-native-skia/jestSetup.js',
  ],
  // reanimated's worklets runtime needs native modules; use the official mock
  moduleNameMapper: {
    '^react-native-reanimated$': 'react-native-reanimated/mock',
    '^react-native-worklets$': 'react-native-worklets/src/mock',
    '^@react-native-clipboard/clipboard$':
      '@react-native-clipboard/clipboard/jest/clipboard-mock.js',
    '\\.(ttf|otf)$': '<rootDir>/jest/assetStub.js',
  },
  // react-navigation and friends ship untranspiled ESM; @scure/@noble are ESM-only
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-screens|react-native-safe-area-context|react-native-reanimated|react-native-worklets|react-native-gesture-handler|@shopify/react-native-skia|moti|@scure|@noble)/)',
  ],
};
