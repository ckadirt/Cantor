import { useEffect, useState } from 'react';
import { nativeMedia } from '../../device/native';
import { COVER_KNOBS, coverArtOf, type CoverArt } from '../../lenses/cover';
import type { FieldPresentation } from './useFieldController';

/**
 * The covers of the albums opened lately, by art file name — in memory only.
 * The ASCII is never stored (docs/import/plan.md § Decisions 1): a cover is
 * made from the album's thumbnail when it is opened, and a few are kept so
 * stepping back and forth along an album does not ask again.
 */
const KEPT_COVERS = 12;
const covers = new Map<string, CoverArt | null>();

/** Asks the thumbnail for its brightness and makes it glyph levels. */
export type CoverSource = (file: string) => Promise<CoverArt | null>;

const fromPhone: CoverSource = async file => {
  const luma = await nativeMedia.artworkLuma(file, COVER_KNOBS.CELLS);
  return luma === null ? null : coverArtOf(luma, COVER_KNOBS.CELLS);
};

const NO_COVERS: ReadonlyMap<string, CoverArt> = new Map();

/**
 * The cover of the song the player holds, keyed by its entity, for the
 * canvas's `covers`; empty for a song with none. A generated song never has
 * one; an imported song has its album's, when the album has art.
 */
export function useCover(
  focused: FieldPresentation | null,
  source: CoverSource = fromPhone,
): ReadonlyMap<string, CoverArt> {
  const file =
    focused?.source === 'device' ? focused.album?.artwork ?? null : null;
  const key = focused?.entity.key ?? null;
  const [held, setHeld] = useState<{
    key: string;
    covers: ReadonlyMap<string, CoverArt>;
  } | null>(null);

  useEffect(() => {
    if (file === null || key === null) return;
    let active = true;
    const show = (art: CoverArt | null) => {
      if (!active) return;
      setHeld(art === null ? null : { key, covers: new Map([[key, art]]) });
    };
    const kept = covers.get(file);
    if (kept !== undefined) {
      show(kept);
    } else {
      source(file)
        .catch(() => null)
        .then(art => {
          if (covers.size >= KEPT_COVERS) {
            const oldest = covers.keys().next().value;
            if (oldest !== undefined) covers.delete(oldest);
          }
          covers.set(file, art);
          show(art);
        });
    }
    return () => {
      active = false;
    };
  }, [file, key, source]);

  return held !== null && held.key === key && file !== null
    ? held.covers
    : NO_COVERS;
}
