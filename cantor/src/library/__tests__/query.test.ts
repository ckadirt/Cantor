import type { SongHeader } from '../../../../protocol/SongHeader';
import { filterLibraryRows, type SearchableLibraryRow } from '../query';

const song = (overrides: Partial<SongHeader> = {}): SongHeader => ({
  id: 'song-a',
  revision: 1,
  title: 'Nocturnal Bolero',
  caption_summary: 'Warm nylon guitar',
  created_at: '2026-08-08T12:00:00Z',
  duration_ms: 15_000,
  model: 'acestep:fast',
  favorite: false,
  tags: ['guitar'],
  trashed: false,
  artifacts: [],
  ...overrides,
});

const row = (
  overrides: Partial<SearchableLibraryRow> = {},
): SearchableLibraryRow => ({
  song: song(),
  nodeLabels: ['studio-node'],
  ready: true,
  ...overrides,
});

test('searches title, caption, tags, model, and node locally', () => {
  const rows = [row()];
  for (const query of ['nocturnal', 'nylon', 'guitar', 'acestep', 'studio']) {
    expect(filterLibraryRows(rows, query, 'active')).toEqual(rows);
  }
  expect(filterLibraryRows(rows, 'missing', 'active')).toEqual([]);
});

test('separates active, favorite, offline, and trash views', () => {
  const active = row();
  const favorite = row({ song: song({ id: 'favorite', favorite: true }) });
  const offline = row({ song: song({ id: 'offline' }), ready: false });
  const trashed = row({ song: song({ id: 'trash', trashed: true }) });
  const rows = [active, favorite, offline, trashed];

  expect(filterLibraryRows(rows, '', 'active')).toHaveLength(3);
  expect(filterLibraryRows(rows, '', 'favorite')).toEqual([favorite]);
  expect(filterLibraryRows(rows, '', 'offline')).toEqual([offline]);
  expect(filterLibraryRows(rows, '', 'trash')).toEqual([trashed]);
});
