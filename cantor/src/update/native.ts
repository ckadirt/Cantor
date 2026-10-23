import { NativeEventEmitter, NativeModules } from 'react-native';

/**
 * The phone's side of updating (`update/CantorUpdateModule.kt`): what is
 * installed, downloading and proving an APK, and handing it to Android's
 * installer. `null` where the module is missing (Jest, an older build).
 */
export type Installed = Readonly<{
  applicationId: string;
  versionCode: number;
  versionName: string;
}>;

export type InstallEvent = Readonly<{
  status: 'confirm' | 'installed' | 'cancelled' | 'failed';
  message?: string;
}>;

export type NativeUpdate = Readonly<{
  current: () => Promise<Installed>;
  canInstall: () => Promise<boolean>;
  allowInstall: () => Promise<boolean>;
  download: (url: string, sha256: string, bytes: number) => Promise<string>;
  cancel: () => Promise<boolean>;
  verify: (path: string) => Promise<{ versionCode: number; versionName: string }>;
  install: (path: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  onProgress: (listener: (received: number, total: number) => void) => () => void;
  onInstall: (listener: (event: InstallEvent) => void) => () => void;
}>;

type Module = Omit<NativeUpdate, 'onProgress' | 'onInstall'> & {
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
};

export function nativeUpdate(): NativeUpdate | null {
  const native = NativeModules.CantorUpdate as Module | undefined;
  if (native === undefined) return null;
  const emitter = new NativeEventEmitter(
    native as unknown as ConstructorParameters<typeof NativeEventEmitter>[0],
  );
  return {
    current: () => native.current(),
    canInstall: () => native.canInstall(),
    allowInstall: () => native.allowInstall(),
    download: (url, sha256, bytes) => native.download(url, sha256, bytes),
    cancel: () => native.cancel(),
    verify: path => native.verify(path),
    install: path => native.install(path),
    clear: () => native.clear(),
    onProgress: listener => {
      const subscription = emitter.addListener(
        'CantorUpdateProgress',
        (event: { received?: unknown; total?: unknown }) => {
          if (typeof event?.received === 'number' && typeof event?.total === 'number') {
            listener(event.received, event.total);
          }
        },
      );
      return () => subscription.remove();
    },
    onInstall: listener => {
      const subscription = emitter.addListener(
        'CantorUpdateInstall',
        (event: { status?: unknown; message?: unknown }) => {
          const status = event?.status;
          if (status === 'confirm' || status === 'installed' || status === 'cancelled' || status === 'failed') {
            listener({
              status,
              ...(typeof event.message === 'string' ? { message: event.message } : {}),
            });
          }
        },
      );
      return () => subscription.remove();
    },
  };
}
