import type { SongHeader } from '../../../protocol/SongHeader';

export type LibraryFilter = 'active' | 'favorite' | 'offline' | 'trash';

export type SearchableLibraryRow = {
  song: SongHeader;
  nodeLabels: string[];
  ready: boolean;
};

export function filterLibraryRows<T extends SearchableLibraryRow>(
  rows: T[],
  query: string,
  filter: LibraryFilter,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (filter === 'trash') {
      if (!row.song.trashed) return false;
    } else if (row.song.trashed) {
      return false;
    }
    if (filter === 'favorite' && !row.song.favorite) return false;
    if (filter === 'offline' && row.ready) return false;
    if (needle.length === 0) return true;
    return [
      row.song.title,
      row.song.caption_summary,
      row.song.model,
      ...row.song.tags,
      ...row.nodeLabels,
    ]
      .join('\n')
      .toLocaleLowerCase()
      .includes(needle);
  });
}
