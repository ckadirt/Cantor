import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Body, Button, Eyebrow, Hairline, Screen, Title } from '../components/ui';
import { Song, useSongs } from '../state/songs';
import { color, font, radius, space, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

const STATE_LABEL: Record<Song['state'], string> = {
  queued: 'queued',
  generating: 'generating…',
  interrupted: 'paused — tap to resume',
  done: '',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function LibraryScreen({ navigation }: Props) {
  const { songs } = useSongs();

  const open = (song: Song) => {
    if (song.state === 'generating' || song.state === 'queued') {
      navigation.navigate('Generating', { id: song.id });
    } else {
      navigation.navigate('Song', { id: song.id });
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Eyebrow>{`|S| = ${songs.length}`}</Eyebrow>
          <Title>Your set</Title>
        </View>
      </View>
      <Hairline />

      {songs.length === 0 ? (
        <View style={styles.empty}>
          <Body dim style={{ textAlign: 'center' }}>
            The empty set. Every song you make joins it — start with your
            first.
          </Body>
        </View>
      ) : (
        <FlatList
          data={songs}
          keyExtractor={s => s.id}
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => open(item)}
              style={({ pressed }) => [styles.card, pressed && { backgroundColor: color.raised }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{item.title || 'Untitled'}</Text>
                <Text style={styles.cardMeta}>
                  {item.tags || 'no tags'} · {item.durationSec}s
                </Text>
              </View>
              {item.state === 'generating' ? (
                <Text style={styles.badgeActive}>{Math.round(item.progress * 100)}%</Text>
              ) : STATE_LABEL[item.state] ? (
                <Text style={[styles.badge, item.state === 'failed' && { color: color.danger }]}>
                  {STATE_LABEL[item.state]}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}

      <Button label="New song" onPress={() => navigation.navigate('Create')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end' },
  empty: { flex: 1, justifyContent: 'center', paddingHorizontal: space.xl },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 64,
  },
  cardTitle: {
    ...type.body,
    color: color.chalk,
    fontFamily: font.display,
    fontSize: 17,
  },
  cardMeta: {
    ...type.small,
    color: color.dust,
    marginTop: 2,
  },
  badge: {
    ...type.small,
    color: color.dust,
    marginLeft: space.md,
  },
  badgeActive: {
    ...type.mono,
    color: color.brass,
    marginLeft: space.md,
  },
});
