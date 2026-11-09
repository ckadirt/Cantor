import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStore } from '../core/store';
import {
  isExportFormat,
  type ExportDestination,
  type ExportFormat,
} from './types';

/**
 * What this phone remembers about taking songs out: the last format chosen and
 * where saved copies go.
 *
 * A storage key is a compatibility contract: `v` is checked, and a value this
 * build cannot read is the defaults rather than an error, because a preference
 * that cannot be read is no reason to fail a share.
 */
const EXPORT_KEY = 'cantor.export.v1';

export type ExportPreferences = Readonly<{
  format: ExportFormat;
  destination: ExportDestination;
}>;

/**
 * MP3, because it plays anywhere; the service steps down to a format this
 * build or this song can make. Saves go to `Music/Cantor`.
 */
export const DEFAULT_EXPORT_PREFERENCES: ExportPreferences = {
  format: 'mp3',
  destination: { kind: 'music' },
};

/**
 * The preferences in force, shared by the song sheet and Settings: Settings
 * changes them on its Save, and every open sheet follows at once.
 */
export const exportPreferences = createStore<ExportPreferences>(
  DEFAULT_EXPORT_PREFERENCES,
);

/** Read the stored preferences into the store; never throws. */
export async function restoreExportPreferences(): Promise<void> {
  const stored = await loadExportPreferences();
  exportPreferences.set(current =>
    samePreferences(current, stored) ? current : stored,
  );
}

/** Takes effect at once; persisted for the next launch. */
export async function chooseExportPreferences(
  next: ExportPreferences,
): Promise<void> {
  exportPreferences.set(current =>
    samePreferences(current, next) ? current : next,
  );
  await saveExportPreferences(next);
}

export function samePreferences(
  a: ExportPreferences,
  b: ExportPreferences,
): boolean {
  return a.format === b.format && sameDestination(a.destination, b.destination);
}

export function sameDestination(
  a: ExportDestination,
  b: ExportDestination,
): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'tree' || (b.kind === 'tree' && a.uri === b.uri);
}

export async function loadExportPreferences(): Promise<ExportPreferences> {
  try {
    const raw = await AsyncStorage.getItem(EXPORT_KEY);
    return raw === null
      ? DEFAULT_EXPORT_PREFERENCES
      : parseExportPreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_EXPORT_PREFERENCES;
  }
}

export async function saveExportPreferences(
  preferences: ExportPreferences,
): Promise<void> {
  await AsyncStorage.setItem(
    EXPORT_KEY,
    JSON.stringify({ v: 1, ...preferences }),
  );
}

/** A stored value, read field by field; anything unreadable is its default. */
export function parseExportPreferences(value: unknown): ExportPreferences {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_EXPORT_PREFERENCES;
  }
  const stored = value as Record<string, unknown>;
  if (stored.v !== 1) return DEFAULT_EXPORT_PREFERENCES;
  return {
    format: isExportFormat(stored.format)
      ? stored.format
      : DEFAULT_EXPORT_PREFERENCES.format,
    destination:
      parseDestination(stored.destination) ??
      DEFAULT_EXPORT_PREFERENCES.destination,
  };
}

function parseDestination(value: unknown): ExportDestination | null {
  if (typeof value !== 'object' || value === null) return null;
  const stored = value as Record<string, unknown>;
  switch (stored.kind) {
    case 'music':
      return { kind: 'music' };
    case 'download':
      return { kind: 'download' };
    case 'tree':
      return typeof stored.uri === 'string' &&
        stored.uri.length > 0 &&
        typeof stored.name === 'string' &&
        stored.name.length > 0
        ? { kind: 'tree', uri: stored.uri, name: stored.name }
        : null;
    default:
      return null;
  }
}
