#!/usr/bin/env node
// Synthetic songs whose beats and sections are known, for the motion analysis
// (docs/interfacealpha/reactive-player-plan.md, M0 and M2).
//
// Real songs have no ground truth and cannot be committed; these can be made
// again bit for bit from this file. Each is written as a 16-bit WAV beside a
// `.truth.json` holding its beats, downbeats and sections.
//
//   node scripts/motion-synth.mjs <out-dir>
//
// form-48k     120 BPM, 4/4, kick equal on 1 and 3 in the verse (the case that
//              fools the downbeat guess), sections A B C B C A', the chorus
//              louder and lower, so a drop at each chorus.
// form-96k-mono the same song, mono, at 96 kHz: every FFT sized from the rate.
// tempo-44k    96 BPM for 24 bars, then 128 BPM for 32.
// drone-48k    chords and air, no beat at all.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: motion-synth.mjs <out-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let d = Math.imul(s ^ (s >>> 15), 1 | s);
    d = (d + Math.imul(d ^ (d >>> 7), 61 | d)) ^ d;
    return ((d ^ (d >>> 14)) >>> 0) / 4294967296;
  };
}
const midiHz = m => 440 * 2 ** ((m - 69) / 12);

class Track {
  constructor(rate, seconds) {
    this.rate = rate;
    this.L = new Float32Array(Math.ceil(rate * seconds));
    this.R = new Float32Array(this.L.length);
    this.noise = mulberry32(7);
  }
  /** Add `fn(t)` from `at` for `length` seconds, panned `pan` (-1..1). */
  add(at, length, pan, fn) {
    const i0 = Math.round(at * this.rate), n = Math.round(length * this.rate);
    const gl = Math.min(1, 1 - pan), gr = Math.min(1, 1 + pan);
    for (let i = 0; i < n && i0 + i < this.L.length; i++) {
      const v = fn(i / this.rate);
      this.L[i0 + i] += v * gl;
      this.R[i0 + i] += v * gr;
    }
  }
  kick(at, gain = 1) {
    let phase = 0;
    this.add(at, 0.45, 0, t => {
      phase += (2 * Math.PI * (45 + 110 * Math.exp(-t / 0.03))) / this.rate;
      return 0.9 * gain * Math.sin(phase) * Math.exp(-t / 0.22);
    });
  }
  snare(at, gain = 1) {
    let prev = 0;
    this.add(at, 0.3, 0.1, t => {
      const n = this.noise() * 2 - 1, hp = n - prev;
      prev = n;
      return gain * (0.35 * hp * Math.exp(-t / 0.11) + 0.3 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.07));
    });
  }
  hat(at, gain = 1) {
    let a = 0, b = 0;
    this.add(at, 0.08, -0.3, t => {
      const n = this.noise() * 2 - 1, d1 = n - a, d2 = d1 - b;
      a = n;
      b = d1;
      return gain * 0.12 * d2 * Math.exp(-t / 0.025);
    });
  }
  /** A held chord of MIDI notes, soft attack and release. */
  pad(at, length, notes, gain = 1) {
    const hz = notes.map(midiHz);
    this.add(at, length + 0.4, 0, t => {
      const env = Math.min(1, t / 0.25) * (t > length ? Math.max(0, 1 - (t - length) / 0.4) : 1);
      let v = 0;
      for (const f of hz) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.003 * t);
      return (gain * 0.05 * env * v);
    });
  }
  bass(at, length, note, gain = 1) {
    const f = midiHz(note);
    this.add(at, length, 0, t => {
      const env = Math.min(1, t / 0.01) * Math.exp(-t / 0.5);
      return gain * 0.35 * env * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t));
    });
  }
  /** One song's mix written as 16-bit PCM, peak-normalised to -1 dBFS. */
  write(path, mono = false) {
    let peak = 1e-9;
    for (let i = 0; i < this.L.length; i++) peak = Math.max(peak, Math.abs(this.L[i]), Math.abs(this.R[i]));
    const gain = 0.89 / peak, channels = mono ? 1 : 2, frames = this.L.length;
    const data = Buffer.alloc(frames * channels * 2);
    for (let i = 0; i < frames; i++) {
      const l = this.L[i] * gain, r = this.R[i] * gain;
      if (mono) data.writeInt16LE(Math.round(((l + r) / 2) * 32767), i * 2);
      else {
        data.writeInt16LE(Math.round(l * 32767), i * 4);
        data.writeInt16LE(Math.round(r * 32767), i * 4 + 2);
      }
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(this.rate, 24);
    header.writeUInt32LE(this.rate * channels * 2, 28);
    header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    writeFileSync(path, Buffer.concat([header, data]));
  }
}

