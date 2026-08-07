import {parseJobs, parseNodeInfo} from '../types';

const nodeInfo = require('../../../../protocol/fixtures/v2/node-info.json');
const jobsPage = require('../../../../protocol/fixtures/v2/jobs-page.json');
const invalidState = require('../../../../protocol/fixtures/v2/malformed/invalid-state.json');
const negativeProgress = require('../../../../protocol/fixtures/v2/malformed/negative-progress.json');
const forward = require('../../../../protocol/fixtures/v2/forward/extra-optional-field.json');

describe('shared protocol v2 fixtures', () => {
  it('parses canonical node and job messages at the app boundary', () => {
    expect(parseNodeInfo(nodeInfo.node)?.name).toBe('fixture-node');
    expect(parseJobs(jobsPage.jobs)?.[0]).toMatchObject({
      state: 'running', stage: 'diffuse', revision: 3,
    });
  });

  it('rejects invalid enum and numeric semantics', () => {
    expect(parseJobs(invalidState.jobs)).toBeNull();
    expect(parseJobs(negativeProgress.jobs)).toBeNull();
  });

  it('ignores additive optional fields', () => {
    expect(parseNodeInfo(forward.node)?.name).toBe('fixture-node');
  });
});
