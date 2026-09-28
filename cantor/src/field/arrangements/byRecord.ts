import type { Arrangement, ArrangementGroup, FieldEntity } from '../types';

/** The group every generated song sits in on the album and artist axes. */
export const GENERATED_LABEL = 'Generated';
const GENERATED_KEY = 'generated';
/** The group of imported songs whose files name no artist. */
export const UNKNOWN_ARTIST_LABEL = 'Unknown artist';

/**
 * One group per album, as the files' tags and folders say (`device/resolve.ts`
 * builds the key, so two "Greatest Hits" in two folders stay two albums).
 *
 * Only imported songs have an album. Generated songs are not scattered or
 * dropped: they sit together in one group at the end, which is where the
 * things that are not records go — as Unfiled does on the playlist axis.
 */
export const byAlbum: Arrangement = {
  key: 'album',
  label: 'Album',
  group: entities =>
    groupRecords(entities, record => ({
      key: `album:${record.albumKey}`,
      label: record.album,
    })),
};

/**
 * One group per artist, merged by folded name like playlists are: a file
 * tagged `Miles Davis` and one tagged `miles davis` are one artist.
 */
export const byArtist: Arrangement = {
  key: 'artist',
  label: 'Artist',
  group: entities =>
    groupRecords(entities, record => {
      const artist = record.artist?.trim() ?? '';
      return artist === ''
        ? { key: 'artist:', label: UNKNOWN_ARTIST_LABEL }
        : { key: `artist:${artist.toLocaleLowerCase()}`, label: artist };
    }),
};

function groupRecords(
  entities: readonly FieldEntity[],
  groupOf: (
    record: NonNullable<FieldEntity['record']>,
  ) => Readonly<{ key: string; label: string }>,
): readonly ArrangementGroup[] {
  const groups = new Map<string, { label: string; entityKeys: string[] }>();
  const generated: string[] = [];
  for (const entity of entities) {
    if (entity.record === undefined) {
      generated.push(entity.key);
      continue;
    }
    const { key, label } = groupOf(entity.record);
    const existing = groups.get(key);
    // The first spelling seen names the group, as on the playlist axis.
    if (existing === undefined)
      groups.set(key, { label, entityKeys: [entity.key] });
    else existing.entityKeys.push(entity.key);
  }
  const ordered: ArrangementGroup[] = [...groups.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        left.label.localeCompare(right.label) ||
        leftKey.localeCompare(rightKey),
    )
    .map(([key, group]) => ({
      key,
      label: group.label,
      entityKeys: group.entityKeys,
    }));
  return generated.length === 0
    ? ordered
    : [
        ...ordered,
        { key: GENERATED_KEY, label: GENERATED_LABEL, entityKeys: generated },
      ];
}
