import { createStore, type Store } from '../../core/store';
import type { DeviceLibrary } from '../../device/repository';
import type { BackendRuntimeState } from '../../runtime/backendRuntime';
import {
  buildFieldController,
  type FieldController,
} from './useFieldController';

/**
 * The field's projection of the runtime, kept outside React.
 *
 * `FieldScreen` used to read the runtime's whole state and build this during
 * render, so every change the runtime published — a job's progress, about
 * once a second while one runs — re-rendered the whole screen for it. Built
 * here instead, each reader selects the part it draws (`useStore`): the field
 * reads the songs and the entities, which a job tick leaves as the same
 * objects, and only what draws a job reads the jobs.
 */
export type FieldControllerStore = Readonly<{
  store: Store<FieldController>;
  /** Follow the runtime until the returned function is called. */
  connect: () => () => void;
}>;

/**
 * `device` is the phone's own songs (`device/deviceLibrary.ts`), read as a
 * second producer beside the runtime; only its `library` reaches the field, so
 * a scan's progress ticks rebuild nothing.
 */
export function createFieldControllerStore(
  runtime: Store<BackendRuntimeState>,
  device?: Pick<
    Store<Readonly<{ library: DeviceLibrary }>>,
    'get' | 'subscribe'
  >,
  /** Whether the phone is online (`network`); a row waiting says for what. */
  online?: Pick<Store<boolean | null>, 'get' | 'subscribe'>,
): FieldControllerStore {
  let read = runtime.get();
  let deviceRead = device?.get().library;
  let onlineRead = online?.get() ?? null;
  const store = createStore(
    buildFieldController({
      ...read,
      device: deviceRead,
      noConnection: onlineRead === false,
    }),
  );
  const follow = (force = false) => {
    const next = runtime.get();
    const nextDevice = device?.get().library;
    const nextOnline = online?.get() ?? null;
    const same =
      !force &&
      next.backends === read.backends &&
      next.snapshots === read.snapshots &&
      next.localAudio === read.localAudio &&
      next.outbox === read.outbox &&
      next.downloading === read.downloading &&
      next.waiting === read.waiting &&
      nextDevice === deviceRead &&
      nextOnline === onlineRead;
    read = next;
    deviceRead = nextDevice;
    onlineRead = nextOnline;
    // Pairing and errors are not the field's business.
    if (same) return;
    // `buildFieldController` hands back the controller it was given when
    // nothing it holds changed, and the store tells nobody about that.
    store.set(previous =>
      buildFieldController(
        { ...next, device: nextDevice, noConnection: nextOnline === false },
        previous,
      ),
    );
  };
  return {
    store,
    connect: () => {
      // Whatever landed while nobody was following.
      follow(true);
      const stopRuntime = runtime.subscribe(() => follow());
      const stopDevice = device?.subscribe(() => follow());
      const stopOnline = online?.subscribe(() => follow());
      return () => {
        stopRuntime();
        stopDevice?.();
        stopOnline?.();
      };
    },
  };
}
