/**
 * The library's own mock, plus the hooks it leaves out.
 *
 * `react-native-reanimated/src/mock.ts` carries a literal
 * `// useReducedMotion: ADD ME IF NEEDED`, so anything that respects the
 * reduced-motion preference cannot render under Jest without this. Motion
 * itself is never verified here — see cantor/AGENTS.md — but the code paths
 * around it still have to mount.
 */
const reanimated = require('react-native-reanimated/mock');

module.exports = {
  ...reanimated,
  // Tests exercise the full-motion path; reduced motion is a device pass.
  useReducedMotion: () => false,
};
