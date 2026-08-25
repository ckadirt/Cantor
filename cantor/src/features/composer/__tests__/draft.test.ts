import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import {
  EMPTY_DRAFT,
  canSubmit,
  describeProblem,
  modelUnion,
  problemsWith,
  toGenerationRequest,
  utf8Bytes,
  type ComposerTarget,
} from '../draft';

const limits: NodeLimits = {
  max_concurrent_jobs: 1,
  max_queued_jobs_per_principal: 4,
  min_song_seconds: 10,
  max_song_seconds: 240,
  max_caption_bytes: 32,
  max_lyrics_bytes: 64,
  max_page_limit: 100,
};

function target(overrides: Partial<ComposerTarget> = {}): ComposerTarget {
  return {
    nodePublicKey: 'node-a',
    label: 'Studio',
    ready: true,
    models: [
      { selector: 'acestep:1.5-fast', family: 'acestep', engine: 'acestep' },
    ],
    limits,
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    ...EMPTY_DRAFT,
    caption: 'a slow piano piece',
    nodePublicKey: 'node-a',
    modelSelector: 'acestep:1.5-fast',
    ...overrides,
  };
}

describe('utf8Bytes', () => {
  it('counts bytes rather than characters', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('café')).toBe(5);
    expect(utf8Bytes('🎵')).toBe(4);
    expect(utf8Bytes('日本語')).toBe(9);
  });
});

describe('modelUnion', () => {
  it('is every model any paired node has, de-duplicated', () => {
    const union = modelUnion([
      target(),
      target({
        nodePublicKey: 'node-b',
        models: [
          { selector: 'levo:2', family: 'levo', engine: 'levo' },
          { selector: 'acestep:1.5-fast', family: 'acestep', engine: 'acestep' },
        ],
      }),
    ]);

    expect(union.map(model => model.selector)).toEqual([
      'acestep:1.5-fast',
      'levo:2',
    ]);
  });

  it('is empty when nothing is paired', () => {
    expect(modelUnion([])).toEqual([]);
  });
});

describe('problemsWith', () => {
  it('accepts a complete draft', () => {
    expect(problemsWith(draft(), [target()])).toEqual([]);
    expect(canSubmit(draft(), [target()])).toBe(true);
  });

  it('needs a node and a model', () => {
    const problems = problemsWith(
      { ...EMPTY_DRAFT, caption: 'something' },
      [target()],
    );

    expect(problems.map(problem => problem.kind)).toEqual([
      'no-node',
      'no-model',
    ]);
  });

  it('reports an offline node without hiding the rest', () => {
    const problems = problemsWith(draft({ caption: '   ' }), [
      target({ ready: false }),
    ]);

    // Both, not just the first: fixing one should not reveal the other.
    expect(problems.map(problem => problem.kind)).toEqual([
      'node-offline',
      'caption-empty',
    ]);
  });

  it('says how to install a model the chosen node does not have', () => {
    const problems = problemsWith(draft({ modelSelector: 'levo:2' }), [
      target(),
    ]);

    expect(describeProblem(problems[0])).toBe(
      'Studio does not have this model. Run: cantor pull levo:2',
    );
  });

  it('measures the caption against the node limit in bytes, not characters', () => {
    // 12 characters, 48 bytes: under a character limit, over the byte limit.
    const problems = problemsWith(draft({ caption: '🎵'.repeat(12) }), [
      target(),
    ]);

    expect(problems[0]).toEqual({
      kind: 'caption-too-long',
      bytes: 48,
      maxBytes: 32,
    });
  });

  it('accepts a caption exactly at the limit', () => {
    expect(problemsWith(draft({ caption: 'a'.repeat(32) }), [target()])).toEqual(
      [],
    );
  });

  it('measures lyrics too, and allows empty lyrics', () => {
    expect(problemsWith(draft({ lyrics: '' }), [target()])).toEqual([]);
    expect(
      problemsWith(draft({ lyrics: 'x'.repeat(65) }), [target()])[0],
    ).toMatchObject({ kind: 'lyrics-too-long', bytes: 65, maxBytes: 64 });
  });

  it.each([
    [9, true],
    [10, false],
    [240, false],
    [241, true],
  ])('duration %p out of range: %p', (durationSeconds, expected) => {
    const problems = problemsWith(draft({ durationSeconds }), [target()]);

    expect(problems.some(p => p.kind === 'duration-out-of-range')).toBe(expected);
  });

  it('lets the node choose the length when none is given', () => {
    expect(problemsWith(draft({ durationSeconds: null }), [target()])).toEqual(
      [],
    );
  });

  it('does not invent limits for a node that has not advertised any', () => {
    const problems = problemsWith(draft({ caption: 'x'.repeat(500) }), [
      target({ limits: null }),
    ]);

    expect(problems).toEqual([]);
  });
});

describe('toGenerationRequest', () => {
  it('trims the caption and omits what was not filled in', () => {
    expect(toGenerationRequest(draft({ caption: '  a piece  ' }))).toEqual({
      caption: 'a piece',
    });
  });

  it('includes lyrics and duration when present', () => {
    expect(
      toGenerationRequest(draft({ lyrics: ' la la ', durationSeconds: 60 })),
    ).toEqual({
      caption: 'a slow piano piece',
      lyrics: 'la la',
      duration: 60,
    });
  });

  it('omits whitespace-only lyrics rather than sending blanks', () => {
    expect(toGenerationRequest(draft({ lyrics: '    ' }))).toEqual({
      caption: 'a slow piano piece',
    });
  });
});
