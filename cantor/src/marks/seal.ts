import { mulberry32 } from '../lenses/face';
import { fnv1a } from './hash';
import type { Point } from './station';

/**
 * KNOBS — this phone's seal: the identity mark ⊛ made personal. A circle with
 * spokes drawn from the phone's public key, and a dot at its centre. Settings'
 * clef (`folio.html` frame `f-set`).
 *
 * Lengths are in units of the circle's radius.
 */
export const PHONE_SEAL_KNOBS = {
  /** Five to eight spokes. */
  MIN_SPOKES: 5,
  SPOKE_CHOICES: 4,
  /** Where every spoke starts: clear of the centre dot. */
  SPOKE_FROM: 2.2 / 14.5,
  /** How long a spoke may be, as a share of the radius. */
  SPOKE_MIN: 0.45,
  SPOKE_RANGE: 0.4,
} as const;

export type PhoneSeal = Readonly<{
  /** Each spoke from its inner end to its outer end. */
  spokes: readonly (readonly [Point, Point])[];
}>;

/** This phone's seal, from its public key. Pure: one key, one seal, anywhere. */
export function phoneSeal(publicKey: string): PhoneSeal {
  const seed = fnv1a(publicKey);
  const random = mulberry32(seed);
  const count =
    PHONE_SEAL_KNOBS.MIN_SPOKES + (seed % PHONE_SEAL_KNOBS.SPOKE_CHOICES);
  const turn = random() * Math.PI * 2;
  const spokes: (readonly [Point, Point])[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = turn + (index * Math.PI * 2) / count;
    const length =
      PHONE_SEAL_KNOBS.SPOKE_MIN + random() * PHONE_SEAL_KNOBS.SPOKE_RANGE;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    spokes.push([
      [x * PHONE_SEAL_KNOBS.SPOKE_FROM, y * PHONE_SEAL_KNOBS.SPOKE_FROM],
      [x * length, y * length],
    ]);
  }
  return { spokes };
}