// Am F C G for the verse, F G Am Am for the chorus, as MIDI triads.
const CHORDS = {
  Am: [57, 60, 64], F: [53, 57, 60], C: [48, 52, 55], G: [55, 59, 62], Dm: [50, 53, 57], E: [52, 56, 59],
};

/** The form song at `rate`: returns its truth. */
function formSong(rate, name, mono) {
  const bpm = 120, beat = 60 / bpm, bar = beat * 4;
  const plan = [
    ['A', 8], ['B', 8], ['C', 8], ['B', 8], ['C', 8], ['A', 4],
  ];
  const bars = plan.reduce((s, [, n]) => s + n, 0);
  const track = new Track(rate, bars * bar + 2);
  const beats = [], sections = [];
  let b0 = 0;
  for (const [label, n] of plan) {
    sections.push({ t0: b0 * bar, t1: (b0 + n) * bar, label });
    for (let k = 0; k < n; k++) {
      const t = (b0 + k) * bar, chorus = label === 'C', verse = label === 'B';
      const progression = chorus ? ['F', 'G', 'Am', 'Am'] : verse ? ['Am', 'F', 'C', 'G'] : ['Am', 'Dm', 'Am', 'E'];
      const chord = CHORDS[progression[k % 4]];
      track.pad(t, bar, chorus ? chord.map(m => m + 12).concat(chord) : chord, chorus ? 1.2 : label === 'A' ? 0.6 : 0.8);
      for (let q = 0; q < 4; q++) {
        const at = t + q * beat;
        beats.push({ t: at, down: q === 0 });
        if (label !== 'A') {
          if (chorus || q === 0 || q === 2) track.kick(at, chorus ? 1.2 : 1); // verse: equal on 1 and 3
          if (q === 1 || q === 3) track.snare(at, chorus ? 1.1 : 0.9);
          track.bass(at, beat, chord[0] - 24, chorus ? 1.4 : 0.8);
        }
        track.hat(at, 0.8);
        track.hat(at + beat / 2, label === 'A' ? 0.4 : 0.6);
      }
    }
    b0 += n;
  }
  track.write(join(out, `${name}.wav`), mono);
  return { name, rate, channels: mono ? 1 : 2, bpm, beats, sections };
}

function tempoSong(rate, name) {
  const parts = [[96, 24], [128, 32]];
  const seconds = parts.reduce((s, [bpm, n]) => s + (n * 4 * 60) / bpm, 0);
  const track = new Track(rate, seconds + 2);
  const beats = [], sections = [];
  let t = 0;
  parts.forEach(([bpm, n], p) => {
    const beat = 60 / bpm;
    sections.push({ t0: t, t1: t + n * 4 * beat, label: p ? 'B' : 'A' });
    for (let k = 0; k < n; k++) {
      const chord = CHORDS[['Am', 'F', 'C', 'G'][k % 4]];
      track.pad(t, beat * 4, chord, 0.8);
      for (let q = 0; q < 4; q++) {
        beats.push({ t, down: q === 0 });
        track.kick(t, q === 0 ? 1.2 : 0.9);
        if (q % 2) track.snare(t);
        track.hat(t, 0.7);
        track.hat(t + beat / 2, 0.5);
        track.bass(t, beat, chord[0] - 24);
        t += beat;
      }
    }
  });
  track.write(join(out, `${name}.wav`));
  return { name, rate, channels: 2, bpm: null, beats, sections };
}

function droneSong(rate, name) {
  const track = new Track(rate, 75);
  const order = ['Am', 'F', 'C', 'G', 'Dm', 'Am', 'E', 'Am'];
  // Chords that change every 9.3 s, overlapping: nothing lands on a grid.
  order.forEach((c, i) => track.pad(i * 9.3, 11, CHORDS[c].concat(CHORDS[c].map(m => m - 12)), 1));
  let prev = 0;
  track.add(0, 75, 0, t => {
    const n = track.noise() * 2 - 1;
    prev = 0.995 * prev + 0.005 * n;
    return 0.6 * prev * (0.6 + 0.4 * Math.sin(t * 0.21));
  });
  track.write(join(out, `${name}.wav`));
  return { name, rate, channels: 2, bpm: null, beats: [], sections: [] };
}

const truths = [
  formSong(48000, 'form-48k', false),
  formSong(96000, 'form-96k-mono', true),
  tempoSong(44100, 'tempo-44k'),
  droneSong(48000, 'drone-48k'),
];
for (const truth of truths) {
  writeFileSync(join(out, `${truth.name}.truth.json`), JSON.stringify(truth) + '\n');
  console.log(`${truth.name}: ${truth.beats.length} beats, ${truth.sections.length} sections`);
}
