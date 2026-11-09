import AsyncStorage from '@react-native-async-storage/async-storage';
import { openTestDatabase } from '../../../jest/nodeSqlite';
import { migrate } from '../../core/storage/sql';
import { DEVICE_MIGRATIONS } from '../../device/schema';
import { createExportCopyRepository } from '../copies';
import {
  DEFAULT_EXPORT_PREFERENCES,
  loadExportPreferences,
  parseExportPreferences,
  saveExportPreferences,
} from '../preferences';
import type { ExportCopy } from '../types';

const copy: ExportCopy = {
  nodeKey: 'rtx',
  songId: 'song-1',
  format: 'opus',
  digest: 'a'.repeat(64),
  mediaId: 41,
  path: '/storage/emulated/0/Music/Cantor/Lanterns.opus',
  uri: 'content://media/external/audio/media/41',
  bytes: 3_600_000,
  savedAtMs: 1_000,
};

async function repository() {
  const db = openTestDatabase();
  await migrate(db, DEVICE_MIGRATIONS);
  return createExportCopyRepository(db);
}

describe('export copies', () => {
  it('keeps one copy per song and format', async () => {
    const copies = await repository();
    await copies.put(copy);
    await copies.put({ ...copy, format: 'mp3', bytes: 7_300_000 });
    await copies.put({ ...copy, songId: 'song-2' });
    expect(await copies.forSong('rtx', 'song-1')).toEqual([
      copy,
      { ...copy, format: 'mp3', bytes: 7_300_000 },
    ]);
    expect(await copies.all()).toHaveLength(3);
  });

  it('replaces a format’s copy in place', async () => {
    const copies = await repository();
    await copies.put(copy);
    const regenerated = { ...copy, digest: 'b'.repeat(64), savedAtMs: 2_000 };
    await copies.put(regenerated);
    expect(await copies.forSong('rtx', 'song-1')).toEqual([regenerated]);
  });

  it('keeps a copy MediaStore has not reached', async () => {
    const copies = await repository();
    const picked = { ...copy, mediaId: null, path: null, uri: 'content://tree/x' };
    await copies.put(picked);
    expect(await copies.forSong('rtx', 'song-1')).toEqual([picked]);
  });

  it('removes one format, or every copy of a song', async () => {
    const copies = await repository();
    await copies.put(copy);
    await copies.put({ ...copy, format: 'mp3' });
    await copies.put({ ...copy, songId: 'song-2' });
    await copies.remove('rtx', 'song-1', 'opus');
    expect((await copies.forSong('rtx', 'song-1')).map(c => c.format)).toEqual(
      ['mp3'],
    );
    await copies.forgetSong('rtx', 'song-1');
    expect(await copies.forSong('rtx', 'song-1')).toEqual([]);
    expect(await copies.forSong('rtx', 'song-2')).toHaveLength(1);
  });
});

describe('export preferences', () => {
  beforeEach(() => AsyncStorage.clear());

  it('starts at MP3 into Music', async () => {
    expect(await loadExportPreferences()).toEqual(DEFAULT_EXPORT_PREFERENCES);
  });

  it('remembers a format and a picked folder', async () => {
    const preferences = {
      format: 'opus' as const,
      destination: {
        kind: 'tree' as const,
        uri: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments',
        name: 'Documents',
      },
    };
    await saveExportPreferences(preferences);
    expect(await loadExportPreferences()).toEqual(preferences);
  });

  it('reads what it cannot understand as the defaults, field by field', () => {
    expect(parseExportPreferences(null)).toEqual(DEFAULT_EXPORT_PREFERENCES);
    expect(parseExportPreferences({ v: 2, format: 'opus' })).toEqual(
      DEFAULT_EXPORT_PREFERENCES,
    );
    expect(
      parseExportPreferences({
        v: 1,
        format: 'flac',
        destination: { kind: 'download' },
      }),
    ).toEqual({ format: 'mp3', destination: { kind: 'download' } });
    expect(
      parseExportPreferences({
        v: 1,
        format: 'wav',
        destination: { kind: 'tree', uri: '' },
      }),
    ).toEqual({ format: 'wav', destination: { kind: 'music' } });
  });

  it('never throws on a corrupt value', async () => {
    await AsyncStorage.setItem('cantor.export.v1', '{not json');
    expect(await loadExportPreferences()).toEqual(DEFAULT_EXPORT_PREFERENCES);
  });
});
