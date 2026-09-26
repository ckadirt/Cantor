import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../core/useStore';
import type { AppIdentity } from '../identity/derive';
import {
  BackendRuntime as Runtime,
  type BackendRuntimeCommands,
  type BackendRuntimeDependencies,
  type BackendRuntimeState,
} from './backendRuntime';

export * from './backendRuntime';

export type BackendRuntime = {
  state: BackendRuntimeState;
  commands: BackendRuntimeCommands;
  /** The object itself, for readers that select a slice with `useStore`. */
  runtime: Runtime;
};

/**
 * The runtime for this identity, started while the calling component is
 * mounted, and its whole state.
 *
 * Reading the whole state re-renders the caller on every change; a component
 * that needs less should select it from `runtime.store` with `useStore`.
 */
export function useBackendRuntime(
  identity: AppIdentity,
  dependencies: BackendRuntimeDependencies = {},
): BackendRuntime {
  const runtime = useRuntime(identity, dependencies);
  const state = useStore(runtime.store, whole);
  return useMemo(
    () => ({ state, commands: runtime.commands, runtime }),
    [runtime, state],
  );
}

/**
 * The runtime for this identity, started while the calling component is
 * mounted — and nothing of its state. A caller reads what it needs from
 * `runtime.store` with `useStore`, and re-renders only when that changes.
 */
export function useRuntime(
  identity: AppIdentity,
  dependencies: BackendRuntimeDependencies = {},
): Runtime {
  // One runtime for the component's life, as the hook this replaced had one
  // set of connections for it.
  const [runtime] = useState(() => new Runtime(identity, dependencies));
  useEffect(() => {
    runtime.start();
    return () => runtime.dispose();
  }, [runtime]);
  return runtime;
}

function whole<T>(state: T): T {
  return state;
}
