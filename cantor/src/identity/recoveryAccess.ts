import { NativeModules } from 'react-native';

type NativeRecovery = {
  setScreenProtected: (enabled: boolean) => Promise<boolean>;
  authenticate: () => Promise<boolean>;
};

function recoveryModule(): NativeRecovery {
  const module = NativeModules.CantorRecovery as NativeRecovery | undefined;
  if (!module) throw new Error('Recovery protection is unavailable. Rebuild the Android app.');
  return module;
}

export async function protectRecoveryScreen(enabled: boolean): Promise<void> {
  await recoveryModule().setScreenProtected(enabled);
}

export async function authenticateRecovery(): Promise<void> {
  await recoveryModule().authenticate();
}
