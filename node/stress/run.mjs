#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {createConnection} from 'node:net';
import {readFile, writeFile, mkdir, realpath, stat, statfs} from 'node:fs/promises';
import {resolve, join, sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {loadOrCreateIdentity} from '../scripts/lib/identity.mjs';
import {StressClient} from './client.mjs';
import {availableMemoryBytes, clockTicksPerSecond, gpuSample, machineInfo, markdownReport, processSample, summarize} from './metrics.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const terminal = new Set(['completed', 'failed', 'cancelled']);

export function parseArgs(values) {
  const map = new Map();
  const known = new Set(['workdir', 'node-bin', 'model-dir', 'relay', 'model', 'users', 'levels',
    'phases', 'seconds', 'repetitions', 'fixtures', 'duration', 'steps', 'fixture-timeout-ms',
    'drain-timeout-ms', 'phase', 'profile', 'install-backend', 'minimum-available-mib',
    'max-outstanding', 'dry-run', 'verbose']);
  for (let i = 0; i < values.length; i++) {
    const key = values[i]?.replace(/^--/, '');
    if (!values[i]?.startsWith('--') || !known.has(key) || map.has(key)) throw Error(`Unknown or duplicate option ${values[i]}`);
    if (key === 'dry-run' || key === 'verbose') { map.set(key, true); continue; }
    if (!values[i + 1] || values[i + 1].startsWith('--')) throw Error(`Missing value for --${key}`);
    map.set(key, values[++i]);
  }
  for (const key of ['workdir', 'node-bin', 'model-dir', 'relay', 'model']) if (!map.has(key))
    throw Error(`Missing --${key}`);
  const integer = (key, fallback) => {
    const value = Number(map.get(key) ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw Error(`--${key} must be a positive integer`);
    return value;
  };
  const users = integer('users', 5);
  if (users > 5) throw Error('Maximum is five users');
  const levels = (map.get('levels') ?? Array.from({length: users}, (_, i) => i + 1).join(','))
    .split(',').map(Number);
  if (!levels.length || levels.some(n => !Number.isInteger(n) || n < 1 || n > users) ||
      new Set(levels).size !== levels.length) throw Error('Invalid --levels');
  const phases = (map.get('phases') ?? 'idle,mixed,burst').split(',');
  if (!phases.length || phases.some(p => !['idle', 'mixed', 'burst'].includes(p)) ||
      new Set(phases).size !== phases.length) throw Error('Invalid --phases');
  const phase = map.get('phase') ?? 'all';
  if (!['prepare', 'run', 'all'].includes(phase)) throw Error('Invalid --phase');
  const relay = new URL(map.get('relay'));
  if (!['ws:', 'wss:'].includes(relay.protocol)) throw Error('--relay must be ws:// or wss://');
  if (relay.username || relay.password || relay.search || relay.hash) throw Error('Relay URL must not include credentials, query, or fragment');
  const fixtures = integer('fixtures', 5);
  const duration = integer('duration', 15);
  const steps = integer('steps', 8);
  const maxOutstanding = integer('max-outstanding', 3);
  if (duration < 15 || duration > 600) throw Error('--duration must be within the protocol range 15–600 seconds');
  if (steps > 200) throw Error('--steps must be at most 200');
  if (maxOutstanding > 3) throw Error('--max-outstanding must be at most 3');
  if (phases.includes('burst') && fixtures < 5) throw Error('Burst phase requires five fixtures per user');
  return {workdir: resolve(map.get('workdir')), nodeBin: resolve(map.get('node-bin')),
    modelDir: resolve(map.get('model-dir')), relay: relay.toString().replace(/\/$/, ''),
    model: map.get('model'), users, levels, phases, phase, fixtures,
    seconds: integer('seconds', 600), repetitions: integer('repetitions', 3),
    duration, steps,
    fixtureTimeoutMs: integer('fixture-timeout-ms', 1200000),
    drainTimeoutMs: integer('drain-timeout-ms', 3600000),
    profile: map.get('profile') ?? 'opus-stereo-160k-v1',
    installBackend: map.get('install-backend') ?? null,
    minimumAvailableMiB: integer('minimum-available-mib', 2048),
    maxOutstanding,
    dryRun: !!map.get('dry-run'), verbose: !!map.get('verbose')};
}

async function installBackend(options, socket) {
  if (!options.installBackend) return;
  console.log(`Installing and selecting ${options.installBackend} backend in ${options.modelDir}`);
  await new Promise((done, reject) => {
    const command = spawn(options.nodeBin,
      ['backends', '--use', options.installBackend, '--control-socket', socket],
      {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    command.stdout.on('data', chunk => { output += chunk.toString(); if (options.verbose) process.stderr.write(chunk); });
    command.stderr.on('data', chunk => { output += chunk.toString(); if (options.verbose) process.stderr.write(chunk); });
    command.on('error', reject);
    command.on('exit', code => code === 0 ? done() : reject(Error(`Backend selection failed: ${output.slice(-2000)}`)));
  });
}

async function preflight(options) {
  const binary = await stat(options.nodeBin);
  if (!binary.isFile() || !(binary.mode & 0o111)) throw Error('Node binary is not executable');
  const modelRoot = await realpath(options.modelDir);
  const marker = join(modelRoot, 'variants', `${options.model.replace(':', '__')}.json`);
  const variant = JSON.parse(await readFile(marker, 'utf8'));
  if (`${variant.model}:${variant.tag}` !== options.model) throw Error('Installed model marker does not match selector');
  for (const component of variant.components) {
    const digest = component.blob?.replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid model blob digest');
    const blob = await stat(join(modelRoot, 'blobs', 'sha256', digest));
    if (!blob.isFile() || blob.size !== component.bytes) throw Error(`Missing or wrong-sized model blob ${digest}`);
  }
  const workdir = options.workdir;
  if (workdir === '/' || workdir === modelRoot || workdir.startsWith(modelRoot + sep) ||
      modelRoot.startsWith(workdir + sep)) throw Error('Work directory must be separate from model store');
  const normalConfig = resolve(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '/nonexistent', '.config'), 'cantor');
  const normalLibrary = resolve(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '/nonexistent', '.local/share'), 'cantor', 'library');
  for (const protectedPath of [normalConfig, normalLibrary]) {
    if (workdir === protectedPath || workdir.startsWith(protectedPath + sep) ||
        protectedPath.startsWith(workdir + sep)) throw Error('Work directory overlaps a default Cantor path');
  }
  const parent = await realpath(resolve(workdir, '..'));
  const space = await statfs(parent);
  if (space.bavail * space.bsize < 2 * 1024 ** 3) throw Error('At least 2 GiB free space is required');
  return {variant, modelRoot, freeBytes: space.bavail * space.bsize};
}

async function control(path, type) {
  return new Promise((resolveCall, rejectCall) => {
    const socket = createConnection(path);
    let data = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; socket.destroy();
      if (error) rejectCall(error); else resolveCall(value);
    };
    socket.setTimeout(10000);
    socket.on('connect', () => socket.write(JSON.stringify({v: 1, id: randomUUID(), t: type}) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      try { const response = JSON.parse(data.split('\n')[0]);
        finish(response.t === 'error' ? Error(response.msg) : null, response);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('timeout', () => finish(Error('Control socket timed out')));
  });
}

async function until(check, timeoutMs, delayMs = 1000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const result = await check();
    if (result) return result;
    await sleep(delayMs);
  }
  throw Error(`Timed out after ${timeoutMs} ms`);
}

function recordError(error) {
  return {error: error.message, code: error.code ?? 'unknown', ms: error.ms};
}

async function measured(report, context, kind, operation) {
  try {
    const value = await operation();
    report.records.push({...context, kind, at: Date.now(),
      ...(typeof value === 'number' ? {ms: value} : value)});
    return value;
  } catch (error) {
    report.records.push({...context, kind, at: Date.now(), ...recordError(error)});
    return null;
  }
}

async function verifyFixture(client, fixture, profile) {
  const reply = await client.request('song.get', {song_id: fixture.id});
  const song = reply.message.detail?.song;
  const artifact = song?.artifacts?.find(item => item.profile === profile);
  if (!artifact || artifact.sha256 !== fixture.sha256 || artifact.byte_length !== fixture.bytes)
    throw Error(`Fixture ${fixture.id} is missing or changed`);
}

async function prepare(clients, identities, options, fixtureFile) {
  let fixtures;
  try { fixtures = JSON.parse(await readFile(fixtureFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; fixtures = {}; }
  for (let i = 0; i < clients.length; i++) {
    const key = identities[i].publicKey;
    const songs = fixtures[key] ?? [];
    for (const song of songs) await verifyFixture(clients[i], song, options.profile);
    const existing = (await clients[i].request('jobs.list', {limit: 100})).message.jobs ?? [];
    for (const job of existing) {
      if (songs.length >= options.fixtures) break;
      if (job.state !== 'completed' ||
          !(job.caption?.startsWith(`Cantor stress fixture ${i + 1}/`) ||
            job.caption?.startsWith(`Cantor stress run user ${i + 1}:`)) ||
          songs.some(song => song.id === job.id)) continue;
      const detail = await clients[i].request('song.get', {song_id: job.id}).catch(() => null);
      const artifact = detail?.message.detail?.song?.artifacts?.find(a => a.profile === options.profile);
      if (artifact) songs.push({id: job.id, profile: options.profile,
        bytes: artifact.byte_length, sha256: artifact.sha256});
    }
    fixtures[key] = songs;
    await writeFile(fixtureFile, JSON.stringify(fixtures, null, 2), {mode: 0o600});
    while (songs.length < options.fixtures) {
      const response = await clients[i].request('job.create', {client_request_id: randomUUID(),
        model: options.model, generation: {caption: `Cantor stress fixture ${i + 1}/${songs.length + 1}: instrumental`,
          duration: options.duration, steps: options.steps}});
      if (response.message.t !== 'job.accepted') throw Error('Fixture job not accepted');
      const id = response.message.job.id;
      console.log(`Preparing fixture user ${i + 1}, song ${songs.length + 1}/${options.fixtures}: ${id}`);
      await until(async () => {
        const state = (await clients[i].request('job.get', {job_id: id})).message.job.state;
        if (state === 'failed' || state === 'cancelled') throw Error(`Fixture job ${id} ${state}`);
        return state === 'completed';
      }, options.fixtureTimeoutMs, 3000);
      const fixture = await until(async () => {
        const response = await clients[i].request('song.get', {song_id: id}).catch(error => {
          if (error.code === 'not_found') return null;
          throw error;
        });
        const artifact = response?.message.detail?.song?.artifacts?.find(a => a.profile === options.profile);
        return artifact ? {id, profile: options.profile, bytes: artifact.byte_length,
          sha256: artifact.sha256} : null;
      }, 120000, 3000);
      songs.push(fixture); fixtures[key] = songs;
      await writeFile(fixtureFile, JSON.stringify(fixtures, null, 2), {mode: 0o600});
    }
  }
  return fixtures;
}

async function readLoop(client, songs, end, report, context, signal) {
  let index = 0;
  let revision = 0;
  const kinds = ['library.list', 'song.get', 'library.sync', 'jobs.list', 'status'];
  await sleep((context.user - 1) * 230);
  while (!signal.aborted && performance.now() < end) {
    const kind = kinds[index % kinds.length];
    const song = songs[index % songs.length]; index++;
    await measured(report, context, kind, async () => {
      if (kind === 'song.get') return (await client.request(kind, {song_id: song.id})).ms;
      if (kind === 'library.sync') {
        const reply = await client.request(kind, {since_revision: revision, limit: 100});
        revision = reply.message.through_revision;
        return {ms: reply.ms, changes: reply.message.changes?.length ?? 0};
      }
      if (kind === 'jobs.list') return (await client.request(kind, {limit: 20})).ms;
      if (kind === 'status') return (await client.request(kind)).ms;
      const start = performance.now();
      let cursor = null, pages = 0, count = 0;
      do {
        const reply = await client.request('library.list', {limit: 100,
          ...(cursor ? {cursor} : {})});
        pages++;
        count += reply.message.songs?.length ?? 0;
        cursor = reply.message.next_cursor ?? null;
      } while (cursor);
      return {ms: performance.now() - start, pages, songs: count};
    });
    await sleep(5000);
  }
}

async function patchLoop(client, songs, end, report, context, signal) {
  let index = 0;
  await sleep((context.user - 1) * 310);
  while (!signal.aborted && performance.now() < end) {
    const song = songs[index % songs.length];
    await measured(report, context, 'song.patch', async () => {
      const detail = (await client.request('song.get', {song_id: song.id})).message.detail.song;
      const tags = detail.tags.filter(tag => tag !== 'stress/tag' && tag !== 'p/Stress playlist');
      const patch = index % 4 === 0 ? {tags: [...tags, 'stress/tag']} :
        index % 4 === 1 ? {tags: [...tags, 'p/Stress playlist']} :
        index % 4 === 2 ? {favorite: !detail.favorite} :
        {title: `Stress song ${context.user}-${index}`};
      index++;
      return (await client.request('song.patch', {song_id: song.id,
        expected_revision: detail.revision, patch})).ms;
    });
    await sleep(15000);
  }
}

async function downloadLoop(client, songs, end, report, context, signal) {
  let index = 0;
  await sleep((context.user - 1) * 170);
  while (!signal.aborted && performance.now() < end) {
    const song = songs[index++ % songs.length];
    const result = await measured(report, context, 'download', async () => ({
      ...(await client.download(song)), songId: song.id,
    }));
    if (result === null) await sleep(500);
  }
}

async function jobLoop(client, end, report, context, options, submitted) {
  const active = new Set();
  let sequence = 0;
  await sleep((context.user - 1) * 410);
  while (!options.signal.aborted && performance.now() < end) {
    if (active.size < options.maxOutstanding) {
      await measured(report, context, 'job.create', async () => {
        const reply = await client.request('job.create', {client_request_id: randomUUID(), model: options.model,
          generation: {caption: `Cantor stress run user ${context.user}: instrumental variation ${++sequence}`,
            duration: options.duration, steps: options.steps}});
        const job = reply.message.job;
        submitted.set(job.id, {user: context.user, acceptedAt: performance.now(),
          phase: context.phase, users: context.users, repetition: context.repetition});
        report.records.push({...context, kind: 'job.accepted', job: job.id,
          at: Date.now(), ms: reply.ms});
        active.add(job.id);
        return reply.ms;
      });
    }
    for (const id of active) {
      const reply = await measured(report, context, 'job.get', async () => {
        const value = await client.request('job.get', {job_id: id});
        observeJob(report, submitted, value.message.job, performance.now());
        return {ms: value.ms, state: value.message.job.state};
      });
      if (reply && terminal.has(reply.state)) active.delete(id);
    }
    await sleep(3000);
  }
}

function observeJob(report, submitted, job, timestamp) {
  const info = submitted.get(job.id);
  if (!info) return;
  if (!info.preparingAt && (job.state === 'preparing' || job.state === 'running')) {
    info.preparingAt = timestamp;
    report.records.push({...info, kind: 'job.queue_wait', job: job.id,
      at: Date.now(), ms: timestamp - info.acceptedAt});
  }
  if (!info.runningAt && job.state === 'running') info.runningAt = timestamp;
  if (!info.terminalAt && terminal.has(job.state)) {
    info.terminalAt = timestamp;
    if (info.runningAt) report.records.push({...info, kind: 'job.generation', job: job.id,
      at: Date.now(), ms: timestamp - info.runningAt, state: job.state});
    report.records.push({...info, kind: 'job.terminal', job: job.id,
      at: Date.now(), state: job.state});
  }
  report.records.push({...info, kind: 'job.state', job: job.id, state: job.state,
    stage: job.stage, atMonotonicMs: timestamp, at: Date.now()});
}

async function drain(primary, submitted, report, timeoutMs) {
  if (!submitted.size) return;
  await until(async () => {
    let remaining = 0;
    for (const [id, info] of submitted) {
      const response = await primary[info.user - 1].request('job.get', {job_id: id});
      const job = response.message.job;
      observeJob(report, submitted, job, performance.now());
      if (!terminal.has(job.state)) remaining++;
      else submitted.delete(id);
    }
    return remaining === 0;
  }, timeoutMs, 3000).catch(error => {
    for (const [id, info] of submitted) report.records.push({...info, kind: 'job.unfinished',
      job: id, unfinished: true, error: error.message, code: 'drain_timeout'});
    throw error;
  });
}

async function runMatrix(primary, identities, fixtures, nodeSocket, options, report, clients, submitted) {
  for (const users of options.levels) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      for (const phase of options.phases) {
        if (options.signal.aborted) throw Error('Interrupted');
        if (phase === 'idle') await drain(primary, submitted, report, options.drainTimeoutMs);
        const extras = [];
        if (phase === 'burst') {
          const uri = new URL((await control(nodeSocket, 'pair')).uri);
          uri.searchParams.delete('token');
          for (let i = 0; i < users; i++) for (let j = 0; j < 5; j++) {
            const client = await new StressClient(uri.toString(), identities[i]).connect();
            extras.push({client, user: i + 1, song: fixtures[identities[i].publicKey][j]});
            clients.push(client);
          }
        }
        console.log(`${users} user(s), ${phase}, repetition ${repetition}/${options.repetitions}: ${options.seconds}s`);
        const end = performance.now() + options.seconds * 1000;
        const tasks = [];
        for (let i = 0; i < users; i++) {
          const context = {users, phase, repetition, user: i + 1};
          const songs = fixtures[identities[i].publicKey];
          tasks.push(readLoop(primary[i], songs, end, report, context, options.signal));
          tasks.push(patchLoop(primary[i], songs, end, report, context, options.signal));
          if (phase !== 'burst') tasks.push(downloadLoop(primary[i], songs, end, report, context, options.signal));
          if (phase !== 'idle') tasks.push(jobLoop(primary[i], end, report, context, options, submitted));
        }
        for (const item of extras) tasks.push(downloadLoop(item.client, [item.song], end, report,
          {users, phase, repetition, user: item.user}, options.signal));
        const outcomes = await Promise.allSettled(tasks);
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
        for (const item of extras) item.client.close();
        if (options.signal.aborted) throw Error('Interrupted');
        await drain(primary, submitted, report, options.drainTimeoutMs);
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const abort = new AbortController();
  options.signal = abort.signal;
  const pre = await preflight(options);
  console.log(`Stress node: ${options.workdir}; model ${options.model}; relay ${options.relay}`);
  console.log(`Plan: ${options.users} identities, levels ${options.levels}, phases ${options.phases}, ${options.seconds}s × ${options.repetitions}`);
  if (options.dryRun) { console.log(`Dry run: ${pre.freeBytes} free bytes; no files or processes created`); return; }
  const root = options.workdir;
  const configDir = join(root, 'node');
  const libraryDir = join(root, 'library');
  const reportsDir = join(root, 'reports');
  const socket = join(root, 'control.sock');
  for (const directory of [root, configDir, reportsDir]) await mkdir(directory, {recursive: true, mode: 0o700});
  const configFile = join(configDir, 'node.toml');
  const desired = `name = "cantor-stress"\nrelay_url = ${JSON.stringify(options.relay)}\nmodel_dir = ${JSON.stringify(options.modelDir)}\nlibrary_dir = ${JSON.stringify(libraryDir)}\npairings = []\n`;
  try {
    const existing = await readFile(configFile, 'utf8');
    for (const entry of [`relay_url = ${JSON.stringify(options.relay)}`,
      `model_dir = ${JSON.stringify(options.modelDir)}`,
      `library_dir = ${JSON.stringify(libraryDir)}`]) {
      if (!existing.includes(entry)) throw Error('Existing stress config differs from selected paths or relay');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(configFile, desired, {mode: 0o600, flag: 'wx'});
  }
  const child = spawn(options.nodeBin, ['run', '--config-dir', configDir, '--control-socket', socket],
    {stdio: ['ignore', 'pipe', 'pipe']});
  const base = `stress-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}`;
  const liveLog = createWriteStream(join(reportsDir, `${base}.node.log`), {flags: 'wx', mode: 0o600});
  const liveSamples = createWriteStream(join(reportsDir, `${base}.samples.jsonl`), {flags: 'wx', mode: 0o600});
  let exit = null;
  child.on('exit', (code, signal) => { exit = {code, signal}; });
  const clients = [];
  const submitted = new Map();
  const report = {started: new Date().toISOString(), configuration: options,
    variant: {model: pre.variant.model, tag: pre.variant.tag, engine: pre.variant.engine},
    machine: await machineInfo(), records: [], samples: [], nodeLog: []};
  const ticksPerSecond = await clockTicksPerSecond();
  let lastSample = null;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    const line = data.toString();
    report.nodeLog.push({at: Date.now(), text: line});
    liveLog.write(line);
    if (options.verbose) process.stderr.write(line);
  });
  let sampler;
  let failure;
  const stop = () => { failure = Error('Interrupted'); abort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    sampler = setInterval(async () => {
      try {
        const at = Date.now();
        const availableBytes = await availableMemoryBytes();
        const process = await processSample(child.pid);
        if (lastSample && ticksPerSecond && Number.isFinite(process.cpuTicks)) {
          process.cpuPercent = (process.cpuTicks - lastSample.cpuTicks) * 100000 /
            (ticksPerSecond * (at - lastSample.at));
        }
        lastSample = {at, cpuTicks: process.cpuTicks};
        const sample = {at, availableBytes, process, gpu: report.machine.gpu ? await gpuSample() : null};
        report.samples.push(sample);
        liveSamples.write(JSON.stringify(sample) + '\n');
        if (availableBytes < options.minimumAvailableMiB * 1024 ** 2 && !abort.signal.aborted) {
          failure = Error(`Available RAM fell below ${options.minimumAvailableMiB} MiB`);
          abort.abort(); child.kill('SIGTERM');
        }
      } catch (error) {
        const sample = {at: Date.now(), error: error.message};
        report.samples.push(sample);
        liveSamples.write(JSON.stringify(sample) + '\n');
      }
    }, 1000);
    await until(async () => {
      if (exit) throw Error(`Node exited during startup: ${JSON.stringify(exit)}`);
      const status = await control(socket, 'status').catch(() => null);
      return status?.connected ? status : null;
    }, 90000, 500);
    await installBackend(options, socket);
    const identities = [];
    const primary = [];
    for (let i = 0; i < options.users; i++) {
      const identity = await loadOrCreateIdentity(join(root, `user-${i + 1}.json`));
      identities.push(identity);
      const paired = (await control(socket, 'pairings')).pairings.some(p => p.key === identity.publicKey);
      const uri = new URL((await control(socket, 'pair')).uri);
      if (paired) uri.searchParams.delete('token');
      const user = i + 1;
      const client = await new StressClient(uri.toString(), identity, (job, at) => {
        observeJob(report, submitted, job, at);
      }).connect();
      primary.push(client); clients.push(client);
      report.records.push({kind: 'connect', user, ms: client.connectMs, at: Date.now()});
    }
    const fixtureFile = join(root, 'fixtures.json');
    let fixtures;
    if (options.phase !== 'run') fixtures = await prepare(primary, identities, options, fixtureFile);
    else fixtures = JSON.parse(await readFile(fixtureFile, 'utf8'));
    if (options.phase !== 'prepare') {
      for (let i = 0; i < options.users; i++) {
        const songs = fixtures[identities[i].publicKey] ?? [];
        if (songs.length < options.fixtures) throw Error(`User ${i + 1} needs ${options.fixtures} fixtures`);
        for (const song of songs.slice(0, options.fixtures)) await verifyFixture(primary[i], song, options.profile);
      }
      await runMatrix(primary, identities, fixtures, socket, options, report, clients, submitted);
    }
    if (failure) throw failure;
  } catch (error) {
    failure = error;
    console.error(`Stress run stopped: ${error.message}`);
  } finally {
    clearInterval(sampler);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    for (const client of clients) client.close();
    if (exit === null) {
      child.kill('SIGTERM');
      await new Promise(done => {
        const timer = setTimeout(done, 30000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
    }
    report.finished = new Date().toISOString();
    report.failure = failure?.message ?? null;
    report.summary = summarize(report.records);
    await writeFile(join(reportsDir, `${base}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(reportsDir, `${base}.md`), markdownReport(report));
    liveLog.end(); liveSamples.end();
    console.log(`Reports: ${join(reportsDir, base)}.{json,md}`);
  }
  if (failure) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await main();
}
