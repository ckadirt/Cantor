import { useEffect, useRef, useState } from 'react';
import type { SkPath } from '@shopify/react-native-skia';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import type { Group } from '../../field';
import { nativeMedia } from '../../device/native';
import { COVER_KNOBS, coverArtOf, type CoverArt } from '../../lenses/cover';
import type { FieldPresentation } from './useFieldController';
import { MAP_KNOBS, hubCoverPath } from './nativeMap';

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

/**
 * Album covers at the map, as halftone paths by art file — made once from the
 * album's small cached thumbnail, like the player's cover, and never stored.
 * Coarser than the player's: a hub is a few marks wide.
 */
const hubPaths = new Map<string, SkPath | null>();

const hubFromPhone: CoverSource = async file => {
  const luma = await nativeMedia.artworkLuma(file, MAP_KNOBS.HUB_CELLS);
  return luma === null ? null : coverArtOf(luma, MAP_KNOBS.HUB_CELLS);
};

/** The art file a hub group's cover comes from: its first song that has one. */
export function hubArtwork(
  group: Group,
  presentations: ReadonlyMap<string, FieldPresentation>,
): string | null {
  for (const entityKey of group.entityKeys) {
    const presentation = presentations.get(entityKey);
    if (presentation?.source !== 'device') continue;
    const file = presentation.album?.artwork ?? null;
    if (file !== null) return file;
  }
  return null;
}

/**
 * Every hub group's cover, by group key, as a shared value: covers land one by
 * one after the field is drawn, and each landing must not hand `Canvas` a new
 * element (the Flicker Law, `nativeScene`). A group with no art keeps an
 * empty middle.
 */
export function useHubCovers(
  groups: readonly Group[],
  presentations: ReadonlyMap<string, FieldPresentation>,
  source: CoverSource = hubFromPhone,
): SharedValue<Readonly<Record<string, SkPath>>> {
  const candidate = useSharedValue<Readonly<Record<string, SkPath>>>({});
  // Native shared values are stable; the Jest mock is not.
  const shared = useRef(candidate).current;
  const wanted = groups.flatMap(group => {
    if (group.hub === null) return [];
    const file = hubArtwork(group, presentations);
    return file === null ? [] : [[group.key, file] as const];
  });
  const signature = wanted
    .map(([key, file]) => `${key}\u0000${file}`)
    .join('\u0001');
  useEffect(() => {
    let active = true;
    const publish = () => {
      const next: Record<string, SkPath> = {};
      for (const [key, file] of wanted) {
        const path = hubPaths.get(file);
        if (path != null) next[key] = path;
      }
      shared.value = next;
    };
    publish();
    (async () => {
      for (const [, file] of wanted) {
        if (hubPaths.has(file)) continue;
        const art = await source(file).catch(() => null);
        if (!active) return;
        hubPaths.set(file, art === null ? null : hubCoverPath(art, 1));
        publish();
      }
    })();
    return () => {
      active = false;
    };
    // `wanted` is read through its signature: the same covers for the same
    // groups are the same request, whatever object carried them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, shared, source]);
  return shared;
}
