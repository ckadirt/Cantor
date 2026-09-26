/**
 * Golden strokes for the player's clock — `PlayerRing`, the guard for R6e.
 *
 * The clock is React Skia nodes, not a draw function, so it cannot be
 * rasterised the way `lensGoldens.test.ts` rasterises the faces (recording a
 * component to a picture does not work under Jest's CanvasKit). What is pinned
 * instead is what the nodes *draw*: every stroke and fill that would leave
 * ink — its path, width, alpha (its own times its group's) and trimmed span. Anything at zero alpha, zero radius or zero length is left
 * out, because it leaves no ink: a port may restructure the nodes, but not
 * what they draw.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Group, Path, type SkPath } from '@shopify/react-native-skia';
import { lensIndex } from '../../../lenses';
import { PlayerRing } from '../NativePlayer';

let mockReduced = false;
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated'),
  useReducedMotion: () => mockReduced,
}));

const CIRCLE = lensIndex('name');
const SEAL = lensIndex('seal');

type Valued<T> = T | { value: T };
const read = <T,>(value: Valued<T> | undefined): T | undefined =>
  value !== null && typeof value === 'object' && 'value' in value
    ? (value as { value: T }).value
    : (value as T | undefined);
const round = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 1e6) / 1e6;

/** FNV-1a of a path's SVG: equal paths, equal hashes, a short snapshot. */
/* eslint-disable no-bitwise -- a hash is inherently bitwise */
function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
/* eslint-enable no-bitwise */

/** Every mark the ring leaves. */
function strokes(t: number, reduced: boolean, from = CIRCLE, to = SEAL) {
  mockReduced = reduced;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <PlayerRing
        radius={150}
        durationSeconds={120}
        positionSeconds={{ value: 40 } as never}
        colour="black"
        lensClock={
          {
            from: { value: from },
            to: { value: to },
            t: { value: t },
            next: { value: -1 },
          } as never
        }
      />,
    );
  });
  const out: string[] = [];
  const walk = (
    node: ReactTestRenderer.ReactTestInstance,
    alpha: number,
  ): void => {
    let own = alpha;
    if (node.type === Group) {
      own = alpha * (read<number>(node.props.opacity) ?? 1);
    }
    if (node.type === Path) {
      const path = read<SkPath>(node.props.path)!;
      const ink = own * (read<number>(node.props.opacity) ?? 1);
      const start = read<number>(node.props.start) ?? 0;
      const end = read<number>(node.props.end) ?? 1;
      const bounds = path.computeTightBounds();
      const empty = bounds.width === 0 && bounds.height === 0;
      if (ink > 0 && end > start && !empty) {
        out.push(
          [
            node.props.style ?? 'fill',
            `w=${round(read<number>(node.props.strokeWidth))}`,
            `a=${round(ink)}`,
            `span=${round(start)}..${round(end)}`,
            `box=${[bounds.x, bounds.y, bounds.width, bounds.height]
              .map(v => round(v))
              .join(',')}`,
            `#${textHash(path.toSVGString())}`,
          ].join(' '),
        );
      }
    }
    for (const child of node.children) {
      if (typeof child !== 'string') walk(child, own);
    }
  };
  walk(renderer.root, 1);
  ReactTestRenderer.act(() => renderer.unmount());
  // Sorted: every mark is the one colour, and marks of one colour composite
  // to the same pixels in any order (`1 − (1 − a)(1 − b)` either way), so the
  // order the nodes happen to be in is not part of what the ring draws.
  return out.sort();
}

describe('golden strokes: the player clock', () => {
  it('circle to seal, every step', () => {
    const frames: Record<string, string[]> = {};
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      frames[`t ${t}`] = strokes(t, false);
    }
    expect(frames).toMatchSnapshot();
  });

  it('circle to seal, reduced motion', () => {
    const frames: Record<string, string[]> = {};
    for (const t of [0, 0.5, 1]) {
      frames[`t ${t}`] = strokes(t, true);
    }
    expect(frames).toMatchSnapshot();
  });

  it('draws the same strokes on a reversed clock', () => {
    for (const reduced of [false, true]) {
      for (const t of [0.2, 0.5, 0.8]) {
        expect(strokes(1 - t, reduced, SEAL, CIRCLE)).toEqual(
          strokes(t, reduced),
        );
      }
    }
  });
});
