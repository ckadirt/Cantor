import type { Arrangement, ArrangementGroup, FieldEntity } from '../types';

/** The group every generated song sits in on the album axis. */
export const GENERATED_LABEL = 'No album';
const GENERATED_KEY = 'generated';
/** The group of imported songs whose files name no artist. */
export const UNKNOWN_ARTIST_LABEL = 'Unknown artist';
/** An album whose files name more than one artist. */
export const VARIOUS_ARTISTS_LABEL = 'Various artists';
/** The second line of a model credited as an artist. */
export const ENGINE_SUBTITLE = 'Engine';
/** Generated songs whose header names no model (written before it did). */
export const UNKNOWN_MODEL_LABEL = 'Unknown engine';
/** The artist axis's two parts, in the order they are seated. */
export const SECTION_GENERATED = 'Generated';
export const SECTION_IMPORTED = 'Imported';

/**
 * One group per album, as the files' tags and folders say (`device/resolve.ts`
 * builds the key, so two "Greatest Hits" in two folders stay two albums).
 * Each carries its artist, which is what tells those two apart on screen, and
 * keeps its middle for its cover.
 *
 * Only imported songs have an album. Generated songs are not scattered or
 * dropped: they sit together in one group at the end, which is where the
 * things that are not records go — as Unfiled does on the playlist axis.
 */
export const byAlbum: Arrangement = {
  key: 'album',
  label: 'Album',
  group(entities) {
    const albums = groupRecords(entities, record => ({
      key: `album:${record.albumKey}`,
      label: record.album,
    }));
    const byKey = new Map(entities.map(entity => [entity.key, entity]));
    const withArtists = albums.map(group => ({
      ...group,
      subtitle: albumArtist(group.entityKeys, byKey),
      hub: true,
    }));
    const generated = entities
      .filter(entity => entity.record === undefined)
      .map(entity => entity.key);
    return generated.length === 0
      ? withArtists
      : [
          ...withArtists,
          { key: GENERATED_KEY, label: GENERATED_LABEL, entityKeys: generated },
        ];
  },
};

/**
 * One group per artist, merged by folded name like playlists are: a file
 * tagged `Miles Davis` and one tagged `miles davis` are one artist.
 *
 * A generated song's artist is the model that made it, so the engines stand
 * beside the people. They come first, under their own hairline, when the
 * field holds both kinds; the same model on two nodes is one artist, as one
 * musician on two records is.
 */
export const byArtist: Arrangement = {
  key: 'artist',
  label: 'Artist',
  group(entities) {
    const imported = groupRecords(entities, record => {
      const artist = record.artist?.trim() ?? '';
      return artist === ''
        ? { key: 'artist:', label: UNKNOWN_ARTIST_LABEL }
        : { key: `artist:${artist.toLocaleLowerCase()}`, label: artist };
    });
    const models = new Map<string, string[]>();
    for (const entity of entities) {
      if (entity.record !== undefined) continue;
      const model = entity.model?.trim() ?? '';
      const members = models.get(model) ?? [];
      members.push(entity.key);
      models.set(model, members);
    }
    const engines = [...models.entries()]
      .map(([model, entityKeys]) => ({
        key: `model:${model}`,
        label: model === '' ? UNKNOWN_MODEL_LABEL : modelLabel(model),
        entityKeys,
        subtitle: ENGINE_SUBTITLE,
      }))
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.key.localeCompare(right.key),
      );
    const both = engines.length > 0 && imported.length > 0;
    return [
      ...engines.map(group =>
        both ? { ...group, section: SECTION_GENERATED } : group,
      ),
      ...imported.map(group =>
        both ? { ...group, section: SECTION_IMPORTED } : group,
      ),
    ];
  },
};

/**
 * A node's model selector as a name: `acestep:1.5-fast` → `acestep 1.5 fast`.
 * The canvas sets it in capitals with the rest of the chrome.
 */
export function modelLabel(selector: string): string {
  return selector
    .split(/[:_-]/)
    .filter(part => part.length > 0)
    .join(' ');
}

/** The artist an album's files agree on, or what to say when they do not. */
function albumArtist(
  entityKeys: readonly string[],
  byKey: ReadonlyMap<string, FieldEntity>,
): string {
  let found: string | null = null;
  for (const entityKey of entityKeys) {
    const artist = byKey.get(entityKey)?.record?.artist?.trim() ?? '';
    if (artist === '') continue;
    if (found === null) found = artist;
    else if (found.toLocaleLowerCase() !== artist.toLocaleLowerCase()) {
      return VARIOUS_ARTISTS_LABEL;
    }
  }
  return found ?? UNKNOWN_ARTIST_LABEL;
}

/** Imported songs grouped by `groupOf`, alphabetically; generated ones skipped. */
function groupRecords(
  entities: readonly FieldEntity[],
  groupOf: (
    record: NonNullable<FieldEntity['record']>,
  ) => Readonly<{ key: string; label: string }>,
): ArrangementGroup[] {
  const groups = new Map<string, { label: string; entityKeys: string[] }>();
  for (const entity of entities) {
    if (entity.record === undefined) continue;
    const { key, label } = groupOf(entity.record);
    const existing = groups.get(key);
    // The first spelling seen names the group, as on the playlist axis.
    if (existing === undefined)
      groups.set(key, { label, entityKeys: [entity.key] });
    else existing.entityKeys.push(entity.key);
  }
  return [...groups.entries()]
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
}
