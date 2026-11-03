/**
 * Named timings on both threads, read from logcat. Never shipped on.
 *
 * `uiSpan` / `jsSpan` add one measured span under a label; every
 * `DUMP_MS` the JS thread reads both rings, and if anything was recorded it
 * logs one summary per thread through `console.warn` (the only log a release
 * build sends to logcat): per label the count, total and longest span, then
 * every span longer than `SLOW_MS`, with its wall-clock time so the two
 * threads, a perfetto trace and a screen recording can be lined up.
 *
 * Read it with `adb logcat -s ReactNativeJS:W | grep PROBE`.
 */
import { useLayoutEffect } from 'react';
import { runOnJS, runOnUI, useFrameCallback } from 'react-native-reanimated';

/** Flip on for a measuring build; committed off. */
export const PERF_PROBE_ON = false;

// knobs
const DUMP_MS = 1500;
const SLOW_MS = 12;
const GAP_MS = 25;
const RING = 4000;

type Span = { label: string; ms: number; at: number };
type Ring = { spans: Span[] };

export function probeNow(): number {
  'worklet';
  const g = globalThis as unknown as { performance?: { now(): number } };
  return g.performance !== undefined ? g.performance.now() : Date.now();
}

function uiRing(): Ring {
  'worklet';
  const g = globalThis as unknown as { __cantorProbe?: Ring };
  if (g.__cantorProbe === undefined) g.__cantorProbe = { spans: [] };
  return g.__cantorProbe;
}

/** On the UI thread: a span that began at `start` (`probeNow()`). */
export function uiSpan(label: string, start: number): void {
  'worklet';
  if (!PERF_PROBE_ON) return;
  const ring = uiRing();
  if (ring.spans.length >= RING) return;
  ring.spans.push({ label, ms: probeNow() - start, at: Date.now() });
}

/** On the UI thread: a duration measured some other way (a thread hop). */
export function uiRecord(label: string, ms: number): void {
  'worklet';
  if (!PERF_PROBE_ON) return;
  const ring = uiRing();
  if (ring.spans.length >= RING) return;
  ring.spans.push({ label, ms, at: Date.now() });
}

/** On the UI thread: a moment, logged with its wall-clock time. */
export function uiMark(label: string): void {
  'worklet';
  if (!PERF_PROBE_ON) return;
  const ring = uiRing();
  if (ring.spans.length >= RING) return;
  ring.spans.push({ label: `@${label}`, ms: -1, at: Date.now() });
}

const jsRing: Ring = { spans: [] };

/** On the JS thread: a moment, logged with its wall-clock time. */
export function jsMark(label: string): void {
  if (!PERF_PROBE_ON) return;
  if (jsRing.spans.length >= RING) return;
  jsRing.spans.push({ label: `@${label}`, ms: -1, at: Date.now() });
}

/** On the JS thread: a span that began at `start` (`probeNow()`). */
export function jsSpan(label: string, start: number): void {
  if (!PERF_PROBE_ON) return;
  if (jsRing.spans.length >= RING) return;
  jsRing.spans.push({ label, ms: probeNow() - start, at: Date.now() });
}

/** Times `fn` on the JS thread under `label`. */
export function jsTimed<T>(label: string, fn: () => T): T {
  if (!PERF_PROBE_ON) return fn();
  const start = probeNow();
  const out = fn();
  jsSpan(label, start);
  return out;
}

function summarise(thread: string, spans: readonly Span[]): string {
  const by: Record<string, { n: number; total: number; max: number }> = {};
  const marks = spans
    .filter(span => span.ms < 0)
    .map(span => `  @ ${span.at % 100000} ${span.label.slice(1)}`);
  for (const span of spans) {
    if (span.ms < 0) continue;
    const entry = by[span.label] ?? { n: 0, total: 0, max: 0 };
    entry.n += 1;
    entry.total += span.ms;
    entry.max = Math.max(entry.max, span.ms);
    by[span.label] = entry;
  }
  const lines = Object.entries(by)
    .sort((a, b) => b[1].total - a[1].total)
    .map(
      ([label, e]) =>
        `  ${label}: n=${e.n} total=${e.total.toFixed(1)} avg=${(
          e.total / e.n
        ).toFixed(2)} max=${e.max.toFixed(1)}`,
    );
  const slow = spans
    .filter(span => span.ms >= SLOW_MS)
    .map(span => `  ! ${span.at % 100000} ${span.label} ${span.ms.toFixed(1)}`);
  return `PROBE ${thread}\n${lines.join('\n')}\n${slow.join('\n')}${
    marks.length > 0 ? `\n${marks.join('\n')}` : ''
  }`;
}

function logUi(spans: Span[]) {
  if (spans.length > 0) console.warn(summarise('UI', spans));
}

let started = false;

/** Starts the periodic dump; call once, from the app's root. */
export function startPerfProbe(): void {
  if (!PERF_PROBE_ON || started) return;
  started = true;
  setInterval(() => {
    if (jsRing.spans.length > 0) {
      const spans = jsRing.spans;
      jsRing.spans = [];
      console.warn(summarise('JS', spans));
    }
    runOnUI(() => {
      'worklet';
      const ring = uiRing();
      if (ring.spans.length === 0) return;
      const spans = ring.spans;
      ring.spans = [];
      runOnJS(logUi)(spans);
    })();
  }, DUMP_MS);
}

/** Records every UI frame gap longer than `SLOW_MS` as `ui.frameGap`. */
export function useFrameGapProbe(): void {
  useFrameCallback(frame => {
    'worklet';
    const gap = frame.timeSincePreviousFrame;
    if (gap !== null && gap >= GAP_MS) uiRecord('ui.frameGap', gap);
  }, PERF_PROBE_ON);
}

/**
 * Times a component's render through its commit: call at the top of the
 * component body. The span closes in a layout effect, which runs after every
 * child's own, so it covers the whole subtree's render and layout effects.
 */
export function useRenderProbe(label: string): void {
  const start = PERF_PROBE_ON ? probeNow() : 0;
  useLayoutEffect(() => {
    if (PERF_PROBE_ON) jsSpan(label, start);
  });
}

