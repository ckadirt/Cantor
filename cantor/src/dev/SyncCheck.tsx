/**
 * The sync check — not shipped UI. Flip SYNC_CHECK in App.tsx to open.
 *
 * Measures how far the picture runs from the sound (the reactive player's M1,
 * docs/interfacealpha/reactive-player-log.md). It plays a click track it
 * writes itself — 120 BPM, a high click on each downbeat — through the real
 * player and its real visual clock, and turns the whole screen black for the
 * first 50 ms of every beat by that clock.
 *
 * Two ways to read it:
 *  - film the phone with another phone's slow-motion camera, and count frames
 *    between the screen going black and the click's waveform starting;
 *  - by eye and ear: nudge OFFSET until flash and click land together. The
 *    offset is how much later the picture must run, and goes, per route, into
 *    `src/player/outputLatency.ts`.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import React, { useEffect, useMemo, useState } from 'react';
import { NativeModules, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { nativeAudio } from '../audio/native';
import { PlayerHost } from '../player/PlayerHost';
import { createAudioApiPlayer } from '../player/createAudioApiPlayer';
import { outputLatencySeconds, toOutputRoute, type OutputRoute } from '../player/outputLatency';
import { usePlayer } from '../player/usePlayer';
import { type } from '../theme/tokens';

const RATE = 24000;
const BPM = 120;
const SECONDS = 60;
const FLASH_S = 0.05;
const NODE_KEY = 'dev-sync-check';
const SONG_ID = '00000000-0000-4000-8000-0000000c1c4c';

/** A click track as 16-bit mono WAV: a 6 ms burst on every beat, higher on the one. */
function clickTrack(): Uint8Array {
  const frames = RATE * SECONDS;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * 2, true);
  const beat = Math.round((RATE * 60) / BPM);
  const burst = Math.round(RATE * 0.006);
  for (let b = 0; b * beat < frames; b++) {
    const hz = b % 4 === 0 ? 3000 : 2000;
    for (let i = 0; i < burst && b * beat + i < frames; i++) {
      const v = Math.sin((2 * Math.PI * hz * i) / RATE) * (1 - i / burst) * 0.9;
      view.setInt16(44 + (b * beat + i) * 2, Math.round(v * 32767), true);
    }
  }
  return bytes;
}

/** Write the track into the audio store and return its ref and verified path. */
async function storeClickTrack() {
  const bytes = clickTrack();
  const digest = bytesToHex(sha256(bytes));
  const step = 64 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    await nativeAudio.appendChunk(NODE_KEY, SONG_ID, digest, offset, base64.encode(bytes.subarray(offset, offset + step)));
  }
  await nativeAudio.finalize(NODE_KEY, SONG_ID, digest, bytes.length);
  const path = await nativeAudio.localPath(NODE_KEY, SONG_ID, digest);
  return { ref: { nodeKey: NODE_KEY, songId: SONG_ID, digest }, path };
}

export function SyncCheck() {
  const player = useMemo(() => createAudioApiPlayer(), []);
  const transport = usePlayer(player);
  const [status, setStatus] = useState('WRITING THE CLICK TRACK');
  const [route, setRoute] = useState<OutputRoute | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const offset = useSharedValue(0);
  offset.value = offsetMs / 1000;

  useEffect(() => {
    let live = true;
    storeClickTrack()
      .then(({ ref, path }) => {
        if (!live) return;
        setStatus('PLAYING');
        player.beginSession();
        return transport.open(ref, path, { title: 'Sync check', artist: 'Cantor' });
      })
      .catch(error => live && setStatus(String(error)));
    return () => {
      live = false;
    };
    // One track for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const read = () =>
      NativeModules.CantorPlayback.outputRoute().then((value: unknown) => setRoute(toOutputRoute(value)));
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, []);

  const position = transport.positionSeconds;
  const flash = useAnimatedStyle(() => {
    const t = position.value - offset.value;
    const into = ((t % (60 / BPM)) + 60 / BPM) % (60 / BPM);
    return { opacity: t > 0 && into < FLASH_S ? 1 : 0 };
  });

  const nudge = (ms: number) => setOffsetMs(value => value + ms);
  return (
    <View style={styles.screen}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.black, flash]} />
      <View style={styles.panel}>
        <Text style={[type.eyebrow, styles.ink]}>SYNC CHECK · {status}</Text>
        <Text style={[type.mono, styles.ink]}>
          ROUTE {route ?? '…'} · TABLE {Math.round(outputLatencySeconds(route) * 1000)} MS
        </Text>
        <Text style={[type.title, styles.ink]}>OFFSET {offsetMs} MS</Text>
        <View style={styles.row}>
          {[-50, -10, 10, 50].map(ms => (
            <Pressable key={ms} onPress={() => nudge(ms)} style={styles.button}>
              <Text style={[type.mono, styles.ink]}>{ms > 0 ? `+${ms}` : ms}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.row}>
          <Pressable onPress={transport.toggle} style={styles.button}>
            <Text style={[type.mono, styles.ink]}>PLAY / PAUSE</Text>
          </Pressable>
          <Pressable onPress={() => transport.seek(Math.random() * (SECONDS - 10))} style={styles.button}>
            <Text style={[type.mono, styles.ink]}>SEEK</Text>
          </Pressable>
        </View>
      </View>
      <PlayerHost player={player} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', justifyContent: 'flex-end' },
  black: { backgroundColor: '#000' },
  panel: { backgroundColor: '#fff', padding: 24, gap: 12, margin: 16, borderWidth: 1, borderColor: '#000' },
  row: { flexDirection: 'row', gap: 12 },
  button: { borderBottomWidth: 1, borderColor: '#000', paddingVertical: 8, paddingHorizontal: 4 },
  ink: { color: '#000' },
});
