import type { DeviceLibraryService } from './deviceLibrary';

/** KNOBS */
export const LOOK_AGAIN_KNOBS = {
  /** Coming back to the app this soon after the last look does not look again. */
  DEBOUNCE_MS: 2000,
} as const;

/** The part of React Native's `AppState` used here. */
export type AppStatePort = Readonly<{
  currentState: string;
  addEventListener(
    type: 'change',
    listener: (state: string) => void,
  ): { remove(): void };
}>;

/**
 * Look at the phone's music the way a music player does: once when Cantor
 * opens, and again each time it comes back to the foreground
 * (docs/import/flow-plan.md, I7d). `refresh` does the deciding — nothing
 * without the permission or before music was ever brought in, one native call
 * when nothing changed — so this only says when.
 *
 * Returns the function that stops it.
 */
export function startLookingAgain(
  library: Pick<DeviceLibraryService, 'refresh' | 'checkPermission'>,
  appState: AppStatePort,
  now: () => number,
  report: (error: unknown) => void,
): () => void {
  let last = -Infinity;
  const look = () => {
    if (now() - last < LOOK_AGAIN_KNOBS.DEBOUNCE_MS) return;
    last = now();
    library.refresh().catch(report);
  };
  look();
  let previous = appState.currentState;
  const subscription = appState.addEventListener('change', next => {
    const back = next === 'active' && previous !== 'active';
    previous = next;
    if (!back) return;
    // Settings may have granted or withdrawn the permission meanwhile.
    library.checkPermission().then(look).catch(report);
  });
  return () => subscription.remove();
}
