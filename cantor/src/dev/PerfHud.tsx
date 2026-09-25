/**
 * A readout of where the frame budget goes. Never shipped on.
 *
 * UI: frames the UI thread ran, and how many of them took longer than 1.5
 * refreshes. JS: frames the JS thread managed, from its own rAF loop, which is
 * what starves first when React re-renders too much. COMMITS: React commits
 * inside the `PerfProfiler` boundary. All per second, over a one-second window.
 *
 * The UI counter is itself a frame callback, so while the HUD is mounted the
 * UI thread never idles. Read heat with the HUD off (`scripts/perf-sample.sh`).
 */
import React, { Profiler, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFrameCallback, useSharedValue } from 'react-native-reanimated';

// knobs
const WINDOW_MS = 1000; // how often the readout is refreshed
const SLOW_FRAME_RATIO = 1.5; // a UI frame this many refreshes long is a drop

let commits = 0;

/** Counts React commits of everything inside it. */
export function PerfProfiler({ children }: { children: React.ReactNode }) {
  return (
    <Profiler id="perf" onRender={countCommit}>
      {children}
    </Profiler>
  );
}

function countCommit() {
  commits += 1;
}

type Reading = { ui: number; uiSlow: number; js: number; commits: number };

export function PerfHud() {
  const uiFrames = useSharedValue(0);
  const uiSlow = useSharedValue(0);
  const uiRefresh = useSharedValue(1000 / 60);
  useFrameCallback(frame => {
    uiFrames.value += 1;
    const delta = frame.timeSincePreviousFrame;
    if (delta === null) return;
    // The shortest frame seen is the panel's refresh, whether 60 or 120 Hz.
    if (delta > 0 && delta < uiRefresh.value) uiRefresh.value = delta;
    if (delta > uiRefresh.value * SLOW_FRAME_RATIO) uiSlow.value += 1;
  });

  const jsFrames = useRef(0);
  useEffect(() => {
    let handle = 0;
    const tick = () => {
      jsFrames.current += 1;
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, []);

  const [reading, setReading] = useState<Reading | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      setReading({
        ui: uiFrames.value,
        uiSlow: uiSlow.value,
        js: jsFrames.current,
        // The HUD sits outside the profiler, so its own commit is not counted.
        commits,
      });
      uiFrames.value = 0;
      uiSlow.value = 0;
      jsFrames.current = 0;
      commits = 0;
    }, WINDOW_MS);
    return () => clearInterval(timer);
  }, [uiFrames, uiSlow]);

  return (
    <View pointerEvents="none" style={styles.hud}>
      <Text style={styles.text}>
        {reading === null
          ? 'PERF …'
          : `UI ${reading.ui} (${reading.uiSlow} slow) · JS ${reading.js} · ` +
            `COMMITS ${reading.commits}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: {
    position: 'absolute',
    top: 28,
    right: 4,
    zIndex: 1000,
    elevation: 1000,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 3,
  },
  text: { color: '#9f9', fontSize: 10, fontFamily: 'monospace' },
});
