import {
  SEAL_KNOBS,
  SEAL_MASKS,
  sealDotAt,
  sealDotRadius,
  sealLoudness,
  sealModel,
  sealSeed,
  sealSound,
} from '../seal';

const recipe = {
  seed: 1000,
  id: 'song-a',
  model: 'acestep-1.5-quality',
  durationMs: 134000,
};

function bits(mask: number): number {
  let count = 0;
  // eslint-disable-next-line no-bitwise
  for (let cell = 0; cell < 9; cell += 1) count += (mask >> cell) & 1;
  return count;
}

describe('the masks', () => {
  it('keeps the 102 symmetric patterns of five to seven dots', () => {
    expect(SEAL_MASKS).toHaveLength(102);
    for (const mask of SEAL_MASKS) {
      expect(bits(mask)).toBeGreaterThanOrEqual(SEAL_KNOBS.MIN_DOTS);
      expect(bits(mask)).toBeLessThanOrEqual(SEAL_KNOBS.MAX_DOTS);
    }
    // The carpet's ring is not in range, but the classic dust's corners plus
    // the centre is: 101/010/101.
    expect(SEAL_MASKS).toContain(0b101010101);
  });
});

describe('sealModel', () => {
  it('is the same seal for the same recipe, on every call', () => {
    expect(sealModel(recipe)).toBe(sealModel({ ...recipe }));
    const fresh = sealModel({ ...recipe, id: 'other-id' });
    // The seed wins over the id, as it does for the face.
    expect(fresh.masks).toEqual(sealModel(recipe).masks);
  });

  it('nests three levels, each dot inside its parent', () => {
    const model = sealModel(recipe);
    expect(model.levels).toHaveLength(SEAL_KNOBS.SONG_DEPTH + 1);
    expect(model.levels[0].x).toEqual([0]);
    let expected = 1;
    for (let depth = 1; depth <= SEAL_KNOBS.SONG_DEPTH; depth += 1) {
      const level = model.levels[depth];
      const above = model.levels[depth - 1];
      expected *= bits(model.masks[depth - 1]);
      expect(level.x).toHaveLength(expected);
      const parentCell = 1 / 3 ** (depth - 1);
      level.x.forEach((x, index) => {
        const parent = level.parent[index];
        expect(Math.abs(x - above.x[parent])).toBeLessThan(parentCell / 2);
        expect(Math.abs(level.y[index] - above.y[parent])).toBeLessThan(
          parentCell / 2,
        );
        expect(Math.abs(x)).toBeLessThan(0.5);
      });
    }
  });

  it('orders the deepest dots in time as a permutation, walking between neighbours', () => {
    const model = sealModel(recipe);
    const deepest = model.levels[SEAL_KNOBS.SONG_DEPTH];
    const order = model.order;
    expect([...order].sort((a, b) => a - b)).toEqual(
      deepest.x.map((_, index) => index),
    );
    // Peano's order: most consecutive pairs are one cell apart. The rest are
    // the jumps across cells the seal removed.
    const cell = 1 / 27;
    let neighbours = 0;
    for (let k = 1; k < order.length; k += 1) {
      const dx = Math.abs(deepest.x[order[k]] - deepest.x[order[k - 1]]);
      const dy = Math.abs(deepest.y[order[k]] - deepest.y[order[k - 1]]);
      if (Math.abs(dx + dy - cell) < 1e-9) neighbours += 1;
    }
    expect(neighbours / (order.length - 1)).toBeGreaterThan(0.5);
  });

  it('gives different songs different seals', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const model = sealModel({
        seed: index * 7919,
        id: `song-${index}`,
        model: 'acestep-1.5-turbo',
        durationMs: 60000 + index * 1000,
      });
      seen.add(`${model.masks.join(',')}:${model.orientation}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(199);
  });

  it('lets the duration change the seal, as it changes the face', () => {
    expect(sealSeed(recipe)).not.toBe(
      sealSeed({ ...recipe, durationMs: recipe.durationMs + 1000 }),
    );
  });
});

describe('the sound', () => {
  it('folds the slices onto the dots, in time order', () => {
    const model = sealModel(recipe);
    const count = 729;
    const loudness = new Float32Array(count).map((_, i) => i / (count - 1));
    const sound = sealSound(model, {
      loudness,
      punch: new Float32Array(count).fill(0.25),
      width: new Float32Array(count),
    });
    expect(sound.loudness).toHaveLength(model.order.length);
    expect(sound.punch.every(value => Math.abs(value - 0.25) < 1e-6)).toBe(
      true,
    );
    // A rising song rises along the thread.
    for (let k = 1; k < sound.loudness.length; k += 1) {
      expect(sound.loudness[k]).toBeGreaterThan(sound.loudness[k - 1]);
    }
  });

  it('fills a dot through a soft knee: silence is nothing, full scale is all', () => {
    expect(sealLoudness(0)).toBe(0);
    expect(sealLoudness(1)).toBeCloseTo(1);
    expect(sealLoudness(0.45)).toBeGreaterThan(sealLoudness(0.3) + 0.05);
  });
});

describe('tapping a dot', () => {
  it('answers the dot under the finger with its place in time', () => {
    const model = sealModel(recipe);
    const deepest = model.levels[SEAL_KNOBS.SONG_DEPTH];
    const dot = model.order[17];
    expect(sealDotAt(model, deepest.x[dot], deepest.y[dot])).toBe(17);
    expect(
      sealDotAt(model, deepest.x[dot] + sealDotRadius(3), deepest.y[dot]),
    ).toBe(17);
  });

  it('answers null well away from every dot', () => {
    expect(sealDotAt(sealModel(recipe), 5, 5)).toBeNull();
  });
});
