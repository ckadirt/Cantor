// THROWAWAY. The M3 audio feasibility gate from docs/interface/implementation_steps.md.
//
// This exists to answer one question on real hardware: can react-native-audio-api
// carry Cantor's player on RN 0.86 / New Architecture, or do we fall back to
// AndroidX Media3 behind the same PlayerPort? Delete this file once the answer is
// recorded in the M3 log. Nothing in src/player/ may import it.
//
// Drive it from adb: every result is logged as `AUDIOSPIKE <gate> <verdict> <detail>`
// so the run can be read out of logcat instead of squinted at on the phone.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Audio,
  AudioManager,
  PlaybackNotificationManager,
  decodeAudioData,
  getAudioDuration,
  type AudioTagHandle,
} from 'react-native-audio-api';
import { space, touch, type, usePalette } from '../theme/tokens';

// knobs
const TONE_PATH = '/data/data/com.cantor.app/files/spike-tone.opus'; // pushed by the operator via run-as
const SEEK_TARGET_SECONDS = 90; // mid-file seek, far enough that a no-op is obvious
const REPLACEMENT_ROUNDS = 8; // load/unload cycles for the memory gate
const SETTLE_MS = 1200; // time allowed for a native transport call to take effect

type Verdict = 'pass' | 'fail' | 'skip';

type GateResult = {
  gate: string;
  verdict: Verdict;
  detail: string;
};

function log(gate: string, verdict: Verdict, detail: string) {
  console.log(`AUDIOSPIKE ${gate} ${verdict} ${detail}`);
}

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });

