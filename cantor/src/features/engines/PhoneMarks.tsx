import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, Group, Path, type SkPath } from '@shopify/react-native-skia';
import {
  useReducedMotion,
  useSharedValue,
  withTiming,
  useDerivedValue,
} from 'react-native-reanimated';
import { nativeMedia } from '../../device/native';
import { coverArtOf, type CoverArt } from '../../lenses/cover';
import { coverPath } from '../../lenses/coverLens';
import { usePalette } from '../../theme/tokens';

/** KNOBS — covers on the phone's pages (docs/import/flow-plan.md, I7f–I7g). */
export const PHONE_MARK_KNOBS = {
  /** A folder's cover in the label column. */
  FOLDER_CELLS: 12,
  /** The clef while an album is read: 64 px, 20 cells. */
  CLEF_CELLS: 20,
  /**
   * A new album's picture arrives cell by cell, top to bottom: each row this
   * much after the one above, each cell up to `JITTER_MS` later than its row.
   */
  ROW_MS: 14,
  JITTER_MS: 160,
  /** Reduced motion: the new picture replaces the old in one crossfade. */
  CROSSFADE_MS: 260,
  /** Covers kept in memory: one per folder and per album read recently. */
  CACHE: 64,
} as const;

const covers = new Map<string, Promise<CoverArt | null>>();

/**
 * A song's MediaStore thumbnail as cover glyphs. Never written anywhere:
 * kept in memory for the run, as the cover lens keeps nothing.
 */
function coverOf(mediaId: number, cells: number): Promise<CoverArt | null> {
  const key = `${mediaId}:${cells}`;
  let cover = covers.get(key);
  if (cover === undefined) {
    cover = nativeMedia
      .thumbnailLuma(mediaId, cells)
      .then(luma => (luma === null ? null : coverArtOf(luma, cells)))
      .catch(() => null);
    if (covers.size >= PHONE_MARK_KNOBS.CACHE) {
      const oldest = covers.keys().next().value;
      if (oldest !== undefined) covers.delete(oldest);
    }
    covers.set(key, cover);
  }
  return cover;
}

function useCover(mediaId: number | null, cells: number): CoverArt | null {
  const [art, setArt] = useState<CoverArt | null>(null);
  useEffect(() => {
    if (mediaId === null) {
      setArt(null);
      return;
    }
    let live = true;
    coverOf(mediaId, cells).then(next => {
      if (live) setArt(next);
    });
    return () => {
      live = false;
    };
  }, [cells, mediaId]);
  return art;
}

/** The bare grain: a `·` in every cell, for a folder with no picture. */
function grain(cells: number): CoverArt {
  return { cells, levels: new Uint8Array(cells * cells).fill(1) };
}

/**
 * A folder's cover in the summary's label column: its biggest album's
 * thumbnail through the cover lens's glyphs, or the bare grain in faint.
 */
export function FolderCover({
  mediaId,
  size,
  faint = false,
}: {
  mediaId: number | null;
  size: number;
  faint?: boolean;
}) {
  const pal = usePalette();
  const art = useCover(mediaId, PHONE_MARK_KNOBS.FOLDER_CELLS);
  const path = useMemo(
    () => coverPath(art ?? grain(PHONE_MARK_KNOBS.FOLDER_CELLS), size),
    [art, size],
  );
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
        <Path
          color={faint || art === null ? pal.faint : pal.ink}
          path={path}
          strokeCap="round"
          strokeWidth={0.75}
          style="stroke"
        />
      </Group>
    </Canvas>
  );
}

/**
 * The clef while music is brought in: the album being read, as cover glyphs.
 * A new album changes the picture cell by cell, top to bottom with a little
 * jitter — each cell owns its glyph, so nothing crossfades (the Flicker Law).
 * An album with no picture holds the last one. Reduced motion crossfades.
 */
export function ReadingClef({
  mediaId,
  size,
}: {
  mediaId: number | null;
  size: number;
}) {
  const pal = usePalette();
  const reduced = useReducedMotion();
  const cells = PHONE_MARK_KNOBS.CLEF_CELLS;
  const target = useCover(mediaId, cells);
  const [shown, setShown] = useState<CoverArt>(() => grain(cells));
  const [previous, setPrevious] = useState<CoverArt | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const fade = useSharedValue(1);

  useEffect(() => {
    if (target === null) return; // no picture: hold the last
    const from = shownRef.current;
    if (reduced) {
      setPrevious(from);
      setShown(target);
      fade.value = 0;
      fade.value = withTiming(1, { duration: PHONE_MARK_KNOBS.CROSSFADE_MS });
      return;
    }
    // Each cell's moment: its row's, plus its own jitter.
    const at = new Float32Array(cells * cells);
    let end = 0;
    for (let index = 0; index < at.length; index += 1) {
      const row = Math.floor(index / cells);
      at[index] =
        row * PHONE_MARK_KNOBS.ROW_MS +
        Math.random() * PHONE_MARK_KNOBS.JITTER_MS;
      end = Math.max(end, at[index]);
    }
    const start = Date.now();
    let frame = 0;
    const step = () => {
      const elapsed = Date.now() - start;
      const levels = new Uint8Array(from.levels);
      for (let index = 0; index < levels.length; index += 1) {
        if (at[index] <= elapsed) levels[index] = target.levels[index];
      }
      setShown({ cells, levels });
      if (elapsed < end) frame = requestAnimationFrame(step);
      else setShown(target);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cells, fade, reduced, target]);

  const path = useMemo<SkPath>(() => coverPath(shown, size), [shown, size]);
  const before = useMemo<SkPath | null>(
    () => (previous === null ? null : coverPath(previous, size)),
    [previous, size],
  );
  const fadingOut = useDerivedValue(() => 1 - fade.value);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Group transform={[{ translateX: size / 2 }, { translateY: size / 2 }]}>
        {reduced && before !== null ? (
          <Path
            color={pal.ink}
            opacity={fadingOut}
            path={before}
            strokeCap="round"
            strokeWidth={0.75}
            style="stroke"
          />
        ) : null}
        <Path
          color={target === null && mediaId === null ? pal.faint : pal.ink}
          opacity={reduced ? fade : 1}
          path={path}
          strokeCap="round"
          strokeWidth={0.75}
          style="stroke"
        />
      </Group>
    </Canvas>
  );
}
