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
import { formatBytes } from '../../lenses';
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
  /**
   * Where this sheet was opened from, and how much of the song it accounts
   * for. A mark is a placement, not a song: one delete must never silently
   * remove three.
   */
  scopeLabel: string | null;
  placementCount: number;
  playlistCount: number;
  /** The playlist this mark sits in, when the scope is one you can leave. */
  scopePlaylist: string | null;
  onRemoveFromScope: () => void;
  /** What the local copy weighs, for the line that says what removing frees. */
  downloadedBytes: number | null;
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
function SongSheetImpl({
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
  scopeLabel,
  placementCount,
  playlistCount,
  scopePlaylist,
  onRemoveFromScope,
  downloadedBytes,
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
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const downloaded = audioState === 'cached' || audioState === 'pinned';

  // A sheet that opens on a different song must never open already asking to
  // destroy it.
  useEffect(() => {
    setConfirmingTrash(false);
  }, [song.id, visible]);

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
            <Text numberOfLines={1} style={[type.title, styles.name, { color: pal.ink }]}>
              {song.title}
            </Text>
            <Pressable
              accessibilityLabel="Close song"
              accessibilityRole="button"
              onPress={onClose}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>

          {/*
            Scope, before anything that acts: which mark you held, and how many
            others this song has. `design.md` warns that many-to-many membership
            "silently shows one copy"; this is that warning answered from the
            other side.
          */}
          <Text style={[type.eyebrow, { color: pal.muted }]}>
            {scopeLabel === null ? nodeLabel.toUpperCase() : `FROM · ${scopeLabel.toUpperCase()}`}
          </Text>
          <Text style={[type.eyebrow, styles.scope, { color: pal.faint }]}>
            {scopeSummary(playlistCount, placementCount)}
          </Text>

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
                    label="Keep"
                    onPress={onPin}
                    disabled={busy || !downloaded}
                  />
                )}
              </View>
            </Field>

            {/*
              Three ways to make a song go, in increasing order of how much
              goes, each saying what it costs. The rules between them are the
              point: they are not variations of one action.
            */}
            <View style={[styles.rule, { backgroundColor: pal.line }]} />
            <Leaving
              busy={busy || !downloaded}
              consequence={`${
                downloadedBytes === null
                  ? 'FREES THE LOCAL COPY'
                  : `FREES ${formatBytes(downloadedBytes)}`
              } · STAYS ON ${nodeLabel.toUpperCase()}`}
              label="Remove from this phone"
              onPress={onRemoveDownload}
            />
            {scopePlaylist === null ? null : (
              <>
                <View style={[styles.rule, { backgroundColor: pal.line }]} />
                <Leaving
                  busy={busy}
                  consequence={`KEEPS THE SONG · ${marksRemain(placementCount)}`}
                  label={`Remove from ${scopePlaylist}`}
                  onPress={onRemoveFromScope}
                />
              </>
            )}
            <View style={[styles.rule, { backgroundColor: pal.ink }]} />
            {confirmingTrash ? (
              <View style={styles.row}>
                <SheetButton
                  label="Trash the song"
                  onPress={() => {
                    setConfirmingTrash(false);
                    onTrash();
                  }}
                  disabled={busy}
                />
                <SheetButton
                  label="Keep it"
                  onPress={() => setConfirmingTrash(false)}
                  disabled={busy}
                />
              </View>
            ) : (
              <Leaving
                busy={busy}
                consequence={trashConsequence(placementCount)}
                label="Trash the song"
                onPress={() => setConfirmingTrash(true)}
              />
            )}

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

/** `IN 3 PLAYLISTS · 3 PLACEMENTS`, and the honest singulars. */
function scopeSummary(playlistCount: number, placementCount: number): string {
  const playlists =
    playlistCount === 0
      ? 'IN NO PLAYLIST'
      : `IN ${playlistCount} PLAYLIST${playlistCount === 1 ? '' : 'S'}`;
  const placements = `${placementCount} PLACEMENT${
    placementCount === 1 ? '' : 'S'
  }`;
  return `${playlists} · ${placements}`;
}

function marksRemain(placementCount: number): string {
  const remaining = Math.max(0, placementCount - 1);
  return remaining === 1 ? '1 MARK REMAINS' : `${remaining} MARKS REMAIN`;
}

function trashConsequence(placementCount: number): string {
  return placementCount <= 1
    ? 'THE SONG AND ITS AUDIO, EVERYWHERE'
    : `EVERY PLACEMENT · ${placementCount} MARKS GO AT ONCE`;
}

/**
 * One way out, and what it costs.
 *
 * The consequence is not a caption on a button — it is the difference between
 * dropping a tag and destroying a song, and it is why these three rows are
 * rows rather than three buttons in a line.
 */
function Leaving({
  label,
  consequence,
  onPress,
  busy,
}: {
  label: string;
  consequence: string;
  onPress: () => void;
  busy: boolean;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityLabel={`${label}. ${consequence}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={styles.leaving}>
      <Text style={[type.body, { color: busy ? pal.faint : pal.ink }]}>
        {label}
      </Text>
      <Text style={[type.eyebrow, styles.consequence, { color: pal.faint }]}>
        {consequence}
      </Text>
    </Pressable>
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
  name: { flexShrink: 1, marginRight: space.md },
  // The scope lines are the sheet's header, not the first field: they need to
  // sit apart from the form under them or they read as its label.
  scope: { marginBottom: space.md, marginTop: space.xs },
  rule: { height: 1, marginTop: space.md },
  leaving: { minHeight: touch.min, paddingTop: space.md },
  consequence: { marginTop: space.xs },
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

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const SongSheet = React.memo(SongSheetImpl);
