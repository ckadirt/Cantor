import React from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { audioKey } from '../audio/repository';
import { PairBackendModal } from '../backends/PairBackendModal';
import { BackendCard } from '../features/backends';
import { shortKey } from '../features/jobs';
import { LibraryTimeline, type LibraryRow } from '../features/library';
import type { AppIdentity } from '../identity/derive';
import {
  DEFAULT_BACKEND_SNAPSHOT,
  deliveryArtifact,
  useBackendRuntime,
} from '../runtime';
import { space, touch, type, usePalette } from '../theme/tokens';

const READY_BACKGROUND_LIGHT = '#EFF8F0';
const READY_BACKGROUND_DARK = '#0B2110';
const READY_BORDER_LIGHT = '#73A97B';
const READY_BORDER_DARK = '#70B67A';

type Props = {
  identity: AppIdentity;
};

export function MainScreen({ identity }: Props) {
  const pal = usePalette();
  const dark = pal.bg === '#000000';
  const { state, commands } = useBackendRuntime(identity);
  const { backends, snapshots, pairing, storageError, localAudio } = state;

  const libraryRows: LibraryRow[] = (backends ?? [])
    .flatMap(backend =>
      (snapshots[backend.nodePubkey]?.songs ?? []).map(song => {
        const delivery = deliveryArtifact(song);
        const local = localAudio[
          audioKey(backend.nodePubkey, song.id, delivery?.sha256 ?? 'none')
        ] ?? { state: 'remote', bytes: 0 };
        return {
          backend,
          song,
          delivery,
          local,
          availableOffline: ['cached', 'pinned'].includes(local.state),
          ready: snapshots[backend.nodePubkey]?.phase === 'ready',
          nodeLabels: [
            backend.petname,
            backend.lastNodeInfo?.name ?? '',
            backend.nodePubkey,
          ],
        };
      }),
    )
    .sort(
      (left, right) =>
        right.song.created_at.localeCompare(left.song.created_at) ||
        right.song.id.localeCompare(left.song.id),
    );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: pal.bg }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={Object.values(snapshots).some(
              snapshot => snapshot.librarySyncing,
            )}
            onRefresh={commands.refreshLibraries}
            tintColor={pal.muted}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Text style={[type.eyebrow, { color: pal.muted }]}>CANTOR</Text>
        <Text style={[type.title, styles.title, { color: pal.ink }]}>
          Library
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

        <LibraryTimeline
          rows={libraryRows}
          onDetail={commands.getSongDetail}
          onPatch={commands.patchSong}
          onPresence={commands.changeSongPresence}
          onAudio={commands.audio}
          onError={commands.reportError}
        />

        <Text style={[type.eyebrow, styles.sectionLabel, { color: pal.faint }]}>
          BACKENDS
        </Text>

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
              snapshot={
                snapshots[backend.nodePubkey] ?? DEFAULT_BACKEND_SNAPSHOT
              }
              readyBackground={
                dark ? READY_BACKGROUND_DARK : READY_BACKGROUND_LIGHT
              }
              readyBorder={dark ? READY_BORDER_DARK : READY_BORDER_LIGHT}
              onSubmit={commands.submit}
              onJobControl={commands.controlJob}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={commands.showPairing}
          style={[styles.pairButton, { borderColor: pal.ink }]}
        >
          <Text style={[type.mono, { color: pal.ink }]}>Pair a backend</Text>
        </Pressable>
      </View>

      <PairBackendModal
        visible={pairing}
        onClose={commands.hidePairing}
        onPair={commands.pairBackend}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, paddingBottom: space.xxl },
  title: { marginTop: space.sm },
  identity: { marginTop: space.sm, marginBottom: space.xl },
  error: { marginBottom: space.md },
  sectionLabel: { marginTop: space.xl, marginBottom: space.sm },
  empty: { borderWidth: 1, padding: space.lg },
  emptyBody: { marginTop: space.sm },
  footer: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  pairButton: {
    minHeight: touch.min,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
