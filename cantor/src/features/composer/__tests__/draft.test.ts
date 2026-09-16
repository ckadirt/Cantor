import type { NodeLimits } from '../../../../../protocol/NodeLimits';
import {
  EMPTY_DRAFT,
  canSubmit,
  describeProblem,
  modelsFor,
  writeWordsFor,
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

describe('modelsFor', () => {
  it('offers what one node has, and never a union across nodes', () => {
    const engine = (selector: string) => ({
      selector,
      family: selector.split(':')[0],
      engine: selector.split(':')[0],
    });
    const agentbox = target({
      nodePublicKey: 'a',
      models: [engine('levo2:1.0'), engine('acestep:1.5-fast')],
    });
    const phone = target({ nodePublicKey: 'b', models: [engine('levo2:1.0')] });

    // Sorted, and scoped: picking the phone must not offer ACE-Step just
    // because another node has it.
    expect(modelsFor(agentbox).map(entry => entry.selector)).toEqual([
      'acestep:1.5-fast',
      'levo2:1.0',
    ]);
    expect(modelsFor(phone).map(entry => entry.selector)).toEqual([
      'levo2:1.0',
    ]);
  });

  it('has nothing to offer before a node is chosen', () => {
    expect(modelsFor(null)).toEqual([]);
  });
});

describe('problemsWith', () => {
  it('accepts a complete draft', () => {
    expect(problemsWith(draft(), [target()])).toEqual([]);
    expect(canSubmit(draft(), [target()])).toBe(true);
  });

  it('needs a node and a model', () => {
    const problems = problemsWith({ ...EMPTY_DRAFT, caption: 'something' }, [
      target(),
    ]);

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
    expect(
      problemsWith(draft({ caption: 'a'.repeat(32) }), [target()]),
    ).toEqual([]);
  });

  it('measures lyrics too, and allows empty lyrics', () => {
    expect(problemsWith(draft({ lyrics: '' }), [target()])).toEqual([]);
    expect(
      problemsWith(draft({ wordsMode: 'mine', lyrics: 'x'.repeat(65) }), [
        target(),
      ])[0],
    ).toMatchObject({ kind: 'lyrics-too-long', bytes: 65, maxBytes: 64 });
  });

  it.each([
    [9, true],
    [10, false],
    [240, false],
    [241, true],
  ])('duration %p out of range: %p', (durationSeconds, expected) => {
    const problems = problemsWith(draft({ durationSeconds }), [target()]);

    expect(problems.some(p => p.kind === 'duration-out-of-range')).toBe(
      expected,
    );
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
      toGenerationRequest(
        draft({ wordsMode: 'mine', lyrics: ' la la ', durationSeconds: 60 }),
      ),
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

describe('words intent', () => {
  const ace = {
    selector: 'acestep:1.5-fast',
    family: 'acestep',
    engine: 'acestep',
    stages: ['plan', 'codes', 'diffuse', 'decode'] as const,
  };
  const model = { ...ace, stages: [...ace.stages] };
  it('requests instrumental ACE audio explicitly, without an invented extension', () => {
    expect(toGenerationRequest(draft(), [], model)).toEqual({
      caption: 'a slow piano piece',
      lyrics: '[Instrumental]',
    });
  });
  it('preserves supplied lyrics', () => {
    expect(
      toGenerationRequest(
        draft({ wordsMode: 'mine', lyrics: ' hello ' }),
        [],
        model,
      ),
    ).toEqual({ caption: 'a slow piano piece', lyrics: 'hello' });
  });
  it('leaves lyrics empty for the native planner, ignoring retained text', () => {
    expect(
      toGenerationRequest(
        draft({ wordsMode: 'model', lyrics: 'saved' }),
        [],
        model,
      ),
    ).toEqual({ caption: 'a slow piano piece' });
    expect(writeWordsFor([target({ models: [model] })], draft())).toBe(
      "ACESTEP'S",
    );
  });
  it('requires the ACE engine and its planner, not a model name or just a plan stage', () => {
    for (const candidate of [
      { ...model, engine: 'other' },
      {
        ...model,
        stages: ['codes' as const, 'diffuse' as const, 'decode' as const],
      },
    ]) {
      expect(
        problemsWith(draft({ wordsMode: 'model' }), [
          target({ models: [candidate] }),
        ]),
      ).toContainEqual({ kind: 'writer-unavailable' });
    }
  });
  it('does not invent instrumental tokens for other engines', () => {
    expect(
      toGenerationRequest(draft(), [], { ...model, engine: 'levo2' }),
    ).toEqual({ caption: 'a slow piano piece' });
  });
  it('does not validate unsent lyrics', () => {
    expect(
      problemsWith(draft({ lyrics: 'x'.repeat(100) }), [target()]),
    ).toEqual([]);
  });
});
