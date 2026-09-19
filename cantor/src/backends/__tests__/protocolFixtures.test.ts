import { parseJob, parseJobs, parseNodeInfo } from '../../core/protocol';
import { decodeForgottenJob } from '../applicationResponses';

const nodeInfo = require('../../../../protocol/fixtures/v2/node-info.json');
const jobsPage = require('../../../../protocol/fixtures/v2/jobs-page.json');
const forgotten = require('../../../../protocol/fixtures/v2/job-forgotten.json');
const invalidState = require('../../../../protocol/fixtures/v2/malformed/invalid-state.json');
const negativeProgress = require('../../../../protocol/fixtures/v2/malformed/negative-progress.json');
const forward = require('../../../../protocol/fixtures/v2/forward/extra-optional-field.json');

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
