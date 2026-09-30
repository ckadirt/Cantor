import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {StressClient} from './client.mjs';
import {markdownReport, percentile, summarize} from './metrics.mjs';
import {parseArgs} from './run.mjs';

const base = ['--workdir', '/tmp/cantor-stress-test', '--node-bin', '/bin/true',
  '--model-dir', '/tmp/models', '--relay', 'wss://example.test', '--model', 'acestep:fast'];

test('CLI validates bounded users and fixture count for burst', () => {
  assert.equal(parseArgs(base).users, 5);
  assert.deepEqual(parseArgs([...base, '--users', '1', '--phases', 'idle,mixed', '--fixtures', '2']).levels, [1]);
  assert.throws(() => parseArgs([...base, '--users', '6']), /Maximum/);
  assert.throws(() => parseArgs([...base, '--fixtures', '2']), /five fixtures/);
  assert.throws(() => parseArgs([...base, '--levels', '1,6']), /levels/);
  assert.throws(() => parseArgs([...base, '--duration', '10']), /duration/);
  assert.throws(() => parseArgs([...base, '--max-outstanding', '4']), /max-outstanding/);
});

test('summaries keep each user count and repetition separate and count errors', () => {
  const context = {users: 2, phase: 'burst', repetition: 1};
  const summary = summarize([
    {...context, kind: 'download', ms: 10, bytes: 100, stalls: 1},
    {...context, kind: 'download', ms: 30, bytes: 100, stalls: 0},
    {...context, kind: 'download', error: 'timed out', code: 'timeout'},
    {...context, repetition: 2, kind: 'download', ms: 50},
  ]);
  assert.deepEqual(summary['2/burst/1/download'], {
    successes: 2, errors: {timeout: 1}, p50Ms: 10, p95Ms: 30,
    p99Ms: 30, maxMs: 30, p50BytesPerSecond: null,
    stalls: 1, bytes: 200, unfinished: 0,
  });
  assert.equal(summary['2/burst/2/download'].successes, 1);
  assert.equal(percentile([], .5), null);
  assert.match(markdownReport({started: 'today', configuration: {model: 'm', relay: 'r', nodeBin: 'n'},
    machine: {platform: 'linux', arch: 'x64', cpus: 1, totalMemoryBytes: 1}, summary}),
  /\| 2 \| burst \| 1 \| download \| 2 \| timeout:1 \|/);
});

test('artifact transfer acknowledges every chunk and verifies hash', async () => {
  const bytes = Buffer.from('a complete artifact');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const client = Object.create(StressClient.prototype);
  client.request = async (kind, fields) => {
    requests.push({kind, fields});
    if (kind === 'artifact.open') return {ms: 2, message: {t: 'artifact.info', transfer_id: 'x',
      artifact: {byte_length: bytes.length, sha256: digest}}};
    if (fields.next_offset === 0) return {message: {t: 'artifact.chunk', offset: 0,
      data: bytes.subarray(0, 8).toString('base64')}};
    if (fields.next_offset === 8) return {message: {t: 'artifact.chunk', offset: 8,
      data: bytes.subarray(8).toString('base64')}};
    return {message: {t: 'artifact.complete'}};
  };
  const result = await client.download({id: 'song', profile: 'opus'});
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(requests.filter(r => r.kind === 'artifact.ack').map(r => r.fields.next_offset),
    [0, 8, bytes.length]);
});

test('artifact transfer refuses corrupt data', async () => {
  const client = Object.create(StressClient.prototype);
  client.request = async kind => kind === 'artifact.open'
    ? {ms: 1, message: {t: 'artifact.info', transfer_id: 'x',
      artifact: {byte_length: 2, sha256: 'wrong'}}}
    : {message: {t: 'artifact.chunk', offset: 0, data: Buffer.from('hi').toString('base64')}};
  await assert.rejects(client.download({id: 'song', profile: 'opus'}), /Out-of-order|integrity/);
});
