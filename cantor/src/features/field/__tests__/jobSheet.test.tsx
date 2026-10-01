import React from 'react';
import * as Renderer from 'react-test-renderer';
import type { JobView, NodeInfo } from '../../../core/protocol';
import fixture from '../../../../../protocol/fixtures/v2/node-info.json';
import { STRIKE_KNOBS } from '../../controls';
import { JobSheet, JOB_SHEET_KNOBS } from '../JobSheet';
import type { JobPresentation } from '../useFieldController';

// CanvasKit's system font manager is empty under Jest, so the written caption
// and the header's morphing word have no face to lay out. The real glyphs under
// them — which is what this sheet is judged by — are plain React.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
  useFontScaledStyle: (style: unknown) => style,
}));

const node = fixture.node as NodeInfo;

function pending(
  job: Partial<JobView>,
  overrides: Partial<JobPresentation> = {},
  features: Partial<NodeInfo['features']> = {},
): JobPresentation {
  return {
    entity: {
      key: 'node:job-1',
      nodePublicKey: 'node',
      entityId: 'job-1',
      kind: 'job',
      createdAtMs: 0,
      durationMs: 0,
      tags: [],
    },
    job: {
      id: '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
      revision: 4,
      state: 'failed',
      model: 'acestep:1.5-fast',
      created_at: '2026-09-18T10:30:00Z',
      updated_at: '2026-09-18T10:32:00Z',
      error: { code: 'internal', message: 'The engine stopped.', retryable: false },
      ...job,
    } as JobView,
    backend: {
      nodePubkey: 'node',
      petname: 'Studio',
      relayUrl: 'wss://example.test',
      lastNodeInfo: {
        ...node,
        features: { ...node.features, job_forget: true, ...features },
      },
    },
    nodeLabels: ['Studio'],
    caption: 'a slow bolero for a rainy street',
    request: { caption: 'a slow bolero for a rainy street', duration: 125, seed: 7 },
    declaredStages: [],
    ...overrides,
  };
}

function render(presentation: JobPresentation | null) {
  const onControl = jest.fn();
  const onForget = jest.fn();
  let tree!: Renderer.ReactTestRenderer;
  Renderer.act(() => {
    tree = Renderer.create(
      <JobSheet
        visible
        busy={false}
        error={null}
        onClose={jest.fn()}
        onControl={onControl}
        onForget={onForget}
        pending={presentation}
      />,
    );
  });
  const press = (label: string) => {
    const button = tree.root.find(
      n =>
        typeof n.type !== 'string' &&
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityLabel === label,
    );
    Renderer.act(() => button.props.onPress());
  };
  const words = () =>
    tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
  const labels = () =>
    tree.root
      .findAll(
        n =>
          typeof n.type !== 'string' &&
          (typeof n.props.onPress === 'function' ||
            typeof n.props.onPressIn === 'function') &&
          typeof n.props.accessibilityLabel === 'string',
      )
      .map(n => n.props.accessibilityLabel as string);
  /** Press and hold a struck act for `ms`, then let go. */
  const hold = (label: string, ms: number) => {
    const target = tree.root.find(
      n =>
        typeof n.type !== 'string' &&
        typeof n.props.onPressIn === 'function' &&
        n.props.accessibilityLabel === label,
    );
    Renderer.act(() => target.props.onPressIn());
    Renderer.act(() => {
      jest.advanceTimersByTime(ms);
    });
    Renderer.act(() => target.props.onPressOut());
  };
  return { tree, press, hold, words, labels, onControl, onForget };
}

describe('the stopped generation sheet', () => {
  it('lands every block of the sheet inside the beat that carries them', () => {
    // Four blocks: the subject, the arc, the reason, and the facts. A window
    // that ends after the clock does is a row that never reaches full ink —
    // which is how three facts came to sit at a fifth of their opacity.
    const BLOCKS = 4;
    const last =
      JOB_SHEET_KNOBS.ROWS_FROM +
      (BLOCKS - 1) * JOB_SHEET_KNOBS.ARRIVAL_LAG +
      JOB_SHEET_KNOBS.ARRIVAL_RISE;
    expect(last).toBeLessThanOrEqual(1);
  });

  it('keeps every foot note inside the measure the foot actually has', () => {
    const notes = [
      ...render(pending({})).words(),
      ...render(pending({}, {}, { job_forget: false })).words(),
    ].filter(word => word.startsWith('THE ') || word.startsWith('HOLD'));
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.length).toBeLessThanOrEqual(JOB_SHEET_KNOBS.FOOT_NOTE_CHARS);
    }
  });

  it('says which generation stopped, and why, in the app’s words rather than the node’s message', () => {
    const { words } = render(pending({}));
    expect(words()).toContain('a slow bolero for a rainy street');
    // The raw message is for Diagnostics; the screen says it by its code.
    expect(words()).not.toContain('The engine stopped.');
    expect(words().some(word => word.startsWith('Something broke on '))).toBe(
      true,
    );
    expect(words()).toContain('2:05');
    expect(words()).toContain('7');
    expect(words()).toContain('019c8f7e…0bcb17');
    // Every fact hangs off the spine by its own label, in the ledger's voice.
    expect(words()).toEqual(
      expect.arrayContaining([
        'REASON',
        'STARTED',
        'LENGTH',
        'SEED',
        'MODEL',
        'REF',
      ]),
    );
    expect(words()).toContain('acestep:1.5-fast');
    expect(words().join(' ')).toContain('INTERNAL');
    expect(words().join(' ')).toContain('NOT RETRIED');
    // The engine is the scope line; the model is a fact on the axis.
    expect(words()).toContain('ON STUDIO');
  });

  it('deletes only when held for the whole stroke', () => {
    jest.useFakeTimers();
    try {
      const { hold, labels, words, onForget } = render(pending({}));
      expect(labels()).toContain('Delete');
      // What it takes is written before it is touched.
      expect(words()).toContain('HOLD · CAPTION GOES TOO');
      // Let go early: the rule goes back, nothing is deleted.
      hold('Delete', STRIKE_KNOBS.HOLD_MS / 2);
      expect(onForget).not.toHaveBeenCalled();
      hold('Delete', STRIKE_KNOBS.HOLD_MS);
      expect(onForget).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('offers the retry the node said it would honour, beside the deletion', () => {
    const { labels } = render(
      pending({ error: { code: 'internal', message: 'Try later.', retryable: true } }),
    );
    expect(labels()).toEqual(
      expect.arrayContaining(['Try again', 'Delete']),
    );
  });

  it('does not offer deletion for work still running, or to a node without it', () => {
    expect(render(pending({ state: 'running', error: undefined })).labels()).not.toContain('Delete');
    expect(
      render(pending({}, {}, { job_forget: false })).labels(),
    ).not.toContain('Delete');
    // A foot with no acts says so rather than standing empty.
    expect(render(pending({}, {}, { job_forget: false })).words()).toContain(
      'NOTHING LEFT TO DO',
    );
    // Work the node has taken past the point of stopping: no controls either.
    expect(
      render(pending({ state: 'finalizing', error: undefined })).words(),
    ).toContain('WAITING ON THE NODE');
  });

  it('shows what a job submitted from another phone can still say', () => {
    const { words } = render(
      pending({}, { caption: null, request: null }),
    );
    expect(words()).toContain('Generation failed');
    expect(words().some(word => word.startsWith('Something broke on '))).toBe(
      true,
    );
    expect(words()).toContain('019c8f7e…0bcb17');
    expect(words()).not.toContain('2:05');
  });
});
