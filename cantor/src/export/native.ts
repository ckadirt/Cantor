import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { Cover } from './cover';

/**
 * The bridge to `CantorExport` (Kotlin `export/CantorExportModule.kt`): stage a
 * file to send, share it, save a public copy, and check copies still exist.
 * Values are checked here; decisions are the service's.
 */
export type StagedFile = Readonly<{ path: string; bytes: number }>;

export type SavedCopy = Readonly<{
  uri: string;
  mediaId: number | null;
  path: string | null;
}>;

export type ExportPort = Readonly<{
  stageOpus(request: {
    source: string;
    key: string;
    name: string;
    comments: readonly (readonly [string, string])[];
    cover: Cover | null;
  }): Promise<StagedFile>;
  share(path: string, mime: string): Promise<void>;
  save(
    path: string,
    mime: string,
    destination: 'music' | 'download',
    replace: string | null,
  ): Promise<SavedCopy>;
  present(uris: readonly string[]): Promise<boolean[]>;
  prune(maxBytes: number): Promise<number>;
  /**
   * Whether this phone may write a public copy. Android 10 and later need no
   * permission for files an app makes through MediaStore; 7 to 9 ask once.
   */
  canWrite(): Promise<boolean>;
}>;

type CantorExportNative = {
  stageOpus(
    source: string,
    key: string,
    name: string,
    comments: string[][],
    cover: Cover | null,
  ): Promise<unknown>;
  share(path: string, mime: string): Promise<unknown>;
  save(
    path: string,
    mime: string,
    destination: string,
    replace: string | null,
  ): Promise<unknown>;
  present(uris: string[]): Promise<unknown>;
  prune(maxBytes: number): Promise<unknown>;
};

function module(): CantorExportNative {
  const candidate = NativeModules.CantorExport as
    | CantorExportNative
    | null
    | undefined;
  if (candidate === null || candidate === undefined) {
    throw new Error('The native Cantor export module is unavailable.');
  }
  return candidate;
}

export const nativeExport: ExportPort = {
  async stageOpus({ source, key, name, comments, cover }) {
    const value = record(
      await module().stageOpus(
        source,
        key,
        name,
        comments.map(([k, v]) => [k, v]),
        cover,
      ),
    );
    return { path: text(value.path, 'path'), bytes: number(value.bytes, 'bytes') };
  },
  async share(path, mime) {
    await module().share(path, mime);
  },
  async save(path, mime, destination, replace) {
    const value = record(await module().save(path, mime, destination, replace));
    return {
      uri: text(value.uri, 'uri'),
      mediaId:
        value.mediaId === null || value.mediaId === undefined
          ? null
          : number(value.mediaId, 'mediaId'),
      path:
        value.path === null || value.path === undefined
          ? null
          : text(value.path, 'path'),
    };
  },
  async present(uris) {
    const value = await module().present([...uris]);
    if (!Array.isArray(value) || value.length !== uris.length) {
      throw new Error('Native export presence is malformed.');
    }
    return value.map(item => item === true);
  },
  async prune(maxBytes) {
    return number(await module().prune(maxBytes), 'pruned');
  },
  async canWrite() {
    if (Platform.OS !== 'android' || Platform.Version >= 29) return true;
    const permission = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
    if (await PermissionsAndroid.check(permission)) return true;
    return (
      (await PermissionsAndroid.request(permission)) ===
      PermissionsAndroid.RESULTS.GRANTED
    );
  },
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Native export result is not an object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Native export ${name} is invalid.`);
  }
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Native export ${name} is invalid.`);
  }
  return value;
}
