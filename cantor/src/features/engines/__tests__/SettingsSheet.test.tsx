import React from 'react';
import { AppState } from 'react-native';
import * as Renderer from 'react-test-renderer';
import { SettingsSheet } from '../SettingsSheet';

jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
}));

const WORDS = [
  'abandon', 'ability', 'able', 'about', 'above', 'absent',
  'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident',
];

const mockLoad = jest.fn(async () => WORDS);
const mockAuthenticate = jest.fn(async () => {});
jest.mock('../../../identity/secureIdentity', () => ({
  loadStoredPhrase: () => mockLoad(),
}));
jest.mock('../../../identity/recoveryAccess', () => ({
  authenticateRecovery: () => mockAuthenticate(),
  protectRecoveryScreen: async () => {},
}));

let trees: Renderer.ReactTestRenderer[] = [];
afterEach(() => {
  // Unmounting clears the working rule's erase timer before Jest moves on.
  Renderer.act(() => trees.forEach(tree => tree.unmount()));
  trees = [];
});

function render() {
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <SettingsSheet
        visible
        publicKey={'ab'.repeat(32)}
        library={{ songs: 0, placements: 0, playlists: 0 }}
        storage={{ downloadedSongs: 0, downloadedBytes: 0, cachedSongs: 0, cachedBytes: 0 }}
        budgetBytes={0}
        onChangeBudget={() => {}}
      />,
    );
  });
  trees.push(tree);
  return tree;
}

/** The act itself, not the host view it renders, nor the grid that shares its label. */
const byLabel = (tree: Renderer.ReactTestRenderer, label: string) =>
  tree.root.findAll(
    node => typeof node.type !== 'string' && node.props.accessibilityLabel === label,
  )[0];

describe('recovery words', () => {
  beforeEach(() => {
    // The reveal refuses to land in a backgrounded app; Jest's has no state.
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    mockLoad.mockClear();
    mockAuthenticate.mockClear();
  });

  it('reads nothing until the device lock is passed, then reveals', async () => {
    const tree = render();
    const grid = () =>
      tree.root.findAll(
        node =>
          node.props.accessible === true &&
          /^(Twelve|1, )/.test(node.props.accessibilityLabel ?? ''),
      )[0];
    expect(grid().props.accessibilityLabel).toBe('Twelve recovery words, hidden');
    expect(mockLoad).not.toHaveBeenCalled();

    await Renderer.act(async () => {
      byLabel(tree, 'Reveal recovery words').props.onPress();
    });
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(grid().props.accessibilityLabel).toContain('1, abandon');
    expect(grid().props.accessibilityLabel).toContain('12, accident');
  });

  it('survives the trip to the background the device-lock prompt takes', async () => {
    const listeners: ((state: string) => void)[] = [];
    // Replaced by hand rather than spied: React Native's own mock is a
    // `jest.fn`, and restoring a spy on it wipes the subscription it returns.
    const original = AppState.addEventListener;
    AppState.addEventListener = ((_type: string, listener: (state: string) => void) => {
      listeners.push(listener);
      return { remove: () => {} };
    }) as unknown as typeof AppState.addEventListener;
    const setState = (state: string) => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
      listeners.slice().forEach(listener => listener(state));
    };
    // The prompt covers Cantor, and answers before Cantor is resumed.
    mockAuthenticate.mockImplementationOnce(async () => {
      setState('background');
    });
    const tree = render();
    let pending!: Promise<void>;
    await Renderer.act(async () => {
      pending = byLabel(tree, 'Reveal recovery words').props.onPress();
    });
    expect(mockLoad).not.toHaveBeenCalled();
    await Renderer.act(async () => {
      setState('active');
      await pending;
    });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(
      tree.root.findAll(node => node.props.accessible === true &&
        /^1, abandon/.test(node.props.accessibilityLabel ?? '')).length,
    ).toBeGreaterThan(0);
    AppState.addEventListener = original;
  });

  it('keeps the words hidden when authentication is cancelled', async () => {
    mockAuthenticate.mockImplementationOnce(async () => {
      throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    });
    const tree = render();
    await Renderer.act(async () => {
      byLabel(tree, 'Reveal recovery words').props.onPress();
    });
    expect(mockLoad).not.toHaveBeenCalled();
    expect(
      tree.root.findAll(node => node.props.accessibilityLabel === 'Twelve recovery words, hidden').length,
    ).toBeGreaterThan(0);
  });

  it('refuses copy while the words are hidden', () => {
    const tree = render();
    expect(byLabel(tree, 'Copy recovery words').props.onPress).toBeUndefined();
  });
});
