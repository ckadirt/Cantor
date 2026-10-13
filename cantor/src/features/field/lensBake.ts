import { useCallback, useRef } from 'react';
import {
  runOnJS,
  useAnimatedReaction,
  type SharedValue,
} from 'react-native-reanimated';
import { LENSES, LENS_UI, type LensPlayer } from '../../lenses';
import type { LensClock } from './lensClock';

/**
 * The lenses with a slow layer (`Lens.bake`), by `LENSES` position: the only
 * ones whose key the UI thread watches.
 */
const BAKERS: readonly number[] = LENSES.flatMap((lens, index) =>
  lens.bake !== undefined && LENS_UI[index].bakeKey !== undefined
    ? [index]
    : [],
);

/**
 * Keep every showing lens's slow layer at the playhead.
 *
 * A lens may have a player too costly to rebuild every frame that still
 * changes as the song plays — marbling's settled bath, once a bar. It says
 * which version the playhead needs as an integer (`LensUi.bakeKey`), which
 * this watches on the UI thread; when it changes, the lens rebuilds on the JS
 * thread (`Lens.bake`) and hands the result to its own `drawPlayer` through
 * the player. The renderer never learns what a slow layer is.
 *
 * Only while the lens is showing, so a lens nobody looks at costs nothing.
 * The playhead is read the way `heard` reads it: the player's position.
 */
export function useLensBakes(
  players: readonly (LensPlayer | null)[] | null,
  positionSeconds: SharedValue<number> | null,
  lensClock: LensClock,
): void {
  const current = useRef(players);
  current.current = players;
  const bake = useCallback((lens: number, key: number) => {
    const player = current.current?.[lens] ?? null;
    if (player === null) return;
    LENSES[lens].bake?.(player, key);
  }, []);
  useAnimatedReaction(
    () => {
      const keys: number[] = [];
      for (const lens of BAKERS) {
        const player = players === null ? null : players[lens];
        const showing =
          lens === lensClock.to.value ||
          (lensClock.t.value < 1 && lens === lensClock.from.value);
        const seconds = positionSeconds === null ? 0 : positionSeconds.value;
        const bakeKey = LENS_UI[lens].bakeKey;
        keys.push(
          !showing || player === null || bakeKey === undefined
            ? -1
            : bakeKey(player, seconds),
        );
      }
      return keys;
    },
    (keys, last) => {
      for (let i = 0; i < keys.length; i += 1) {
        if (keys[i] >= 0 && (last === null || last[i] !== keys[i])) {
          runOnJS(bake)(BAKERS[i], keys[i]);
        }
      }
    },
    [players],
  );
}
