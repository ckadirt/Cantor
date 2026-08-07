import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { GenerationRequest } from '../../../protocol/GenerationRequest';
import type { AppIdentity } from '../identity/derive';
import { PairBackendModal } from '../backends/PairBackendModal';
import { BackendConnection, NodeRequestError } from '../backends/connection';
import { loadBackends, saveBackends } from '../backends/storage';
import type {
  BackendRecord,
  ConnectionPhase,
  ConnectionSnapshot,
  NodeInfo,
  PairingRequest,
} from '../backends/types';
import { space, touch, type, usePalette } from '../theme/tokens';
import {
  loadOutbox,
  markAccepted,
  markRejected,
  putPending,
  type OutboxEntry,
} from '../jobs/outbox';

const READY_BACKGROUND_LIGHT = '#EFF8F0';
const READY_BACKGROUND_DARK = '#0B2110';
const READY_BORDER_LIGHT = '#73A97B';
const READY_BORDER_DARK = '#70B67A';
const NO_MODELS: NodeInfo['models'] = [];

const DEFAULT_SNAPSHOT: ConnectionSnapshot = {
  phase: 'disconnected',
  error: null,
  jobs: [],
};

type Props = {
  identity: AppIdentity;
};

type LiveConnection = {
  relayUrl: string;
  connection: BackendConnection;
};

