/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';
import App from '../App';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({children}: {children: React.ReactNode}) => children,
  SafeAreaView: ({children}: {children: React.ReactNode}) => children,
}));
jest.mock('../src/onboarding/Onboarding', () => ({
  Onboarding: () => null,
}));

const getGenericPassword = Keychain.getGenericPassword as jest.Mock;
const setGenericPassword = Keychain.setGenericPassword as jest.Mock;

beforeEach(() => {
  getGenericPassword.mockReset().mockResolvedValue(false);
  setGenericPassword.mockClear();
});

test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
});

test('does not enter onboarding when the protected identity cannot be read', async () => {
  getGenericPassword.mockRejectedValueOnce(new Error('Keystore unavailable'));
  let renderer!: ReactTestRenderer.ReactTestRenderer;

  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Could not open identity');
  expect(rendered).toContain('Keystore unavailable');
  expect(setGenericPassword).not.toHaveBeenCalled();

  const retry = renderer.root.findByProps({
    accessibilityLabel: 'Retry identity load',
  });
  await ReactTestRenderer.act(async () => {
    retry.props.onPress();
  });

  expect(getGenericPassword).toHaveBeenCalledTimes(2);
  expect(setGenericPassword).not.toHaveBeenCalled();
});
