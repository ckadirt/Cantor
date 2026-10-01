import { NativeEventEmitter, NativeModules } from 'react-native';
import { createStore, type Store } from '../core/store';

/**
 * Whether this phone has a connection at all (`CantorNetworkModule.kt`).
 *
 * `null` until the first answer, and always `null` where the module is
 * missing (Jest, an old build): an unknown connection is never said to be
 * missing, because "no connection" changes what the whole field shows.
 */
export const network: Store<boolean | null> = createStore<boolean | null>(
  null,
);

type NativeNetwork = {
  current: () => Promise<boolean>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
};

const EVENT = 'CantorNetworkChanged';

/** Follow the phone's connection into `network` until the returned call. */
export function followNetwork(store: Store<boolean | null> = network): () => void {
  const native = NativeModules.CantorNetwork as NativeNetwork | undefined;
  if (native === undefined) return () => {};
  let live = true;
  native
    .current()
    .then(online => {
      if (live) store.set(() => online);
    })
    .catch(() => {});
  const emitter = new NativeEventEmitter(
    native as unknown as ConstructorParameters<typeof NativeEventEmitter>[0],
  );
  const subscription = emitter.addListener(EVENT, (event: { online?: unknown }) => {
    if (typeof event?.online === 'boolean') {
      const online = event.online;
      store.set(() => online);
    }
  });
  return () => {
    live = false;
    subscription.remove();
  };
}
