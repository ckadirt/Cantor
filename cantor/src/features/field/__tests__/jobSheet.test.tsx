import React from 'react';
import * as Renderer from 'react-test-renderer';
import type { JobView, NodeInfo } from '../../../core/protocol';
import fixture from '../../../../../protocol/fixtures/v2/node-info.json';
import { JobSheet, JOB_SHEET_KNOBS } from '../JobSheet';
import type { JobPresentation } from '../useFieldController';

// CanvasKit's system font manager is empty under Jest, so the written caption
// and the header's morphing word have no face to lay out. The real glyphs under
// them — which is what this sheet is judged by — are plain React.
jest.mock('../../../motion/fonts', () => ({
  __esModule: true,
  useMorphFont: () => null,
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
          typeof n.props.onPress === 'function' &&
          typeof n.props.accessibilityLabel === 'string',
      )
      .map(n => n.props.accessibilityLabel as string);
  return { tree, press, words, labels, onControl, onForget };
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
      ...(() => {
        const sheet = render(pending({}));
        sheet.press('Delete');
        return sheet.words();
      })(),
      ...render(pending({}, {}, { job_forget: false })).words(),
    ].filter(word => word.startsWith('THE ') || word.startsWith('DELETING'));
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note.length).toBeLessThanOrEqual(JOB_SHEET_KNOBS.FOOT_NOTE_CHARS);
    }
  });

  it('says which generation stopped, and why, in the node’s own words', () => {
    const { words } = render(pending({}));
    expect(words()).toContain('a slow bolero for a rainy street');
    expect(words()).toContain('The engine stopped.');
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
    expect(words().join(' ')).toContain('IT WILL NOT BE RETRIED');
    // The engine is the scope line; the model is a fact on the axis.
    expect(words()).toContain('ON STUDIO');
  });

  it('asks twice before deleting, and deletes only on the second answer', () => {
    const { press, labels, words, onForget } = render(pending({}));
    expect(labels()).toContain('Delete');
    expect(words()).toContain('THE WORDS GO WITH IT');
    press('Delete');
    expect(onForget).not.toHaveBeenCalled();
    expect(words()).toContain('THERE IS NO UNDO');
    press('Keep it');
    expect(onForget).not.toHaveBeenCalled();
    expect(labels()).toContain('Delete');

    press('Delete');
    press('Delete it');
    expect(onForget).toHaveBeenCalledTimes(1);
    // The question is asked afresh next time, never left standing.
    expect(labels()).toContain('Delete');
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
    ).toContain('NOTHING TO DO BUT WAIT');
  });

  it('shows what a job submitted from another phone can still say', () => {
    const { words } = render(
      pending({}, { caption: null, request: null }),
    );
    expect(words()).toContain('Generation failed');
    expect(words()).toContain('The engine stopped.');
    expect(words()).toContain('019c8f7e…0bcb17');
    expect(words()).not.toContain('2:05');
  });
});
