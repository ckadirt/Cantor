/** Links the landing and the docs share, in one place. */
export const SITE = {
  /** The install line people copy. cantorfm.com redirects it to the relay's copy. */
  install: 'curl -fsSL https://cantorfm.com/install.sh | sh',
  /**
   * Where the Android app comes from. No APK is published yet: until one is,
   * this is the releases page.
   */
  apk: 'https://github.com/ckadirt/Cantor/releases',
  github: 'https://github.com/ckadirt/Cantor',
} as const;

/** The node's commands, by family, with one line each. */
export const COMMANDS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  ['Running', [
    ['status', 'What the node is doing'],
    ['start', 'Start the node'],
    ['stop', 'Stop it'],
    ['restart', 'Stop, then start'],
    ['logs', 'What it said'],
  ]],
  ['Models', [
    ['pull', 'Download a model'],
    ['list', 'What is installed'],
    ['rm', 'Remove a model'],
    ['backends', 'CPU, CUDA, Metal, Vulkan'],
  ]],
  ['Phones', [
    ['pair', 'Pair a phone'],
    ['pairings', 'Who is paired'],
    ['revoke', 'Unpair a phone'],
    ['rename', 'Name a phone or the node'],
  ]],
  ['Making', [
    ['generate', 'A song from the terminal'],
    ['upgrade', 'The newest node'],
  ]],
];
