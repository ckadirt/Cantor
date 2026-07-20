import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Body, Button, Eyebrow, Screen } from '../components/ui';
import { CantorSet } from '../components/CantorSet';
import { useSongs } from '../state/songs';
import { color, font, space, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Generating'>;

/**
 * The wait, made honest: the Cantor set deepens one level at a time,
 * the stage says what the pipeline is really doing, and leaving this
 * screen is fine — generation belongs to the service, not the screen.
 * Deliberately calm: no animation loops competing with inference.
 */
export function GeneratingScreen({ navigation, route }: Props) {
  const { songs, cancelSong } = useSongs();
  const song = songs.find(s => s.id === route.params.id);

  useEffect(() => {
    if (song?.state === 'done') {
      navigation.replace('Song', { id: song.id });
    }
  }, [song?.state, song?.id, navigation]);

  if (!song) {
    return (
      <Screen>
        <Body dim>This song is gone.</Body>
        <Button kind="ghost" label="Back to your set" onPress={() => navigation.popToTop()} />
      </Screen>
    );
  }

  const cancelled = song.state === 'cancelled';

  return (
    <Screen>
      <Eyebrow>{cancelled ? 'cancelled' : 'generating'}</Eyebrow>
      <Text style={styles.songTitle}>{song.title || 'Untitled'}</Text>
      <Body dim style={{ marginBottom: space.xxl }}>
        {song.tags || 'no tags'} · {song.durationSec}s · seed {song.seed}
      </Body>

      <View style={styles.center}>
        <CantorSet progress={song.progress} height={120} />
        <View style={styles.stageRow}>
          <Text style={styles.stage}>{cancelled ? '—' : song.stage}</Text>
          <Text style={styles.step}>
            {song.step ?? `${Math.round(song.progress * 100)}%`}
          </Text>
        </View>
        <Body dim style={{ marginTop: space.lg, textAlign: 'center' }}>
          You can leave — this keeps working in the background and survives
          restarts.
        </Body>
      </View>

      {cancelled ? (
        <Button kind="ghost" label="Back to your set" onPress={() => navigation.popToTop()} />
      ) : (
        <Button
          kind="danger"
          label="Cancel generation"
          onPress={() => {
            cancelSong(song.id);
            navigation.popToTop();
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  songTitle: {
    ...type.title,
    color: color.chalk,
  },
  center: { flex: 1, justifyContent: 'center' },
  stageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.lg,
  },
  stage: {
    ...type.body,
    color: color.chalk,
    fontFamily: font.display,
    fontStyle: 'italic',
  },
  step: {
    ...type.mono,
    color: color.brass,
  },
});