export function AudioSpike() {
  const pal = usePalette();
  const tag = useRef<AudioTagHandle | null>(null);
  const [results, setResults] = useState<readonly GateResult[]>([]);
  const [source, setSource] = useState<string>(TONE_PATH);
  const [running, setRunning] = useState(false);

  // Live element state, kept in refs so an async gate can read the latest value
  // without re-subscribing.
  const loaded = useRef(false);
  const ended = useRef(false);
  const position = useRef(0);
  const lastError = useRef<string | null>(null);
  const heartbeat = useRef<number | null>(null);
  const [live, setLive] = useState({ position: 0, state: 'idle', loaded: false });

  const record = useCallback((gate: string, verdict: Verdict, detail: string) => {
    log(gate, verdict, detail);
    setResults(prev => [...prev, { gate, verdict, detail }]);
  }, []);

  // Gate 1 is implicit: if this component rendered, the native build linked and
  // the app cold-launched with the library in it.
  useEffect(() => {
    log('build-and-launch', 'pass', 'native module linked, JS mounted');
  }, []);

  // Lock-screen and headset transport arrive as notification events. Answer them
  // the way the real player will — log, then actually move the transport — so the
  // gate proves the round trip and not just that an event fired.
  useEffect(() => {
    const subscriptions = [
      PlaybackNotificationManager.addEventListener('playbackNotificationPlay', () => {
        log('remote-control', 'pass', 'play from notification');
        tag.current?.play();
      }),
      PlaybackNotificationManager.addEventListener('playbackNotificationPause', () => {
        log('remote-control', 'pass', 'pause from notification');
        tag.current?.pause();
      }),
      PlaybackNotificationManager.addEventListener('playbackNotificationSeekTo', event => {
        log('remote-control', 'pass', `seekTo ${event.value} from notification`);
        tag.current?.seekToTime(event.value);
      }),
    ];
    return () => subscriptions.forEach(subscription => subscription?.remove());
  }, []);

  // Audio focus: another app taking the output should be reported, and the
  // session should come back afterwards.
  useEffect(() => {
    AudioManager.observeAudioInterruptions(true);
    const subscription = AudioManager.addSystemEventListener(
      'interruption',
      event => {
        log('interruption', 'skip', `type=${event.type} shouldResume=${event.shouldResume}`);
        if (event.type === 'ended' && event.shouldResume) tag.current?.play();
      },
    );
    return () => subscription?.remove();
  }, []);

  const runDecodeGates = useCallback(async () => {
    try {
      const duration = await getAudioDuration(TONE_PATH);
      const ok = Math.abs(duration - 180) < 2;
      record(
        'duration',
        ok ? 'pass' : 'fail',
        `reported=${duration.toFixed(3)}s expected=180s`,
      );
    } catch (error) {
      record('duration', 'fail', readError(error));
    }

    try {
      const before = Date.now();
      const buffer = await decodeAudioData(TONE_PATH);
      const elapsed = Date.now() - before;
      record(
        'opus-decode',
        buffer.duration > 0 ? 'pass' : 'fail',
        `channels=${buffer.numberOfChannels} rate=${buffer.sampleRate} ` +
          `frames=${buffer.length} duration=${buffer.duration.toFixed(3)}s in ${elapsed}ms`,
      );
    } catch (error) {
      record('opus-decode', 'fail', readError(error));
    }
  }, [record]);

  const runTransportGates = useCallback(async () => {
    const handle = tag.current;
    if (!handle) {
      record('transport', 'fail', 'no audio tag handle');
      return;
    }

    // A media element parked at EOF does not restart on play() alone, so rewind
    // first. This is the same thing a real transport does on a finished track.
    handle.seekToTime(0);
    await wait(SETTLE_MS);
    handle.play();
    await wait(SETTLE_MS);
    const played = position.current;
    record(
      'play',
      played > 0.2 ? 'pass' : 'fail',
      `position advanced to ${played.toFixed(3)}s`,
    );

    handle.pause();
    await wait(SETTLE_MS);
    const atPause = position.current;
    await wait(SETTLE_MS);
    const afterPause = position.current;
    record(
      'pause',
      Math.abs(afterPause - atPause) < 0.2 ? 'pass' : 'fail',
      `held ${atPause.toFixed(3)}s then ${afterPause.toFixed(3)}s`,
    );

    handle.seekToTime(SEEK_TARGET_SECONDS);
    await wait(SETTLE_MS);
    const sought = position.current;
    record(
      'seek',
      Math.abs(sought - SEEK_TARGET_SECONDS) < 2 ? 'pass' : 'fail',
      `asked ${SEEK_TARGET_SECONDS}s, landed ${sought.toFixed(3)}s`,
    );

    // Completion: seek to just before the end and let it run off the edge.
    ended.current = false;
    handle.seekToTime(178.5);
    handle.play();
    await wait(4000);
    record(
      'completion',
      ended.current ? 'pass' : 'fail',
      ended.current ? 'onEnded fired' : 'onEnded never fired',
    );
    handle.pause();
  }, [record]);

  const runReplacementGate = useCallback(async () => {
    // Repeatedly swap the source to look for a leak or a native crash. The URI
    // query is only there to defeat any source-identity memoisation.
    for (let round = 0; round < REPLACEMENT_ROUNDS; round += 1) {
      loaded.current = false;
      lastError.current = null;
      setSource(`${TONE_PATH}${round % 2 === 0 ? '' : '?r=' + round}`);
      await wait(SETTLE_MS);
      tag.current?.play();
      await wait(400);
      tag.current?.pause();
      if (lastError.current) {
        record('replacement', 'fail', `round ${round}: ${lastError.current}`);
        return;
      }
    }
    record(
      'replacement',
      'pass',
      `${REPLACEMENT_ROUNDS} source replacements with no error or crash`,
    );
  }, [record]);

  const runNotificationGate = useCallback(async () => {
    try {
      const permission = await AudioManager.requestNotificationPermissions();
      record('notification-permission', permission === 'Granted' ? 'pass' : 'fail', permission);

      await PlaybackNotificationManager.show({
        title: 'Cantor audio spike',
        artist: 'M3 feasibility gate',
        duration: 180,
        elapsedTime: position.current,
        state: 'playing',
      });
      const active = await PlaybackNotificationManager.isActive();
      record(
        'notification-shown',
        active ? 'pass' : 'fail',
        active ? 'playback notification is active' : 'notification did not appear',
      );

      for (const control of ['play', 'pause', 'seekTo'] as const) {
        await PlaybackNotificationManager.enableControl(control, true);
      }
      record('notification-controls', 'pass', 'play/pause/seekTo enabled');
    } catch (error) {
      record('notification', 'fail', readError(error));
    }
  }, [record]);

  // Memory isolation: load/unload churn on its own vs. whole-song decodes on
  // their own, so growth can be attributed to one or the other instead of to
  // "the audio library".
  const runChurnOnly = useCallback(async () => {
    setRunning(true);
    setResults([]);
    for (let pass = 0; pass < 3; pass += 1) await runReplacementGate();
    log('churn-only', 'skip', '3 x 8 load/unload rounds, no decode');
    setRunning(false);
  }, [runReplacementGate]);

  const runDecodeOnly = useCallback(async () => {
    setRunning(true);
    setResults([]);
    for (let pass = 0; pass < 3; pass += 1) {
      const buffer = await decodeAudioData(TONE_PATH);
      log('decode-only', 'skip', `pass ${pass} frames=${buffer.length}`);
    }
    log('decode-only', 'skip', '3 whole-song decodes');
    setRunning(false);
  }, []);

  // Same element, no source change: separates "transport leaks" from "swapping
  // the source leaks". Only the second one is unavoidable in a music player.
  const runTransportChurn = useCallback(async () => {
    setRunning(true);
    setResults([]);
    for (let round = 0; round < 50; round += 1) {
      tag.current?.seekToTime(0);
      tag.current?.play();
      await wait(60);
      tag.current?.pause();
      await wait(60);
    }
    log('transport-churn', 'skip', '50 seek/play/pause cycles on one source');
    setRunning(false);
  }, []);

  const runAll = useCallback(async () => {
    setRunning(true);
    setResults([]);
    try {
      await runDecodeGates();
      await runTransportGates();
      await runReplacementGate();
      await runNotificationGate();
      log('suite', 'pass', 'automated gates finished; manual gates remain');
    } catch (error) {
      log('suite', 'fail', readError(error));
    } finally {
      setRunning(false);
    }
  }, [runDecodeGates, runTransportGates, runReplacementGate, runNotificationGate]);

  // The background/lock-screen/interruption gates cannot be asserted from JS —
  // they are observed while the app is not on screen. This leaves a song playing
  // and a live notification so the operator can lock the phone and watch.
  const startBackgroundGate = useCallback(async () => {
    await AudioManager.setAudioSessionActivity(true);
    AudioManager.observeAudioInterruptions(true);
    await PlaybackNotificationManager.show({
      title: 'Cantor background gate',
      artist: 'lock the screen and listen',
      duration: 180,
      elapsedTime: 0,
      state: 'playing',
    });
    // Without this the session advertises actions=0 and the system never routes a
    // media button to us. Declaring the controls is what makes the session
    // remote-controllable, not showing the notification.
    for (const control of ['play', 'pause', 'seekTo'] as const) {
      await PlaybackNotificationManager.enableControl(control, true);
    }
    tag.current?.seekToTime(0);
    tag.current?.play();
    // Heartbeat the position into logcat so off-screen continuation is read from
    // the log timeline instead of the screen — looking at the screen to check
    // whether the screen-off case works would defeat the gate.
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = setInterval(() => {
      log('bg-position', 'skip', position.current.toFixed(3));
    }, 2000) as unknown as number;
    log('background-gate', 'skip', 'playing; heartbeat started');
  }, []);

  useEffect(
    () => () => {
      if (heartbeat.current) clearInterval(heartbeat.current);
    },
    [],
  );

  return (
    <View style={[styles.root, { backgroundColor: pal.bg }]}>
      <Audio
        ref={tag}
        source={source}
        preload="auto"
        onLoad={() => {
          loaded.current = true;
          setLive(prev => ({ ...prev, loaded: true }));
          log('source-load', 'pass', `loaded ${source}`);
        }}
        onLoadStart={() => log('source-load', 'skip', `loading ${source}`)}
        onError={error => {
          lastError.current = readError(error);
          log('source-load', 'fail', readError(error));
        }}
        onPositionChange={seconds => {
          position.current = seconds;
          setLive(prev => ({ ...prev, position: seconds }));
        }}
        onEnded={() => {
          ended.current = true;
          log('ended', 'pass', 'onEnded');
        }}
        onPlay={() => setLive(prev => ({ ...prev, state: 'playing' }))}
        onPause={() => setLive(prev => ({ ...prev, state: 'paused' }))}
      />

      <Text style={[type.eyebrow, { color: pal.muted }]}>M3 AUDIO GATE</Text>
      <Text style={[type.mono, { color: pal.ink }]}>
        {live.loaded ? 'loaded' : 'not loaded'} · {live.state} ·{' '}
        {live.position.toFixed(2)}s
      </Text>

      <View style={styles.row}>
        <Button label={running ? 'running…' : 'Run gates'} onPress={runAll} />
        <Button label="Background" onPress={startBackgroundGate} />
      </View>
      <View style={styles.row}>
        <Button label="Churn (no decode)" onPress={runChurnOnly} />
        <Button label="Decode ×3" onPress={runDecodeOnly} />
      </View>
      <View style={styles.row}>
        <Button label="Transport churn" onPress={runTransportChurn} />
      </View>

      <ScrollView style={styles.flex}>
        {results.map((result, index) => (
          <Text
            key={`${result.gate}-${index}`}
            style={[type.mono, { color: result.verdict === 'fail' ? '#c0392b' : pal.ink }]}>
            {result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✗' : '·'}{' '}
            {result.gate} — {result.detail}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.button, { borderColor: pal.ink }]}>
      <Text style={[type.mono, { color: pal.ink }]}>{label}</Text>
    </Pressable>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: space.lg, paddingTop: space.xl * 2, gap: space.sm },
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
    borderWidth: 1,
  },
});
