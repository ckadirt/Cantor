import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Body, Button, Eyebrow, Hairline, Screen } from '../components/ui';
import { CantorSet } from '../components/CantorSet';
import { useSongs } from '../state/songs';
import { color, space, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Song'>;

/**
 * Song detail + player shell. Playback is stubbed until audio decode
 * lands (react-native-track-player, mediaPlayback service).
 */
export function SongScreen({ navigation, route }: Props) {
  const { songs, deleteSong } = useSongs();
  const [playing, setPlaying] = useState(false);
  const song = songs.find(s => s.id === route.params.id);

  if (!song) {
    return (
      <Screen>
        <Body dim>This song is gone.</Body>
        <Button kind="ghost" label="Back to your set" onPress={() => navigation.popToTop()} />
      </Screen>
    );
  }

  const confirmDelete = () =>
    Alert.alert('Remove from your set?', `“${song.title || 'Untitled'}” will be deleted.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteSong(song.id);
          navigation.popToTop();
        },
      },
    ]);

  const report = () =>
    Alert.alert('Report this song', 'Flag AI-generated content you find harmful or offensive.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report', onPress: () => {} },
    ]);

  return (
    <Screen>
      <Eyebrow>
        {new Date(song.createdAt).toLocaleDateString()} · seed {song.seed}
      </Eyebrow>
      <Text style={styles.songTitle}>{song.title || 'Untitled'}</Text>
      <Body dim>{song.tags || 'no tags'} · {song.durationSec}s</Body>

      <View style={styles.player}>
        <CantorSet height={72} barColor={playing ? color.brass : color.dust} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          onPress={() => setPlaying(p => !p)}
          style={styles.playButton}>
          <Text style={styles.playGlyph}>{playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <Body dim style={{ textAlign: 'center', marginTop: space.sm }}>
          {playing ? 'Playing (stub — audio engine pending)' : 'Tap to play'}
        </Body>
      </View>

      <Hairline />
      <Button kind="ghost" label="Generate a variation" onPress={() => navigation.navigate('Create')} />
      <Button kind="ghost" label="Share (soon)" onPress={() => {}} style={{ marginTop: space.sm }} />
      <View style={styles.footerRow}>
        <Button kind="danger" label="Delete" onPress={confirmDelete} style={{ flex: 1 }} />
        <Button kind="ghost" label="Report" onPress={report} style={{ flex: 1, marginLeft: space.sm }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  songTitle: {
    ...type.title,
    color: color.chalk,
  },
  player: {
    flex: 1,
    justifyContent: 'center',
  },
  playButton: {
    alignSelf: 'center',
    marginTop: space.lg,
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: color.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: {
    ...type.heading,
    color: color.brass,
  },
  footerRow: {
    flexDirection: 'row',
    marginTop: space.sm,
  },
});
