import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  playlistNameProblem,
  playlistsOf,
  tagsAreFull,
} from '../../playlists/playlists';
import { space, touch, type, usePalette } from '../../theme/tokens';

type Props = {
  /** Every tag on this song, `p/` and plain alike. */
  tags: readonly string[];
  /** Every playlist that exists anywhere in the library. */
  known: readonly string[];
  busy: boolean;
  onToggle: (name: string, member: boolean) => void;
};

/**
 * Playlist membership for one song.
 *
 * Creating a playlist means adding it to this song, because an empty playlist
 * does not exist: a playlist *is* the set of songs tagged with it, so there is
 * nowhere for an empty one to live and nothing for it to mean.
 */
export function PlaylistChips({ tags, known, busy, onToggle }: Props) {
  const pal = usePalette();
  const [draft, setDraft] = useState('');
  const mine = playlistsOf(tags);
  const folded = new Set(mine.map(name => name.toLocaleLowerCase()));
  const full = tagsAreFull(tags);
  const problem = draft.trim().length === 0 ? null : playlistNameProblem(draft);

  const others = known.filter(
    name => !folded.has(name.toLocaleLowerCase()),
  );

  return (
    <View style={styles.root}>
      <View style={styles.chips}>
        {mine.map(name => (
          <Pressable
            accessibilityLabel={`Remove from ${name}`}
            accessibilityRole="button"
            accessibilityState={{ selected: true }}
            disabled={busy}
            key={`in-${name}`}
            onPress={() => onToggle(name, false)}
            style={[styles.chip, styles.member, { borderColor: pal.ink }]}>
            <Text style={[type.mono, { color: pal.ink }]}>{name} ×</Text>
          </Pressable>
        ))}
        {others.map(name => (
          <Pressable
            accessibilityLabel={`Add to ${name}`}
            accessibilityRole="button"
            accessibilityState={{ selected: false, disabled: busy || full }}
            disabled={busy || full}
            key={`out-${name}`}
            onPress={() => onToggle(name, true)}
            style={[styles.chip, { borderColor: pal.line }]}>
            <Text style={[type.mono, { color: full ? pal.faint : pal.muted }]}>
              {name}
            </Text>
          </Pressable>
        ))}
        {mine.length === 0 && others.length === 0 ? (
          <Text style={[type.body, { color: pal.muted }]}>
            No playlists yet.
          </Text>
        ) : null}
      </View>

      <TextInput
        accessibilityLabel="New playlist"
        editable={!busy && !full}
        onChangeText={setDraft}
        onSubmitEditing={() => {
          const name = draft.trim();
          if (name.length === 0 || playlistNameProblem(name) !== null) return;
          onToggle(name, true);
          setDraft('');
        }}
        placeholder={full ? 'this song has all the tags it can hold' : 'new playlist'}
        placeholderTextColor={pal.faint}
        returnKeyType="done"
        style={[
          styles.input,
          type.body,
          { color: pal.ink, borderColor: pal.line },
        ]}
        value={draft}
      />
      {problem !== null ? (
        <Text style={[type.mono, { color: pal.muted }]}>{problem}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: touch.min,
    paddingHorizontal: space.sm,
  },
  member: { borderWidth: 2 },
  input: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
});
