import { playlistsOf } from '../../playlists/playlists';
import type { Arrangement, ArrangementGroup, FieldEntity } from '../types';

/** The group a song with no playlist belongs to. */
export const UNFILED_LABEL = 'Unfiled';
const UNFILED_KEY = 'unfiled';

/**
 * One group per playlist, and one placement per membership.
 *
 * This is the arrangement the placement model exists for. A song in three
 * playlists is genuinely in three clusters at once — three marks, three
 * positions, one song — which is only expressible because a mark is a
 * `(song, group)` pair rather than a song.
 *
 * Groups merge across backends by normalised name: two nodes that both have a
 * playlist called "Late night" are showing one playlist, and splitting them
 * because the spelling differs would be an implementation detail leaking into
 * the field.
 */
export const byPlaylist: Arrangement = {
  key: 'playlist',
  label: 'Playlist',
  group(entities: readonly FieldEntity[]): readonly ArrangementGroup[] {
    // Keyed by folded name so spellings merge; the first spelling seen wins the
    // label, matching how the rest of the namespace displays names.
    const groups = new Map<string, { label: string; entityKeys: string[] }>();
    const unfiled: string[] = [];

    for (const entity of entities) {
      const memberships = playlistsOf(entity.tags);
      if (memberships.length === 0) {
        unfiled.push(entity.key);
        continue;
      }
      for (const name of memberships) {
        const folded = name.trim().toLocaleLowerCase();
        const existing = groups.get(folded);
        if (existing === undefined) {
          groups.set(folded, { label: name.trim(), entityKeys: [entity.key] });
        } else if (!existing.entityKeys.includes(entity.key)) {
          // A song that names the same playlist twice is in it once.
          existing.entityKeys.push(entity.key);
        }
      }
    }

    const ordered = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([folded, group]) => ({
        key: `${UNFILED_KEY === folded ? 'playlist' : 'p'}:${folded}`,
        label: group.label,
        entityKeys: group.entityKeys as readonly string[],
      }));

    // Unfiled goes last: it is where things have not been put, not a playlist.
    return unfiled.length === 0
      ? ordered
      : [
          ...ordered,
          { key: UNFILED_KEY, label: UNFILED_LABEL, entityKeys: unfiled },
        ];
  },
};
