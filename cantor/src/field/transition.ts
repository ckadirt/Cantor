import type { Placement } from './types';

/**
 * How one visual owner participates when an entity family changes size.
 * A branch has one owner at the coincident source pose, then reveals sibling
 * copies as their paths separate. A fold removes surplus owners before they
 * converge. That one-owner-at-overlap rule prevents duplicate-dark flashes.
 */
export type FlightOwnership =
  | 'carry'
  | 'branch'
  | 'fold'
  | 'enter'
  | 'exit';

/** KNOBS — ownership handoff windows on the shared 0..1 re-cut clock. */
export const FIELD_TRANSITION_KNOBS = {
  BRANCH_REVEAL_START: 0.02,
  BRANCH_REVEAL_END: 0.18,
  FOLD_RELEASE_START: 0.55,
  FOLD_RELEASE_END: 0.82,
  ENTER_START: 0.08,
  ENTER_END: 0.42,
  EXIT_START: 0.58,
  EXIT_END: 0.9,
} as const;

/**
 * A placement with both endpoint ownership values.
 *
 * Position and bloom endpoints reuse Placement's existing from/target fields;
 * alpha is separate because a playlist re-cut can change how many visible
 * copies one entity owns.
 */
export type PlacementFlight = Placement &
  Readonly<{
    fromAlpha: number;
    targetAlpha: number;
    ownership: FlightOwnership;
    targetPlacementKey: string | null;
  }>;

/**
 * Plan the visual correspondence for one re-cut.
 *
 * Exact placement identities win, then the closest remaining copy of the same
 * entity. Missing source/target family members are invisible alignment copies:
 * one mark can fan out into several playlist memberships, and several can fold
 * into one date mark, without a duplicate-dark endpoint or an ownership gap.
 */
export function planPlacementFlights(
  before: readonly Placement[],
  after: readonly Placement[],
  generation: number,
): readonly PlacementFlight[] {
  const beforeByEntity = groupByEntity(before);
  const afterByEntity = groupByEntity(after);
  const entityKeys = new Set([
    ...beforeByEntity.keys(),
    ...afterByEntity.keys(),
  ]);
  const result: PlacementFlight[] = [];

  for (const entityKey of [...entityKeys].sort()) {
    const sources = [...(beforeByEntity.get(entityKey) ?? [])].sort(byKey);
    const targets = [...(afterByEntity.get(entityKey) ?? [])].sort(byKey);
    result.push(...planEntity(sources, targets, generation));
  }
  return result;
}

/** The currently drawn value of one placement flight. */
export function placementFlightAt(
  placementFlight: PlacementFlight,
  progress: number,
): Placement {
  const t = clamp01(progress);
  return {
    ...placementFlight,
    x: lerp(placementFlight.fromX, placementFlight.targetX, t),
    y: lerp(placementFlight.fromY, placementFlight.targetY, t),
    bloomX: lerp(placementFlight.fromBloomX, placementFlight.targetBloomX, t),
    bloomY: lerp(placementFlight.fromBloomY, placementFlight.targetBloomY, t),
    opacity: ownershipAlphaAt(
      placementFlight.ownership,
      placementFlight.fromAlpha,
      placementFlight.targetAlpha,
      t,
    ),
    targetPlacementKey: placementFlight.targetPlacementKey,
  };
}

/** Alpha for one ownership handoff, with zero velocity at each window edge. */
export function ownershipAlphaAt(
  ownership: FlightOwnership,
  fromAlpha: number,
  targetAlpha: number,
  progress: number,
): number {
  const t = clamp01(progress);
  switch (ownership) {
    case 'branch':
      return lerp(
        fromAlpha,
        targetAlpha,
        windowedSmootherstep(
          t,
          FIELD_TRANSITION_KNOBS.BRANCH_REVEAL_START,
          FIELD_TRANSITION_KNOBS.BRANCH_REVEAL_END,
        ),
      );
    case 'fold':
      return lerp(
        fromAlpha,
        targetAlpha,
        windowedSmootherstep(
          t,
          FIELD_TRANSITION_KNOBS.FOLD_RELEASE_START,
          FIELD_TRANSITION_KNOBS.FOLD_RELEASE_END,
        ),
      );
    case 'enter':
      return lerp(
        fromAlpha,
        targetAlpha,
        windowedSmootherstep(
          t,
          FIELD_TRANSITION_KNOBS.ENTER_START,
          FIELD_TRANSITION_KNOBS.ENTER_END,
        ),
      );
    case 'exit':
      return lerp(
        fromAlpha,
        targetAlpha,
        windowedSmootherstep(
          t,
          FIELD_TRANSITION_KNOBS.EXIT_START,
          FIELD_TRANSITION_KNOBS.EXIT_END,
        ),
      );
    case 'carry':
      return lerp(fromAlpha, targetAlpha, t);
  }
}

