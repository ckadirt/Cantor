import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
}

export function summarize(records) {
  const buckets = new Map();
  for (const record of records) {
    if (!record.phase || !record.kind ||
        ['job.state', 'job.accepted', 'job.terminal'].includes(record.kind)) continue;
    const key = `${record.users}/${record.phase}/${record.repetition}/${record.kind}`;
    const bucket = buckets.get(key) ?? {latencies: [], rates: [], errors: {}, stalls: 0, bytes: 0,
      unfinished: 0};
    buckets.set(key, bucket);
    if (record.error) bucket.errors[record.code ?? 'unknown'] =
      (bucket.errors[record.code ?? 'unknown'] ?? 0) + 1;
    else if (Number.isFinite(record.ms)) bucket.latencies.push(record.ms);
    if (!record.error && Number.isFinite(record.bytesPerSecond)) bucket.rates.push(record.bytesPerSecond);
    bucket.stalls += record.stalls ?? 0;
    bucket.bytes += record.bytes ?? 0;
    if (record.unfinished) bucket.unfinished++;
  }
  return Object.fromEntries([...buckets].map(([key, bucket]) => {
    const sorted = bucket.latencies.sort((a, b) => a - b);
    const rates = bucket.rates.sort((a, b) => a - b);
    return [key, {successes: sorted.length, errors: bucket.errors,
      p50Ms: percentile(sorted, .5), p95Ms: percentile(sorted, .95),
      p99Ms: percentile(sorted, .99), maxMs: sorted.at(-1) ?? null,
      p50BytesPerSecond: percentile(rates, .5),
      stalls: bucket.stalls, bytes: bucket.bytes, unfinished: bucket.unfinished}];
  }));
}

export function markdownReport(run) {
  const rows = Object.entries(run.summary).sort((a, b) => a[0].localeCompare(b[0], undefined, {numeric: true}))
    .map(([key, item]) => {
      const [users, phase, repetition, operation] = key.split('/');
      const errors = Object.entries(item.errors).map(([code, count]) => `${code}:${count}`).join(', ') || '0';
      const ms = value => value === null ? '—' : value.toFixed(1);
      const kib = item.p50BytesPerSecond === null ? '—' : (item.p50BytesPerSecond / 1024).toFixed(1);
      return `| ${users} | ${phase} | ${repetition} | ${operation} | ${item.successes} | ${errors} | ${ms(item.p50Ms)} | ${ms(item.p95Ms)} | ${ms(item.p99Ms)} | ${ms(item.maxMs)} | ${item.stalls} | ${item.bytes} | ${kib} |`;
    });
  return `# Cantor stress run\n\nStarted: ${run.started}\n\nModel: ${run.configuration.model}  
Relay: ${run.configuration.relay}  
Node binary: ${run.configuration.nodeBin}  
Machine: ${run.machine.platform} ${run.machine.arch}, ${run.machine.cpus} CPUs, ${run.machine.totalMemoryBytes} bytes RAM  
GPU: ${run.machine.gpu ?? 'unavailable'}\n\n` +
    `| Users | Phase | Repeat | Operation | Success | Errors | p50 ms | p95 ms | p99 ms | Max ms | Stalls | Bytes | p50 KiB/s |\n` +
    `| ---: | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n` +
    `${rows.join('\n')}\n\n` +
    `Raw events, job states, process samples, and configuration are in the paired JSON report.\n`;
}

export async function machineInfo() {
  let gpu = null;
  try {
    const result = await execFileAsync('nvidia-smi',
      ['--query-gpu=name', '--format=csv,noheader'], {timeout: 3000});
    gpu = result.stdout.trim().split('\n').join(', ');
  } catch {}
  return {platform: os.platform(), release: os.release(), arch: os.arch(),
    cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    totalMemoryBytes: os.totalmem(), gpu};
}

export async function processSample(pid) {
  if (process.platform !== 'linux') return {unavailable: 'Process sampling requires Linux'};
  const [stat, status, io] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'),
    readFile(`/proc/${pid}/io`, 'utf8')]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const value = (source, key) => Number(source.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  return {state: fields[0], cpuTicks: Number(fields[11]) + Number(fields[12]),
    rssKb: value(status, 'VmRSS'), readBytes: value(io, 'read_bytes'),
    writeBytes: value(io, 'write_bytes')};
}

export async function availableMemoryBytes() {
  if (process.platform !== 'linux') return os.freemem();
  const meminfo = await readFile('/proc/meminfo', 'utf8');
  const kib = Number(meminfo.match(/^MemAvailable:\s+(\d+) kB/m)?.[1]);
  return Number.isFinite(kib) ? kib * 1024 : os.freemem();
}

export async function gpuSample() {
  try {
    const {stdout} = await execFileAsync('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'],
      {timeout: 2000});
    return stdout.trim().split('\n').map(row => {
      const [utilizationPercent, memoryMiB] = row.split(',').map(x => Number(x.trim()));
      return {utilizationPercent, memoryMiB};
    });
  } catch { return null; }
}

export async function clockTicksPerSecond() {
  if (process.platform !== 'linux') return null;
  try {
    const {stdout} = await execFileAsync('getconf', ['CLK_TCK'], {timeout: 2000});
    const ticks = Number(stdout.trim());
    return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
  } catch { return null; }
}
