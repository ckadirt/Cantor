import {
  parseAudioPrompt,
  parseJob,
  parseJobs,
  parseNodeInfo,
  parseSong,
} from '../../core/protocol';
import { decodeForgottenJob } from '../applicationResponses';

const nodeInfo = require('../../../../protocol/fixtures/v2/node-info.json');
const jobsPage = require('../../../../protocol/fixtures/v2/jobs-page.json');
const forgotten = require('../../../../protocol/fixtures/v2/job-forgotten.json');
const invalidState = require('../../../../protocol/fixtures/v2/malformed/invalid-state.json');
const negativeProgress = require('../../../../protocol/fixtures/v2/malformed/negative-progress.json');
const forward = require('../../../../protocol/fixtures/v2/forward/extra-optional-field.json');
const capabilities = require('../../../../protocol/fixtures/v2/node-info-capabilities.json');
const lyricsNode = require('../../../../protocol/fixtures/v2/node-info-lyrics.json');
const audioJob = require('../../../../protocol/fixtures/v2/job-create-audio.json');
const tuneJob = require('../../../../protocol/fixtures/v2/job-create-tune.json');

describe('shared protocol v2 fixtures', () => {
  it('parses canonical node and job messages at the app boundary', () => {
    expect(parseNodeInfo(nodeInfo.node)?.name).toBe('fixture-node');
    expect(parseJobs(jobsPage.jobs)?.[0]).toMatchObject({
      state: 'running',
      stage: 'diffuse',
      revision: 3,
    });
  });

  it('keeps the words a stopped job was asked for, and tolerates their absence', () => {
    const jobs = parseJobs(jobsPage.jobs);
    // The first job in the fixture is what a node predating captions sends.
    expect(jobs?.[0].caption).toBeUndefined();
    expect(jobs?.[1]).toMatchObject({
      state: 'failed',
      caption: 'una cumbia lenta para la lluvia',
    });
    expect(
      parseJobs([{ ...jobsPage.jobs[0], caption: 7 }]),
    ).toBeNull();
  });

  it('reads the id out of a deletion the node announces', () => {
    expect(decodeForgottenJob(forgotten)).toBe(
      '019c8f7e-5f2b-7a21-9ee0-8efb630bcb17',
    );
    expect(decodeForgottenJob({ t: 'job.forgotten', v: 2 })).toBeNull();
  });

  it('reads a node that predates deletion as unable to delete', () => {
    // `job_forget` is absent from this fixture on purpose: that is what every
    // node deployed before M9 sends, and the app must not offer the act.
    expect(nodeInfo.node.features.job_forget).toBeUndefined();
    expect(parseNodeInfo(nodeInfo.node)?.features.job_forget).toBe(false);
  });

  it('reads declared audio capabilities, dropping kinds this build does not know', () => {
    const node = parseNodeInfo(capabilities.node);
    expect(node?.models[0].capabilities?.map(c => c.kind)).toEqual([
      'cover',
      'extend',
      'timbre',
    ]);
    expect(node?.models[0].capabilities?.[0]).toMatchObject({
      stages: ['diffuse', 'decode'],
      max_source_seconds: 600,
    });
    // Declares none: a node that knows about audio, for a model that takes none.
    expect(node?.models[1].capabilities).toEqual([]);
    expect(node?.features).toMatchObject({ audio_sources: true, uploads: true });
    expect(node?.limits.max_upload_bytes).toBe(209715200);
    expect(node?.installable?.[0]).toMatchObject({
      selector: 'acestep:1.5-balanced',
      capabilities: ['cover', 'extend', 'timbre'],
    });
  });

  it('reads a node that predates audio as offering none of it', () => {
    const node = parseNodeInfo(lyricsNode.node);
    expect(node?.models[0].capabilities).toBeUndefined();
    expect(node?.features).toMatchObject({ audio_sources: false, uploads: false });
    expect(node?.installable).toBeUndefined();
  });

  it('reads audio prompts and refuses an act it cannot name', () => {
    expect(parseAudioPrompt(audioJob.generation.audio)).toMatchObject({
      source: { kind: 'song' },
      act: 'cover',
      closeness: 0.5,
    });
    expect(parseAudioPrompt(tuneJob.generation.audio)).toMatchObject({
      source: { kind: 'upload' },
      tune: true,
      tile_to_seconds: 120,
    });
    expect(parseAudioPrompt({ ...audioJob.generation.audio, act: 'teleport' })).toBeNull();
    expect(parseAudioPrompt({ ...audioJob.generation.audio, closeness: 2 })).toBeNull();
  });

  it('keeps a song whose origin it cannot read, without the origin', () => {
    const song = {
      id: 's',
      revision: 1,
      title: 't',
      caption_summary: 'c',
      created_at: '2026-10-14T00:00:00Z',
      duration_ms: 1000,
      model: 'acestep:1.5-fast',
      favorite: false,
      tags: [],
      trashed: false,
      artifacts: [],
    };
    expect(
      parseSong({ ...song, derived_from: { act: 'extend', song_id: 'p' } })?.derived_from,
    ).toEqual({ act: 'extend', song_id: 'p' });
    const odd = parseSong({ ...song, derived_from: { act: 'remix' } });
    expect(odd?.id).toBe('s');
    expect(odd?.derived_from).toBeUndefined();
  });

  it('rejects invalid enum and numeric semantics', () => {
    expect(parseJobs(invalidState.jobs)).toBeNull();
    expect(parseJobs(negativeProgress.jobs)).toBeNull();
  });

  it('ignores additive optional fields', () => {
    expect(parseNodeInfo(forward.node)?.name).toBe('fixture-node');
  });

  it('defaults legacy cached job errors to non-retryable', () => {
    expect(
      parseJob({
        id: 'job',
        revision: 1,
        state: 'failed',
        model: 'model',
        created_at: '2026-08-08T00:00:00Z',
        updated_at: '2026-08-08T00:00:00Z',
        error: { code: 'internal', message: 'old cache' },
      })?.error,
    ).toMatchObject({ retryable: false });
  });
});
