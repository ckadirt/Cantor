#!/usr/bin/env node
// The native motion analysis against the page's, song by song (the reactive
// player's M2 exit): builds `motion-host.cpp` with the system compiler, runs
// it on each fixture's audio and compares with that fixture's reference JSON.
//
//   node scripts/motion-check.mjs <fixtures-dir> [name …]
//
// <fixtures-dir> holds `reference/<name>.motion.json` and the audio under
// `audio/` or `synth/` (docs/interfacealpha/motion-fixtures on Cesar's disk).
// Tolerances are the plan's: beats ±10 ms, the same sections and letters,
// drops ±1 beat.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [dir, ...only] = process.argv.slice(2);
if (!dir) {
  console.error('usage: motion-check.mjs <fixtures-dir> [name …]');
  process.exit(2);
}
const binary = '/tmp/motion-host';
const motion = resolve(here, '../android/app/src/main/cpp/motion');
execFileSync('gcc', ['-O2', '-march=native', '-c', '-o', '/tmp/motion-pffft.o', join(motion, 'pffft/pffft_double.c')], { stdio: 'inherit' });
execFileSync('g++', ['-std=c++20', '-O2', '-Wall', '-Wextra', '-Werror', '-o', binary, join(here, 'motion-host.cpp'),
  join(motion, 'MotionAnalysis.cpp'), '/tmp/motion-pffft.o'], { stdio: 'inherit' });

function audioFor(name) {
  for (const sub of ['audio', 'synth']) {
    for (const file of existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []) {
      if (file.replace(/\.[^.]+$/, '') === name && !file.endsWith('.json')) return join(dir, sub, file);
    }
  }
  return null;
}

function run(path) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels', '-of', 'json', path]).toString()).streams[0];
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-f', 'f32le',
    '-acodec', 'pcm_f32le', '-'], { maxBuffer: 4 << 30 });
  const out = spawnSync(binary, [probe.sample_rate, probe.channels], { input: pcm, maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString());
}

/** Share of `a`'s times with a time in `b` within `tol`. */
function matched(a, b, tol) {
  if (!a.length) return b.length ? 0 : 1;
  let j = 0, hit = 0;
  for (const t of a) {
    while (j < b.length && b[j] < t - tol) j++;
    if (j < b.length && Math.abs(b[j] - t) <= tol) hit++;
  }
  return hit / a.length;
}

const pct = x => `${(100 * x).toFixed(1)}%`;
const names = only.length ? only : readdirSync(join(dir, 'reference')).map(f => basename(f, '.motion.json'));
let failed = 0;
const rows = [];
for (const name of names) {
  const ref = JSON.parse(readFileSync(join(dir, 'reference', `${name}.motion.json`), 'utf8'));
  const audio = audioFor(name);
  if (!audio) { console.log(`${name}: no audio`); continue; }
  const got = run(audio);
  const rb = ref.beats.map(b => b[1]), gb = got.beats.map(b => b[1]);
  const beatHit = Math.min(matched(rb, gb, 0.0105), matched(gb, rb, 0.0105));
  const downs = (list) => list.filter(b => b[2]).map(b => b[1]);
  const downHit = matched(downs(ref.beats), downs(got.beats), 0.0105);
  const onsetHit = [0, 1, 2].map(k => Math.min(
    matched(ref.onsets[k].map(o => o[1]), got.onsets[k].map(o => o[1]), 0.0105),
    matched(got.onsets[k].map(o => o[1]), ref.onsets[k].map(o => o[1]), 0.0105)));
  const rs = ref.structure, gs = got.structure;
  const form = s => (s ? s.segments.map(x => String.fromCharCode(65 + x.label)).join('') : '—');
  const beat = 60 / ref.bpm;
  const sameForm = form(rs) === form(gs);
  const cutsOk = !rs || !gs ? rs === gs : rs.segments.length === gs.segments.length &&
    rs.segments.every((s, i) => Math.abs(s.t0 - gs.segments[i].t0) <= beat);
  const dropsOk = !rs || !gs ? true : rs.drops.length === gs.drops.length &&
    rs.drops.every((d, i) => Math.abs(d.t - gs.drops[i].t) <= beat);
  const curve = k => Math.max(0, ...ref.curves[k].map((v, i) => Math.abs(v - (got.curves[k][i] ?? 0))));
  const ok = beatHit >= 0.98 && sameForm && cutsOk && dropsOk;
  if (!ok) failed++;
  rows.push(`| ${name} | ${ok ? 'ok' : 'FAIL'} | ${ref.bpm.toFixed(2)} / ${got.bpm.toFixed(2)} | ${ref.beats.length} / ${got.beats.length} | ${pct(beatHit)} | ${pct(downHit)} | ${onsetHit.map(pct).join(' ')} | ${form(rs)} / ${form(gs)} | ${rs ? rs.drops.length : 0} / ${gs ? gs.drops.length : 0} | ${curve('loud').toExponential(1)} | ${got.confidence.toFixed(2)} (${got.periodicity.toFixed(3)}, ${got.snapped.toFixed(2)}) | ${got.timing.features.toFixed(2)} + ${got.timing.song.toFixed(2)} s |`);
}
console.log('| Fixture | | BPM page / port | Beats | Beats ±10 ms | Downbeats | Onsets L M H | Form page / port | Drops | Loud Δ | Confidence (period, snapped) | Host time |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
rows.forEach(r => console.log(r));
process.exit(failed ? 1 : 0);