export function MainScreen({ identity }: Props) {
  const pal = usePalette();
  const dark = pal.bg === '#000000';
  const [backends, setBackends] = useState<BackendRecord[] | null>(null);
  const [snapshots, setSnapshots] = useState<
    Record<string, ConnectionSnapshot>
  >({});
  const [pairing, setPairing] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const backendsRef = useRef<BackendRecord[]>([]);
  const connections = useRef(new Map<string, LiveConnection>());
  const pairTokens = useRef(new Map<string, string>());
  const outboxInFlight = useRef(new Set<string>());

  const sendOutbox = useCallback(
    async (connection: BackendConnection, entry: OutboxEntry) => {
      if (outboxInFlight.current.has(entry.clientRequestId)) return;
      outboxInFlight.current.add(entry.clientRequestId);
      try {
        const job = await connection.createJob(
          entry.clientRequestId,
          entry.model,
          entry.generation,
        );
        await markAccepted(entry.clientRequestId, job.id);
      } catch (error) {
        if (error instanceof NodeRequestError && !error.retryable) {
          await markRejected(entry.clientRequestId, error.message);
        }
        throw error;
      } finally {
        outboxInFlight.current.delete(entry.clientRequestId);
      }
    },
    [],
  );

  const replaceBackends = useCallback((next: BackendRecord[]) => {
    backendsRef.current = next;
    setBackends(next);
    saveBackends(next).catch(error => setStorageError(readError(error)));
  }, []);

  useEffect(() => {
    let active = true;
    loadBackends()
      .then(loaded => {
        if (active) {
          backendsRef.current = loaded;
          setBackends(loaded);
        }
      })
      .catch(error => {
        if (active) {
          setStorageError(readError(error));
          backendsRef.current = [];
          setBackends([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const rememberNodeInfo = useCallback(
    (nodePubkey: string, info: NodeInfo) => {
      const current = backendsRef.current;
      const existing = current.find(item => item.nodePubkey === nodePubkey);
      if (
        existing &&
        JSON.stringify(existing.lastNodeInfo) === JSON.stringify(info)
      ) {
        return;
      }
      replaceBackends(
        current.map(item =>
          item.nodePubkey === nodePubkey
            ? { ...item, lastNodeInfo: info }
            : item,
        ),
      );
    },
    [replaceBackends],
  );

  useEffect(() => {
    if (backends === null) {
      return;
    }
    const wanted = new Set(backends.map(backend => backend.nodePubkey));
    for (const [nodePubkey, live] of connections.current) {
      if (!wanted.has(nodePubkey)) {
        live.connection.stop();
        connections.current.delete(nodePubkey);
      }
    }
    for (const backend of backends) {
      const current = connections.current.get(backend.nodePubkey);
      if (current?.relayUrl === backend.relayUrl) {
        continue;
      }
      current?.connection.stop();
      const connection = new BackendConnection(
        backend,
        identity,
        pairTokens.current.get(backend.nodePubkey),
        {
          onSnapshot: snapshot => {
            setSnapshots(previous => ({
              ...previous,
              [backend.nodePubkey]: snapshot,
            }));
            if (snapshot.phase === 'ready') {
              loadOutbox()
                .then(entries =>
                  Promise.all(
                    entries
                      .filter(
                        entry =>
                          entry.nodePublicKey === backend.nodePubkey &&
                          entry.state === 'pending',
                      )
                      .map(entry => sendOutbox(connection, entry)),
                  ),
                )
                .catch(error => setStorageError(readError(error)));
            }
          },
          onNodeInfo: info => rememberNodeInfo(backend.nodePubkey, info),
          onPairTokenConsumed: () =>
            pairTokens.current.delete(backend.nodePubkey),
        },
      );
      connections.current.set(backend.nodePubkey, {
        relayUrl: backend.relayUrl,
        connection,
      });
      connection.start();
    }
  }, [backends, identity, rememberNodeInfo, sendOutbox]);

  useEffect(
    () => () => {
      for (const live of connections.current.values()) {
        live.connection.stop();
      }
      connections.current.clear();
    },
    [],
  );

  const handlePair = useCallback(
    (request: PairingRequest) => {
      const nodePubkey = request.backend.nodePubkey;
      pairTokens.current.set(nodePubkey, request.pairToken);
      connections.current.get(nodePubkey)?.connection.stop();
      connections.current.delete(nodePubkey);
      const existing = backendsRef.current.find(
        backend => backend.nodePubkey === nodePubkey,
      );
      const backend = {
        ...request.backend,
        lastNodeInfo: existing?.lastNodeInfo ?? null,
      };
      replaceBackends([
        ...backendsRef.current.filter(item => item.nodePubkey !== nodePubkey),
        backend,
      ]);
      setPairing(false);
    },
    [replaceBackends],
  );

  const handleSubmit = useCallback(
    async (
      nodePublicKey: string,
      model: string,
      generation: GenerationRequest,
    ) => {
      const live = connections.current.get(nodePublicKey);
      if (live === undefined) throw new Error('Backend is not connected.');
      const entry = await putPending(nodePublicKey, model, generation);
      await sendOutbox(live.connection, entry);
    },
    [sendOutbox],
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: pal.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.eyebrow, { color: pal.muted }]}>CANTOR</Text>
        <Text style={[type.title, styles.title, { color: pal.ink }]}>
          Backends
        </Text>
        <Text style={[type.small, styles.identity, { color: pal.faint }]}>
          APP KEY · {shortKey(identity.publicKey)}
        </Text>

        {storageError ? (
          <Text
            accessibilityRole="alert"
            style={[type.small, styles.error, { color: pal.ink }]}
          >
            {storageError}
          </Text>
        ) : null}

        {backends === null ? (
          <Text style={[type.body, { color: pal.muted }]}>
            Loading backends…
          </Text>
        ) : backends.length === 0 ? (
          <View style={[styles.empty, { borderColor: pal.line }]}>
            <Text style={[type.heading, { color: pal.ink }]}>
              No backend paired
            </Text>
            <Text style={[type.body, styles.emptyBody, { color: pal.muted }]}>
              Pair your computer to let Cantor discover its ACE-Step engine.
            </Text>
          </View>
        ) : (
          backends.map(backend => (
            <BackendCard
              key={backend.nodePubkey}
              backend={backend}
              snapshot={snapshots[backend.nodePubkey] ?? DEFAULT_SNAPSHOT}
              readyBackground={
                dark ? READY_BACKGROUND_DARK : READY_BACKGROUND_LIGHT
              }
              readyBorder={dark ? READY_BORDER_DARK : READY_BORDER_LIGHT}
              onSubmit={handleSubmit}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setPairing(true)}
          style={[styles.pairButton, { borderColor: pal.ink }]}
        >
          <Text style={[type.mono, { color: pal.ink }]}>Pair a backend</Text>
        </Pressable>
      </View>

      <PairBackendModal
        visible={pairing}
        onClose={() => setPairing(false)}
        onPair={handlePair}
      />
    </SafeAreaView>
  );
}

function BackendCard({
  backend,
  snapshot,
  readyBackground,
  readyBorder,
  onSubmit,
}: {
  backend: BackendRecord;
  snapshot: ConnectionSnapshot;
  readyBackground: string;
  readyBorder: string;
  onSubmit: (
    nodePublicKey: string,
    model: string,
    generation: GenerationRequest,
  ) => Promise<void>;
}) {
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

function Fact({ label, value }: { label: string; value: string }) {
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

function phaseLabel(phase: ConnectionPhase): string {
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

function shortKey(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  title: { marginTop: space.sm },
  identity: { marginTop: space.sm, marginBottom: space.xl },
  error: { marginBottom: space.md },
  empty: { borderWidth: 1, padding: space.lg },
  emptyBody: { marginTop: space.sm },
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
  footer: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  pairButton: {
    minHeight: touch.min,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
