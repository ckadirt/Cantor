import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { SongDetail } from '../../../../protocol/SongDetail';
import { type as textType, usePalette } from '../../theme/tokens';
import { formatBytes } from './format';
import { libraryStyles as styles } from './styles';
import type { AudioAction, LibrarySongRowProps } from './types';

export function LibrarySongRow({
  row,
  onDetail,
  onPatch,
  onPresence,
  onAudio,
  onError,
}: LibrarySongRowProps) {
  const pal = usePalette();
  const [title, setTitle] = useState(row.song.title);
  const [tags, setTags] = useState(row.song.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<SongDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [audioBusy, setAudioBusy] = useState(false);
  useEffect(() => {
    setTitle(row.song.title);
    setTags(row.song.tags.join(', '));
  }, [row.song.revision, row.song.tags, row.song.title]);
  useEffect(() => setDetail(null), [row.song.id, row.song.revision]);
  const run = async (operation: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    try {
      await operation();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };
  const parsedTags = tags
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
  const loadDetail = async () => {
    if (detail !== null) {
      setDetail(null);
      return;
    }
    if (detailLoading) return;
    setDetailLoading(true);
    try {
      setDetail(await onDetail(row.backend.nodePubkey, row.song.id));
    } catch (error) {
      onError(error);
    } finally {
      setDetailLoading(false);
    }
  };
  const runAudio = async (action: AudioAction) => {
    if (audioBusy || row.delivery === undefined) return;
    setAudioBusy(true);
    try {
      await onAudio(row.backend.nodePubkey, row.song, row.delivery, action);
    } catch (error) {
      onError(error);
    } finally {
      setAudioBusy(false);
    }
  };
  const audioLabel =
    row.delivery === undefined
      ? 'AUDIO PREPARING'
      : audioBusy && ['remote', 'partial'].includes(row.local.state)
      ? 'DOWNLOADING'
      : row.local.state.toUpperCase();
  const audioBytes =
    row.local.bytes > 0
      ? row.local.bytes
      : row.delivery?.byte_length ??
        row.song.artifacts.find(artifact => artifact.kind === 'master')
          ?.byte_length ??
        0;
  return (
    <View style={[styles.songCard, { borderColor: pal.line }]}>
      <View style={styles.songHeading}>
        <Text style={[textType.small, { color: pal.faint }]}>
          {row.song.trashed ? 'TRASH' : audioLabel} ·{' '}
          {row.backend.lastNodeInfo?.name ?? row.backend.petname}
        </Text>
        <Text style={[textType.small, { color: pal.muted }]}>
          {(row.song.duration_ms / 1000).toFixed(1)}s ·{' '}
          {formatBytes(audioBytes)}
        </Text>
      </View>
      <TextInput
        accessibilityLabel="Song title"
        editable={row.ready && !saving}
        onChangeText={setTitle}
        value={title}
        style={[
          styles.songInput,
          textType.heading,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <TextInput
        accessibilityLabel="Song tags"
        editable={row.ready && !saving}
        onChangeText={setTags}
        placeholder="tags, separated, by commas"
        placeholderTextColor={pal.faint}
        value={tags}
        style={[
          styles.songInput,
          textType.small,
          { borderColor: pal.line, color: pal.ink },
        ]}
      />
      <Text style={[textType.small, { color: pal.muted }]}>
        {row.song.caption_summary} · {row.song.model}
      </Text>
      <View style={styles.songActions}>
        {row.delivery === undefined ? (
          <Text style={[textType.small, { color: pal.faint }]}>
            The node is preparing the compact audio copy.
          </Text>
        ) : row.local.state === 'remote' || row.local.state === 'partial' ? (
          <Pressable
            accessibilityLabel={
              row.local.state === 'partial'
                ? 'Resume audio download'
                : 'Download and play audio'
            }
            disabled={!row.ready || audioBusy}
            onPress={() => runAudio('download-play')}
            style={[styles.songAction, { borderColor: pal.line }]}
          >
            <Text style={[textType.eyebrow, { color: pal.ink }]}>
              {audioBusy
                ? `${Math.round(
                    (row.local.bytes / row.delivery.byte_length) * 100,
                  )}%`
                : row.local.state === 'partial'
                ? 'RESUME DOWNLOAD'
                : 'DOWNLOAD & PLAY'}
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityLabel="Play downloaded audio"
              disabled={audioBusy}
              onPress={() => runAudio('play')}
              style={[styles.songAction, { borderColor: pal.line }]}
            >
              <Text style={[textType.eyebrow, { color: pal.ink }]}>PLAY</Text>
            </Pressable>
            <Pressable
              disabled={audioBusy}
              onPress={() =>
                runAudio(row.local.state === 'pinned' ? 'unpin' : 'pin')
              }
              style={[styles.songAction, { borderColor: pal.line }]}
            >
              <Text style={[textType.eyebrow, { color: pal.ink }]}>
                {row.local.state === 'pinned' ? 'UNPIN' : 'PIN'}
              </Text>
            </Pressable>
            {row.local.state === 'cached' ? (
              <Pressable
                disabled={audioBusy}
                onPress={() => runAudio('remove')}
                style={[styles.songAction, { borderColor: pal.line }]}
              >
                <Text style={[textType.eyebrow, { color: pal.ink }]}>
                  REMOVE
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      <View style={styles.songActions}>
        <Pressable
          disabled={!row.ready || detailLoading}
          onPress={loadDetail}
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[textType.eyebrow, { color: pal.ink }]}>
            {detailLoading ? 'LOADING' : detail === null ? 'DETAILS' : 'CLOSE'}
          </Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() =>
              onPatch(row.backend.nodePubkey, row.song, {
                title: title.trim(),
                tags: parsedTags,
              }),
            )
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[textType.eyebrow, { color: pal.ink }]}>SAVE</Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() =>
              onPatch(row.backend.nodePubkey, row.song, {
                favorite: !row.song.favorite,
              }),
            )
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[textType.eyebrow, { color: pal.ink }]}>
            {row.song.favorite ? 'UNFAVORITE' : 'FAVORITE'}
          </Text>
        </Pressable>
        <Pressable
          disabled={!row.ready || saving}
          onPress={() =>
            run(() => onPresence(row.backend.nodePubkey, row.song))
          }
          style={[styles.songAction, { borderColor: pal.line }]}
        >
          <Text style={[textType.eyebrow, { color: pal.ink }]}>
            {row.song.trashed ? 'RESTORE' : 'TRASH'}
          </Text>
        </Pressable>
      </View>
      {detail !== null ? (
        <View style={[styles.songDetail, { borderColor: pal.line }]}>
          <Text style={[textType.eyebrow, { color: pal.faint }]}>
            FULL REQUEST
          </Text>
          <Text style={[textType.small, { color: pal.ink }]}>
            {detail.generation.caption}
          </Text>
          {detail.generation.lyrics ? (
            <Text style={[textType.small, { color: pal.muted }]}>
              {detail.generation.lyrics}
            </Text>
          ) : null}
          <Text style={[textType.small, { color: pal.muted }]}>
            {detail.engine} · attempt {detail.attempts}
            {detail.generation.seed === undefined
              ? ''
              : ` · seed ${detail.generation.seed}`}
            {detail.generation.steps === undefined
              ? ''
              : ` · ${detail.generation.steps} steps`}
          </Text>
          <Text style={[textType.small, { color: pal.faint }]}>
            {detail.component_digests.length} verified component digest(s) ·
            local playback uses a digest-verified Opus derivative
          </Text>
        </View>
      ) : null}
      {!row.ready ? (
        <Text style={[textType.small, { color: pal.faint }]}>
          Node offline · cached header
        </Text>
      ) : null}
    </View>
  );
}