/** Positive scale interpolation matching the camera's logarithmic zoom. */
export function interpolatePositiveScale(
  from: number,
  to: number,
  progress: number,
): number {
  if (!(from > 0) || !(to > 0)) return to;
  return Math.exp(lerp(Math.log(from), Math.log(to), clamp01(progress)));
}

function planEntity(
  sources: readonly Placement[],
  targets: readonly Placement[],
  generation: number,
): readonly PlacementFlight[] {
  if (sources.length === 0) {
    return targets.map(target =>
      flight(target, target, 0, 1, 'enter', target.key),
    );
  }
  if (targets.length === 0) {
    return sources.map((source, index) =>
      flight(
        source,
        source,
        alphaOf(source),
        0,
        'exit',
        null,
        exitKey(generation, source, index),
      ),
    );
  }

  const unused = [...sources];
  const usedSources = new Set<Placement>();
  const flights: PlacementFlight[] = [];

  for (const target of targets) {
    let sourceIndex = unused.findIndex(source => source.key === target.key);
    if (sourceIndex < 0) sourceIndex = closestIndex(unused, target);
    const source =
      sourceIndex >= 0
        ? unused.splice(sourceIndex, 1)[0]
        : closest(sources, target);
    const ownsSource = !usedSources.has(source);
    usedSources.add(source);
    flights.push(
      flight(
        source,
        target,
        ownsSource ? alphaOf(source) : 0,
        1,
        ownsSource ? 'carry' : 'branch',
        target.key,
      ),
    );
  }

  // More sources than targets: keep every outgoing owner alive while it folds
  // into the closest destination, then fade only the alignment copies.
  unused.forEach((source, index) => {
    const target = closest(targets, source);
    flights.push(
      flight(
        source,
        target,
        alphaOf(source),
        0,
        'fold',
        null,
        exitKey(generation, source, index),
      ),
    );
  });
  return flights;
}

function flight(
  source: Placement,
  target: Placement,
  fromAlpha: number,
  targetAlpha: number,
  ownership: FlightOwnership,
  targetPlacementKey: string | null,
  key = target.key,
): PlacementFlight {
  return {
    ...target,
    key,
    fromX: source.x,
    fromY: source.y,
    fromBloomX: source.bloomX,
    fromBloomY: source.bloomY,
    targetX: target.x,
    targetY: target.y,
    targetBloomX: target.bloomX,
    targetBloomY: target.bloomY,
    fromAlpha,
    targetAlpha,
    ownership,
    opacity: fromAlpha,
    targetPlacementKey,
  };
}

function groupByEntity(
  placements: readonly Placement[],
): ReadonlyMap<string, Placement[]> {
  const result = new Map<string, Placement[]>();
  for (const placement of placements) {
    const group = result.get(placement.entityKey) ?? [];
    group.push(placement);
    result.set(placement.entityKey, group);
  }
  return result;
}

function closestIndex(
  candidates: readonly Placement[],
  target: Placement,
): number {
  if (candidates.length === 0) return -1;
  let best = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareDistance(candidates[index], candidates[best], target) < 0) {
      best = index;
    }
  }
  return best;
}

function closest(
  candidates: readonly Placement[],
  target: Placement,
): Placement {
  return candidates[closestIndex(candidates, target)];
}

function compareDistance(
  left: Placement,
  right: Placement,
  target: Placement,
): number {
  const leftDistance = distanceSquared(left, target);
  const rightDistance = distanceSquared(right, target);
  return leftDistance - rightDistance || left.key.localeCompare(right.key);
}

function distanceSquared(left: Placement, right: Placement): number {
  const dx = left.x + left.bloomX - (right.x + right.bloomX);
  const dy = left.y + left.bloomY - (right.y + right.bloomY);
  return dx * dx + dy * dy;
}

function alphaOf(placement: Placement): number {
  return clamp01(placement.opacity ?? 1);
}

function exitKey(generation: number, source: Placement, index: number): string {
  return JSON.stringify(['exit', generation, source.key, index]);
}

function byKey(left: Placement, right: Placement): number {
  return left.key.localeCompare(right.key);
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

function windowedSmootherstep(value: number, start: number, end: number): number {
  const t = clamp01((value - start) / (end - start));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
