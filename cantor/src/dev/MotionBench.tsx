/**
 * The motion analysis bench — not shipped UI. Flip MOTION_BENCH in App.tsx.
 *
 * The reactive player's M2 exit (docs/interfacealpha/reactive-player-log.md):
 * the native motion track timed on the phone, release build, median of five,
 * decode and analysis apart. Reads `<len>-<rate>.<ext>` from the app's own
 * external files directory, which `adb push` can reach on the test phone:
 *
 *   adb push bench/ /sdcard/Android/data/com.cantor.app/files/motion/
 *
 * Results on screen and through console.warn (`adb logcat -s ReactNativeJS`).
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { measureNativeMotion } from '../audio/native';
import { unpackMotionTrack } from '../lenses/motion/motionTrack';
import { type } from '../theme/tokens';

const DIR = '/storage/emulated/0/Android/data/com.cantor.app/files/motion';
const LENGTHS = ['3min', '4min', '9min'];
const RATES = ['44k', '48k'];
const FORMATS = ['mp3', 'm4a', 'flac'];
const RUNS = 5;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

export function MotionBench() {
  const [lines, setLines] = useState<string[]>(['file | decode | features | song | total | peak MB | bpm | beats | sections']);
  useEffect(() => {
    let live = true;
    (async () => {
      for (const length of LENGTHS) {
        for (const rate of RATES) {
          for (const format of FORMATS) {
            const name = `${length}-${rate}.${format}`;
            const runs: { decode: number; features: number; song: number; peak: number; summary: string }[] = [];
            try {
              for (let i = 0; i < RUNS && live; i++) {
                const { track, cost } = unpackMotionTrack(String(await measureNativeMotion(`${DIR}/${name}`)));
                runs.push({
                  decode: cost.decodeMs,
                  features: cost.featuresMs,
                  song: cost.songMs,
                  peak: cost.peakBytes / 1e6,
                  summary: `${track.bpm.toFixed(1)} | ${track.beats.length} | ${track.sections.length}`,
                });
              }
            } catch (error) {
              runs.length = 0;
              const line = `${name} | ${String(error)}`;
              console.warn(`MOTION_BENCH ${line}`);
              if (live) setLines(previous => [...previous, line]);
              continue;
            }
            if (!live) return;
            const d = median(runs.map(r => r.decode));
            const f = median(runs.map(r => r.features));
            const s = median(runs.map(r => r.song));
            const line = `${name} | ${d.toFixed(0)} | ${f.toFixed(0)} | ${s.toFixed(0)} | ${(d + f + s).toFixed(0)} ms | ${runs[0].peak.toFixed(1)} | ${runs[0].summary}`;
            console.warn(`MOTION_BENCH ${line}`);
            setLines(previous => [...previous, line]);
          }
        }
      }
      console.warn('MOTION_BENCH done');
    })();
    return () => {
      live = false;
    };
  }, []);
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {lines.map(line => (
        <Text key={line} style={[type.mono, styles.line]}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, paddingTop: 48, backgroundColor: '#fff' },
  line: { color: '#000', fontSize: 11, marginBottom: 6 },
});
