import { detectPitch, medianSemitone, semitones, steadyPitch } from '../pitch';

const RATE = 16000;
const FRAME = 1024;

function tone(hz: number, amplitude = 0.4, harmonics = false): Float32Array {
  const out = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) {
    const t = i / RATE;
    out[i] = amplitude * Math.sin(2 * Math.PI * hz * t);
    // A hummed note is not a sine: give it a voice's overtones.
    if (harmonics) {
      out[i] += amplitude * 0.5 * Math.sin(2 * Math.PI * 2 * hz * t);
      out[i] += amplitude * 0.25 * Math.sin(2 * Math.PI * 3 * hz * t);
    }
  }
  return out;
}

describe('detectPitch', () => {
  it.each([110, 196, 261.63, 440, 880])(
    'reads %f Hz within a few cents',
    hz => {
      const frame = detectPitch(tone(hz), RATE);
      expect(frame).not.toBeNull();
      const cents = 1200 * Math.log2((frame?.hz ?? 0) / hz);
      expect(Math.abs(cents)).toBeLessThan(10);
    },
  );

  it('reads the fundamental of a voiced note, not an overtone', () => {
    const frame = detectPitch(tone(150, 0.3, true), RATE);
    expect(Math.abs(1200 * Math.log2((frame?.hz ?? 0) / 150))).toBeLessThan(15);
  });

  it('calls silence and noise unvoiced', () => {
    expect(detectPitch(new Float32Array(FRAME), RATE)).toBeNull();
    let seed = 7;
    const noise = new Float32Array(FRAME).map(() => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648 - 0.5) * 0.6;
    });
    expect(detectPitch(noise, RATE)).toBeNull();
  });
});

describe('semitones', () => {
  it('counts from A4 and doubles per octave', () => {
    expect(semitones(440)).toBeCloseTo(0);
    expect(semitones(880)).toBeCloseTo(12);
    expect(medianSemitone([null, 1, 5, 3, null])).toBe(3);
    expect(medianSemitone([null])).toBeNull();
  });
});

describe('steadyPitch', () => {
  it('pulls an octave slip back to its neighbours', () => {
    expect(steadyPitch([0, 0.5, 12.2, 1, 1.5])).toEqual([0, 0.5, 1, 1, 1.5]);
  });

  it('draws through a dropout but lifts at a breath', () => {
    expect(steadyPitch([0, 0, 0, null, 2, 2, 2])).toEqual([
      0, 0, 0, 1, 2, 2, 2,
    ]);
    expect(steadyPitch([0, 0, 0, null, null, null, 2, 2, 2])).toEqual([
      0,
      0,
      0,
      null,
      null,
      null,
      2,
      2,
      2,
    ]);
  });

  it('lifts a speck too short to be a note', () => {
    expect(steadyPitch([null, 4, null, null, null, 1, 1, 1])).toEqual([
      null,
      null,
      null,
      null,
      null,
      1,
      1,
      1,
    ]);
  });
});
