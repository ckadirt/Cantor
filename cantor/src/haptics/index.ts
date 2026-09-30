import { NativeModules } from 'react-native';

/**
 * The app's haptics, rationed (docs/interfacealpha/folio-steps.md, F7):
 *
 * | Kind | Where |
 * | --- | --- |
 * | `tick` | each step of a dial, a ruler or a scrubbed number |
 * | `click` | a pulled blind crossing its release point |
 * | `confirm` | `Make it`, and a held act completing |
 *
 * Nothing else buzzes. Android's own constants (`CantorHapticsModule.kt`), so
 * they honour the phone's touch-feedback setting. A missing module (Jest, an
 * old build) is silence, never an error.
 */
export type HapticKind = 'tick' | 'click' | 'confirm';

type NativeHaptics = { perform: (kind: HapticKind) => void };

export function haptic(kind: HapticKind): void {
  const native = NativeModules.CantorHaptics as NativeHaptics | undefined;
  try {
    native?.perform(kind);
  } catch {
    // Feedback is never worth failing the gesture it accompanies.
  }
}
