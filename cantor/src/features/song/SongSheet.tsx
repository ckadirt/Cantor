import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { SongDetail, SongHeader } from '../../core/protocol';
import type { LocalAudioState } from '../../audio/native';
import { isPlaylistTag, plainTagsOf } from '../../playlists/playlists';
import { space, touch, type, usePalette } from '../../theme/tokens';

/** KNOBS */
const SONG_SHEET_KNOBS = {
  DIGEST_PREFIX_CHARS: 12, // enough to compare by eye, short enough to read
} as const;

type Props = {
  visible: boolean;
  song: SongHeader;
  nodeLabel: string;
  audioState: LocalAudioState;
  /** Null until the node answers; undefined nodes stay honest about it. */
  detail: SongDetail | null;
  detailError: string | null;
  busy: boolean;
  onClose: () => void;
  onRename: (title: string) => void;
  onToggleFavourite: () => void;
  onAddTag: (tag: string) => void;
  /** Playlist membership, which is the only writer of the reserved namespace. */
  playlists: React.ReactNode;
  onRemoveTag: (tag: string) => void;
  onTrash: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onRemoveDownload: () => void;
};

/**
 * Everything about one song that is not the act of listening to it.
 *
 * This is a sheet rather than a zoom level on purpose: renaming, tagging and
 * cache management are conventional list-and-form work, and giving them a
 * distance in the field would make the zoom model mean two different things.
 */
export function SongSheet({
  visible,
  song,
  nodeLabel,
  audioState,
  detail,
  detailError,
  busy,
  onClose,
  onRename,
  onToggleFavourite,
  onAddTag,
  playlists,
  onRemoveTag,
  onTrash,
  onPin,
  onUnpin,
  onRemoveDownload,
}: Props) {
  const pal = usePalette();
  const [title, setTitle] = useState(song.title);
  const [tag, setTag] = useState('');

  // Adopt the node's title whenever a different song is shown, or the node
  // renames this one under us.
  useEffect(() => {
    setTitle(song.title);
  }, [song.id, song.title]);

  const plainTags = plainTagsOf(song.tags);
  const [tagProblem, setTagProblem] = useState<string | null>(null);
  const downloaded = audioState === 'cached' || audioState === 'pinned';

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: pal.bg, borderColor: pal.line },
          ]}>
          <View style={styles.header}>
            <Text style={[type.title, { color: pal.ink }]}>Song</Text>
            <Pressable
              accessibilityLabel="Close song"
              accessibilityRole="button"
              onPress={onClose}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            <Field label="TITLE">
              <TextInput
                accessibilityLabel="Song title"
                editable={!busy}
                onBlur={() => {
                  const next = title.trim();
                  if (next.length > 0 && next !== song.title) onRename(next);
                }}
                onChangeText={setTitle}
                style={[styles.input, type.body, { color: pal.ink, borderColor: pal.line }]}
                value={title}
              />
            </Field>

            <View style={styles.row}>
              <SheetButton
                label={song.favorite ? 'Favourite ★' : 'Favourite ☆'}
                onPress={onToggleFavourite}
                disabled={busy}
              />
              <SheetButton label="Trash" onPress={onTrash} disabled={busy} />
            </View>

            <Field label="TAGS">
              <View style={styles.tags}>
                {plainTags.length === 0 ? (
                  <Text style={[type.body, { color: pal.muted }]}>No tags.</Text>
                ) : (
                  plainTags.map(value => (
                    <Pressable
                      accessibilityLabel={`Remove tag ${value}`}
                      accessibilityRole="button"
                      disabled={busy}
                      key={value}
                      onPress={() => onRemoveTag(value)}
                      style={[styles.tag, { borderColor: pal.line }]}>
                      <Text style={[type.mono, { color: pal.ink }]}>
                        {value} ×
                      </Text>
                    </Pressable>
                  ))
                )}
              </View>
              <TextInput
                accessibilityLabel="Add a tag"
                editable={!busy}
                onChangeText={setTag}
                onSubmitEditing={() => {
                  const next = tag.trim();
                  if (next.length === 0) return;
                  // `p/` is reserved. Letting it be typed here would create a
                  // playlist that the playlist UI never made and cannot see.
                  if (isPlaylistTag(next)) {
                    setTagProblem('Use the playlist field to make a playlist.');
                    return;
                  }
                  setTagProblem(null);
                  onAddTag(next);
                  setTag('');
                }}
                placeholder="add a tag"
                placeholderTextColor={pal.faint}
                returnKeyType="done"
                style={[styles.input, type.body, { color: pal.ink, borderColor: pal.line }]}
                value={tag}
              />
              {tagProblem !== null ? (
                <Text style={[type.mono, { color: pal.muted }]}>
                  {tagProblem}
                </Text>
              ) : null}
            </Field>

            <Field label="PLAYLISTS">{playlists}</Field>

            <Field label={`OFFLINE · ${audioState.toUpperCase()}`}>
              <View style={styles.row}>
                {audioState === 'pinned' ? (
                  <SheetButton label="Unpin" onPress={onUnpin} disabled={busy} />
                ) : (
                  <SheetButton
                    label="Pin"
                    onPress={onPin}
                    disabled={busy || !downloaded}
                  />
                )}
                <SheetButton
                  label="Remove download"
                  onPress={onRemoveDownload}
                  disabled={busy || audioState === 'remote' || audioState === 'pinned'}
                />
              </View>
            </Field>

            <Field label="RECIPE">
              {detailError !== null ? (
                <Text style={[type.body, { color: pal.muted }]}>
                  {detailError}
                </Text>
              ) : detail === null ? (
                <Text style={[type.body, { color: pal.muted }]}>
                  Asking {nodeLabel}…
                </Text>
              ) : (
                <>
                  <Fact label="engine" value={detail.engine} />
                  <Fact label="model" value={song.model} />
                  <Fact
                    label="seed"
                    value={song.seed === undefined ? 'unset' : String(song.seed)}
                  />
                  <Fact label="attempts" value={String(detail.attempts)} />
                  <Fact label="caption" value={detail.generation.caption} />
                  {detail.generation.lyrics ? (
                    <Fact label="lyrics" value={detail.generation.lyrics} />
                  ) : null}
                  {detail.component_digests.map(digest => (
                    <Fact
                      key={digest}
                      label="digest"
                      value={digest.slice(0, SONG_SHEET_KNOBS.DIGEST_PREFIX_CHARS)}
                    />
                  ))}
                </>
              )}
            </Field>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const pal = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[type.eyebrow, { color: pal.muted }]}>{label}</Text>
      {children}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const pal = usePalette();
  return (
    <View style={styles.fact}>
      <Text style={[type.mono, styles.factLabel, { color: pal.faint }]}>
        {label}
      </Text>
      <Text style={[type.mono, styles.factValue, { color: pal.ink }]}>
        {value}
      </Text>
    </View>
  );
}

function SheetButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { borderColor: disabled ? pal.faint : pal.ink }]}>
      <Text style={[type.mono, { color: disabled ? pal.faint : pal.ink }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopWidth: 1, maxHeight: '85%', padding: space.lg },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  body: { gap: space.lg, paddingBottom: space.lg },
  field: { gap: space.xs },
  input: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
  row: { flexDirection: 'row', gap: space.sm },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    minHeight: touch.min,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag: {
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  fact: { flexDirection: 'row', gap: space.sm },
  factLabel: { width: 72 },
  factValue: { flex: 1 },
});
