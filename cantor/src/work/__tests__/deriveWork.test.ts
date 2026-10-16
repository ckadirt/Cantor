import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import type { JobView, NodeInfo } from '../../core/protocol';
import type { OutboxEntry } from '../../jobs/outbox';
import fixture from '../../../../protocol/fixtures/v2/node-info-capabilities.json';
import { deriveWork, derivedJobId } from '..';

const principal = new Uint8Array(32).fill(7);
const node: BackendRecord = {
  nodePubkey: 'node',
  petname: 'Studio',
  relayUrl: 'wss://relay.example',
  lastNodeInfo: {
    ...fixture.node,
    features: { ...fixture.node.features, derived_job_ids: true },
  } as NodeInfo,
};
const entry: OutboxEntry = {
  clientRequestId: 'request',
  nodePublicKey: 'node',
  model: 'acestep:1.5-balanced',
  generation: { caption: 'Rain' },
  requestHash: 'hash',
  state: 'pending',
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
};
const job: JobView = {
  id: 'canonical',
  revision: 1,
  state: 'running',
  model: entry.model,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
};
const snapshot: ConnectionSnapshot = {
  phase: 'ready',
  error: null,
  jobs: [],
  songs: [],
  libraryRevision: null,
  librarySyncing: false,
};
const input: Parameters<typeof deriveWork>[0] = {
  principal,
  backends: [node],
  outbox: [entry],
  sending: {},
  snapshots: { node: snapshot },
};
const one = (overrides: Partial<typeof input> = {}) =>
  [...deriveWork({ ...input, ...overrides }).values()][0];

it('shows waiting, sending, submitted, then the node job under one derived key', () => {
  const away = one({ snapshots: {} });
  expect(away.phase).toEqual({ kind: 'waiting' });
  expect(away.job).toBeNull();
  expect(one({ sending: { request: { sent: 3, total: 10 } } }).phase).toEqual({
    kind: 'sending',
    sent: 3,
    total: 10,
  });
  const submitted = one();
  expect(submitted.phase).toEqual({ kind: 'submitted' });
  const running = one({
    snapshots: {
      node: { ...snapshot, jobs: [{ ...job, id: submitted.jobId }] },
    },
  });
  expect(running.phase).toEqual({ kind: 'job' });
  expect([away.key, submitted.key, running.key]).toEqual([
    running.key,
    running.key,
    running.key,
  ]);
});

it.each(['canonical', 'request', 'derived'] as const)(
  'merges by %s without a second mark',
  match => {
    const outbox = [
      {
        ...entry,
        ...(match === 'canonical' ? { canonicalJobId: job.id } : {}),
      },
    ];
    const remote = {
      ...job,
      ...(match === 'request'
        ? { client_request_id: entry.clientRequestId }
        : {}),
      ...(match === 'derived'
        ? { id: derivedJobId(principal, entry.clientRequestId) }
        : {}),
    };
    const works = deriveWork({
      ...input,
      outbox,
      snapshots: { node: { ...snapshot, jobs: [remote] } },
    });
    expect(works.size).toBe(1);
    expect([...works.values()][0]).toMatchObject({
      job: remote,
      request: entry.generation,
      clientRequestId: entry.clientRequestId,
    });
  },
);

it('keeps another device’s job and prefers its caption and plan, including open names', () => {
  const remote = {
    ...job,
    caption: 'Node words',
    plan: [{ stage: 'mixdown', unit: 'samples' }],
  };
  const works = deriveWork({
    ...input,
    snapshots: { node: { ...snapshot, jobs: [remote] } },
  });
  expect(works.size).toBe(2);
  expect(works.get('node:canonical')).toMatchObject({
    clientRequestId: null,
    request: null,
    caption: 'Node words',
    plan: remote.plan,
  });
  expect(
    one({
      snapshots: {
        node: {
          ...snapshot,
          jobs: [{ ...remote, client_request_id: 'request' }],
        },
      },
    }).caption,
  ).toBe('Node words');
});

it('uses pending then canonical keys on an older node', () => {
  const backends = [{ ...node, lastNodeInfo: null }];
  expect(one({ backends }).key).toBe('node:pending:request');
  expect(
    one({
      backends,
      outbox: [{ ...entry, state: 'accepted', canonicalJobId: job.id }],
    }).key,
  ).toBe('node:canonical');
});

it('drops rejected entries and cancelled jobs without reviving their outbox marks', () => {
  expect(
    deriveWork({ ...input, outbox: [{ ...entry, state: 'rejected' }] }).size,
  ).toBe(0);
  expect(
    deriveWork({
      ...input,
      snapshots: {
        node: {
          ...snapshot,
          jobs: [{ ...job, client_request_id: 'request', state: 'cancelled' }],
        },
      },
    }).size,
  ).toBe(0);
});

it('keeps completed work until the song owns the same key', () => {
  const remote = {
    ...job,
    id: derivedJobId(principal, 'request'),
    state: 'completed' as const,
  };
  const snapshots = { node: { ...snapshot, jobs: [remote] } };
  expect(deriveWork({ ...input, snapshots }).size).toBe(1);
  // Only the song id is read by the pure work derivation.
  snapshots.node.songs = [{ id: remote.id }] as ConnectionSnapshot['songs'];
  expect(deriveWork({ ...input, snapshots }).size).toBe(0);
});

it('uses an audio act’s advertised arc before acceptance, then the node’s plan', () => {
  const model = node.lastNodeInfo!.models[0];
  const backends = [
    {
      ...node,
      lastNodeInfo: {
        ...node.lastNodeInfo!,
        models: [
          {
            ...model,
            selector: entry.model,
            stages: ['plan', 'codes', 'diffuse', 'decode'],
            capabilities: [
              {
                kind: 'cover' as const,
                stages: ['encode', 'diffuse', 'decode'],
              },
            ],
          },
        ],
      },
    },
  ];
  const outbox = [
    {
      ...entry,
      generation: {
        ...entry.generation,
        audio: {
          source: { kind: 'upload' as const, upload_id: 'local' },
          act: 'cover' as const,
        },
      },
    },
  ];
  expect(one({ backends, outbox }).plan.map(part => part.stage)).toEqual([
    'encode',
    'diffuse',
    'decode',
  ]);
  const remote = {
    ...job,
    client_request_id: 'request',
    plan: [
      { stage: 'encode', unit: 'tiles' },
      { stage: 'mixdown', unit: 'samples' },
    ],
  };
  expect(
    one({
      backends,
      outbox,
      snapshots: { node: { ...snapshot, jobs: [remote] } },
    }).plan,
  ).toBe(remote.plan);
});

it('reuses unchanged work across outbox reads and unrelated snapshots', () => {
  const first = deriveWork(input);
  const next = deriveWork(
    { ...input, snapshots: { node: { ...snapshot } }, sending: {} },
    first,
  );
  expect([...next.values()][0]).toBe([...first.values()][0]);
  const sending = deriveWork(
    { ...input, sending: { request: { sent: 1, total: 10 } } },
    first,
  );
  expect([...sending.values()][0]).not.toBe([...first.values()][0]);
  expect(
    [
      ...deriveWork(
        { ...input, sending: { request: { sent: 1, total: 10 } } },
        sending,
      ).values(),
    ][0],
  ).toBe([...sending.values()][0]);
});
