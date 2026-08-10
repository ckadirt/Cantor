import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GenerationRequest } from '../../../../protocol/GenerationRequest';
import type { JobView } from '../../../../protocol/JobView';
import type {
  BackendRecord,
  ConnectionPhase,
  ConnectionSnapshot,
  NodeInfo,
} from '../../backends/types';
import { readError } from '../../core/errors';
import { utf8ByteLength } from '../../core/text';
import { space, touch, type, usePalette } from '../../theme/tokens';
import { JobQueue, shortKey, type JobControl } from '../jobs';

const NO_MODELS: NodeInfo['models'] = [];

export type BackendCardProps = {
  backend: BackendRecord;
  snapshot: ConnectionSnapshot;
  readyBackground: string;
  readyBorder: string;
  onSubmit: (
    nodePublicKey: string,
    model: string,
    generation: GenerationRequest,
  ) => Promise<void>;
  onJobControl: (
    nodePublicKey: string,
    job: JobView,
    control: JobControl,
  ) => Promise<void>;
};

export function BackendCard({
  backend,
  snapshot,
  readyBackground,
  readyBorder,
  onSubmit,
  onJobControl,
}: BackendCardProps) {
  const pal = usePalette();
  const ready = snapshot.phase === 'ready';
  const node = backend.lastNodeInfo;
  const [caption, setCaption] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [duration, setDuration] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [submission, setSubmission] = useState<string | null>(null);
  const submitting = useRef(false);
  const availableModels = node?.models ?? NO_MODELS;
  const durationNumber = duration.length === 0 ? undefined : Number(duration);
  const durationInvalid =
    durationNumber !== undefined &&
    (!Number.isInteger(durationNumber) ||
      durationNumber < (node?.limits.min_song_seconds ?? 0) ||
      durationNumber > (node?.limits.max_song_seconds ?? 0));
  const textInvalid =
    utf8ByteLength(caption.trim()) > (node?.limits.max_caption_bytes ?? 0) ||
    utf8ByteLength(lyrics) > (node?.limits.max_lyrics_bytes ?? 0);
  useEffect(() => {
    if (
      model !== null &&
      !availableModels.some(item => item.selector === model)
    )
      setModel(null);
  }, [availableModels, model]);
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: ready ? readyBackground : pal.bg,
          borderColor: ready ? readyBorder : pal.line,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardName}>
          <Text style={[type.heading, { color: pal.ink }]}>
            {node?.name ?? backend.petname}
          </Text>
          <Text style={[type.small, { color: pal.faint }]}>
            {shortKey(backend.nodePubkey)}
          </Text>
        </View>
        <View style={styles.status}>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: ready ? readyBorder : pal.faint },
            ]}
          />
          <Text
            style={[type.eyebrow, { color: ready ? readyBorder : pal.muted }]}
          >
            {phaseLabel(snapshot.phase)}
          </Text>
        </View>
      </View>

      {node ? (
        <View style={styles.facts}>
          <Fact label="DEVICE" value={node.device_type} />
          <Fact label="ENGINE" value={node.engine_version} />
          <Fact
            label="MODELS"
            value={node.models.map(item => item.selector).join(', ') || 'none'}
          />
          <Fact
            label="LIMITS"
            value={`${node.limits.max_concurrent_jobs} concurrent · ${node.limits.max_song_seconds}s max`}
          />
          <Fact
            label="LOAD"
            value={`${node.load.active_jobs} active · ${node.load.queued_jobs} queued`}
          />
          <Fact label="JOBS" value={String(snapshot.jobs.length)} />
          <JobQueue
            jobs={snapshot.jobs}
            online={ready}
            controlsSupported={node.features.job_controls}
            onControl={(job, control) =>
              onJobControl(backend.nodePubkey, job, control)
            }
          />
          {ready && node.features.jobs_create ? (
            <View style={styles.composer}>
              <Text style={[type.eyebrow, { color: pal.faint }]}>NEW JOB</Text>
              <View style={styles.modelChoices}>
                {availableModels.map(item => (
                  <Pressable
                    key={item.selector}
                    onPress={() => setModel(item.selector)}
                    style={[
                      styles.modelChoice,
                      {
                        borderColor:
                          model === item.selector ? readyBorder : pal.line,
                      },
                    ]}
                  >
                    <Text style={[type.small, { color: pal.ink }]}>
                      {item.selector}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                value={caption}
                onChangeText={setCaption}
                placeholder="Describe the song"
                placeholderTextColor={pal.faint}
                maxLength={node.limits.max_caption_bytes}
                style={[
                  styles.captionInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <TextInput
                value={lyrics}
                onChangeText={setLyrics}
                placeholder="Lyrics (optional)"
                placeholderTextColor={pal.faint}
                multiline
                style={[
                  styles.lyricsInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <TextInput
                value={duration}
                onChangeText={value => setDuration(value.replace(/\D/g, ''))}
                placeholder={`${node.limits.min_song_seconds}–${node.limits.max_song_seconds}s (optional)`}
                placeholderTextColor={pal.faint}
                keyboardType="number-pad"
                style={[
                  styles.durationInput,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
              />
              <Pressable
                disabled={
                  model === null ||
                  caption.trim().length === 0 ||
                  durationInvalid ||
                  textInvalid ||
                  submission === 'Submitting…'
                }
                onPress={() => {
                  if (model === null || submitting.current) return;
                  submitting.current = true;
                  setSubmission('Submitting…');
                  onSubmit(backend.nodePubkey, model, {
                    caption: caption.trim(),
                    ...(lyrics.length > 0 ? { lyrics } : {}),
                    ...(durationNumber !== undefined
                      ? { duration: durationNumber }
                      : {}),
                  })
                    .then(() => {
                      setCaption('');
                      setLyrics('');
                      setDuration('');
                      setSubmission('Queued');
                    })
                    .catch(error => setSubmission(readError(error)))
                    .finally(() => {
                      submitting.current = false;
                    });
                }}
                style={[styles.submitButton, { borderColor: pal.ink }]}
              >
                <Text style={[type.mono, { color: pal.ink }]}>Submit</Text>
              </Pressable>
              {submission ? (
                <Text style={[type.small, { color: pal.muted }]}>
                  {submission}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : (
        <Text style={[type.small, styles.awaiting, { color: pal.muted }]}>
          Waiting for the first authenticated capability response.
        </Text>
      )}
      {snapshot.error ? (
        <Text style={[type.small, styles.cardError, { color: pal.muted }]}>
          {snapshot.error}
        </Text>
      ) : null}
    </View>
  );
}

export type FactProps = { label: string; value: string };

export function Fact({ label, value }: FactProps) {
  const pal = usePalette();
  return (
    <View style={styles.fact}>
      <Text style={[type.eyebrow, { color: pal.faint }]}>{label}</Text>
      <Text style={[type.small, styles.factValue, { color: pal.ink }]}>
        {value}
      </Text>
    </View>
  );
}

export function phaseLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'disconnected':
      return 'DISCONNECTED';
    case 'connecting':
      return 'CONNECTING';
    case 'attached':
      return 'NODE OFFLINE';
    case 'handshaking':
      return 'VERIFYING';
    case 'ready':
      return 'READY';
  }
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, padding: space.lg, marginBottom: space.md },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardName: { flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  facts: { marginTop: space.lg, gap: space.sm },
  fact: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  factValue: { flex: 1, textAlign: 'right' },
  awaiting: { marginTop: space.lg },
  cardError: { marginTop: space.md },
  composer: { marginTop: space.lg, gap: space.sm },
  modelChoices: { gap: space.xs },
  modelChoice: { borderWidth: 1, padding: space.sm },
  captionInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  lyricsInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min * 2,
    textAlignVertical: 'top',
  },
  durationInput: {
    borderWidth: 1,
    paddingHorizontal: space.md,
    minHeight: touch.min,
  },
  submitButton: {
    borderWidth: 1,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
