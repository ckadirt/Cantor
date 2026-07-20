import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button, Eyebrow, Screen } from '../components/ui';
import { useSongs } from '../state/songs';
import { color, radius, space, touch, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Create'>;

const STRUCTURE_TAGS = ['[verse]', '[chorus]', '[bridge]', '[outro]'] as const;
const DURATIONS = [30, 60, 120, 180] as const;

/**
 * The creative surface: structured lyrics in, one song out.
 * Structure chips insert ACE-Step section tags at the cursor.
 */
export function CreateScreen({ navigation }: Props) {
  const { createSong } = useSongs();
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [durationSec, setDurationSec] = useState<number>(120);
  const selection = useRef({ start: 0, end: 0 });
  const lyricsInput = useRef<TextInput>(null);

  const insertTag = (tag: string) => {
    const { start, end } = selection.current;
    const next = `${lyrics.slice(0, start)}${tag}\n${lyrics.slice(end)}`;
    setLyrics(next);
    lyricsInput.current?.focus();
  };

  const generate = () => {
    const song = createSong({ title: title.trim(), tags: tags.trim(), lyrics, durationSec });
    navigation.replace('Generating', { id: song.id });
  };

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: space.xl }}>
          <Eyebrow>new song</Eyebrow>

          <TextInput
            style={styles.title}
            placeholder="Title"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={setTitle}
          />

          <TextInput
            style={styles.tags}
            placeholder="style tags — e.g. bolero, warm, acoustic guitar"
            placeholderTextColor={color.faint}
            value={tags}
            onChangeText={setTags}
            autoCapitalize="none"
          />

          <Eyebrow style={{ marginTop: space.lg }}>lyrics</Eyebrow>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {STRUCTURE_TAGS.map(tag => (
              <Pressable key={tag} onPress={() => insertTag(tag)} style={styles.chip}>
                <Text style={styles.chipLabel}>{tag}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <TextInput
            ref={lyricsInput}
            style={styles.lyrics}
            placeholder={'[verse]\nWrite what the song should say…'}
            placeholderTextColor={color.faint}
            value={lyrics}
            onChangeText={setLyrics}
            onSelectionChange={e => {
              selection.current = e.nativeEvent.selection;
            }}
            multiline
            textAlignVertical="top"
          />

          <Eyebrow style={{ marginTop: space.lg }}>duration</Eyebrow>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {DURATIONS.map(d => (
              <Pressable
                key={d}
                onPress={() => setDurationSec(d)}
                style={[styles.chip, durationSec === d && styles.chipSelected]}>
                <Text style={[styles.chipLabel, durationSec === d && { color: color.bg }]}>
                  {d < 60 ? `${d}s` : `${d / 60}m`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <Button label="Generate" onPress={generate} style={{ marginTop: space.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.chalk,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  tags: {
    ...type.mono,
    color: color.chalk,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  chipRow: { flexGrow: 0, marginBottom: space.sm },
  chip: {
    minHeight: touch.min - 12,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    marginRight: space.sm,
  },
  chipSelected: {
    backgroundColor: color.brass,
    borderColor: color.brass,
  },
  chipLabel: {
    ...type.mono,
    color: color.dust,
  },
  lyrics: {
    ...type.body,
    fontFamily: type.mono.fontFamily,
    color: color.chalk,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 180,
  },
});
