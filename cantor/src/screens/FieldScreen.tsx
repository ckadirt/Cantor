import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PairBackendModal } from '../backends/PairBackendModal';
import { EnginesSheet } from '../features/engines';
import {
  FieldA11yList,
  FieldCanvas,
  FieldOverlay,
  OriginMark,
  PullSheet,
  buildFieldController,
  useFieldCamera,
} from '../features/field';
import { SongSheet } from '../features/song/SongSheet';
import { SongSurface } from '../features/song/SongSurface';
import { byTime, layoutField, type FieldLayout, type Viewport } from '../field';
import { normalise } from '../playlists';
import type { SongDetail } from '../core/protocol';
import type { AppIdentity } from '../identity/derive';
import { createAudioApiPlayer, PlayerHost, usePlayer } from '../player';
import { useBackendRuntime } from '../runtime';
import { usePalette } from '../theme/tokens';

type Props = {
  identity: AppIdentity;
};

/** The post-onboarding surface: one field, no parallel console navigation. */
export function FieldScreen({ identity }: Props) {
  const pal = usePalette();
  const { state, commands } = useBackendRuntime(identity);
  const { backends, snapshots, localAudio, outbox, pairing, storageError } =
    state;
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // One player for the life of the screen. A second one would be a second
  // element and a second audio session.
  const player = useMemo(() => createAudioApiPlayer(), []);
  const transport = usePlayer(player);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [composerNoticeOpen, setComposerNoticeOpen] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songSheetOpen, setSongSheetOpen] = useState(false);
  const [songDetail, setSongDetail] = useState<SongDetail | null>(null);
  const [songDetailError, setSongDetailError] = useState<string | null>(null);
  const [songBusy, setSongBusy] = useState(false);
  const previousPlacements = useRef<FieldLayout['placements']>([]);
  const controller = useMemo(
    () => buildFieldController({ backends, snapshots, localAudio, outbox }),
    [backends, localAudio, outbox, snapshots],
  );
  const layout = useMemo(() => {
    if (viewport === null) return null;
    return layoutField({
      entities: controller.entities,
      arrangement: byTime,
      previousPlacements: previousPlacements.current,
      viewport,
    });
  }, [controller.entities, viewport]);
  useEffect(() => {
    if (layout !== null) previousPlacements.current = layout.placements;
  }, [layout]);

  const openComposer = useCallback(() => setComposerNoticeOpen(true), []);
  const openEngines = useCallback(() => setEnginesOpen(true), []);
  const fieldCamera = useFieldCamera({
    layout,
    viewport,
    onOpenComposer: openComposer,
    onOpenEngines: openEngines,
  });
  // The song the camera is focused on, if the field still knows about it.
  const focused = useMemo(() => {
    const key = fieldCamera.focus?.entityKey;
    return key === undefined
      ? null
      : controller.presentations.get(key) ?? null;
  }, [controller.presentations, fieldCamera.focus]);

  const currentTrack = transport.snapshot.track;
  // One key lights every placement of that song, which is what M6 needs when a
  // song sits in several playlists at once.
  const playingKey =
    transport.snapshot.state === 'playing' && currentTrack !== null
      ? `${currentTrack.nodeKey}:${currentTrack.songId}`
      : null;
  const focusedIsCurrent =
    focused !== null &&
    currentTrack !== null &&
    currentTrack.nodeKey === focused.entity.nodePublicKey &&
    currentTrack.songId === focused.entity.entityId;

  /**
   * Play the focused song, fetching it first if the phone does not have it.
   *
   * Download belongs to the runtime and playback belongs to the player; this is
   * the seam between them, and the only place they meet.
   */
  const playFocused = useCallback(async () => {
    if (focused === null) return;
    const artifact = focused.delivery;
    if (artifact === undefined) {
      setPlaybackError('This song has no delivery audio yet.');
      return;
    }
    if (focusedIsCurrent) {
      transport.toggle();
      return;
    }
    setPlaybackError(null);
    try {
      if (focused.localAudio.state !== 'cached' && focused.localAudio.state !== 'pinned') {
        await commands.audio(
          focused.entity.nodePublicKey,
          focused.song,
          artifact,
          'download',
        );
      }
      const path = await commands.audioPath(
        focused.entity.nodePublicKey,
        focused.song,
        artifact,
      );
      await transport.open(
        {
          nodeKey: focused.entity.nodePublicKey,
          songId: focused.entity.entityId,
          digest: artifact.sha256,
        },
        path,
        { title: focused.song.title, artist: focused.nodeLabels[0] ?? 'Cantor' },
      );
    } catch (error) {
      setPlaybackError(error instanceof Error ? error.message : String(error));
    }
  }, [commands, focused, focusedIsCurrent, transport]);

  /**
   * Run one song command, keeping the sheet honest about failure.
   *
   * Every control here mutates node-owned truth, so each one reports its own
   * error rather than failing silently and leaving the sheet showing a state
   * the node never accepted.
   */
  const runSongCommand = useCallback(
    async (work: () => Promise<void>) => {
      setSongBusy(true);
      setSongDetailError(null);
      try {
        await work();
      } catch (error) {
        setSongDetailError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setSongBusy(false);
      }
    },
    [],
  );

  const patchFocused = useCallback(
    (patch: Parameters<typeof commands.patchSong>[2]) => {
      if (focused === null) return;
      void runSongCommand(() =>
        commands.patchSong(focused.entity.nodePublicKey, focused.song, patch),
      );
    },
    [commands, focused, runSongCommand],
  );

  const runAudioAction = useCallback(
    (action: 'pin' | 'unpin' | 'remove') => {
      if (focused === null || focused.delivery === undefined) return;
      const artifact = focused.delivery;
      void runSongCommand(async () => {
        // Never delete a file the player still holds open: drop the reference
        // first, then remove. Native storage stays authoritative either way.
        if (action === 'remove' && focusedIsCurrent) await transport.close();
        await commands.audio(
          focused.entity.nodePublicKey,
          focused.song,
          artifact,
          action,
        );
      });
    },
    [commands, focused, focusedIsCurrent, runSongCommand, transport],
  );

  // Ask the node for the recipe whenever the sheet opens on a song.
  useEffect(() => {
    if (!songSheetOpen || focused === null) return;
    let active = true;
    setSongDetail(null);
    setSongDetailError(null);
    commands
      .getSongDetail(focused.entity.nodePublicKey, focused.entity.entityId)
      .then(detail => {
        if (active) setSongDetail(detail);
      })
      .catch(error => {
        if (active) {
          setSongDetailError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [commands, focused, songSheetOpen]);

  const closeTopmostSheet = useCallback((): boolean => {
    if (songSheetOpen) {
      setSongSheetOpen(false);
      return true;
    }
    if (pairing) {
      commands.hidePairing();
      return true;
    }
    if (composerNoticeOpen) {
      setComposerNoticeOpen(false);
      return true;
    }
    if (enginesOpen) {
      setEnginesOpen(false);
      return true;
    }
    return false;
  }, [commands, composerNoticeOpen, enginesOpen, pairing, songSheetOpen]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (closeTopmostSheet()) return true;
        return fieldCamera.ascend();
      },
    );
    return () => subscription.remove();
  }, [closeTopmostSheet, fieldCamera]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setViewport({ width, height });
  }, []);
  const offline =
    backends !== null &&
    backends.length > 0 &&
    !backends.some(backend => snapshots[backend.nodePubkey]?.phase === 'ready');
  const refreshing = Object.values(snapshots).some(
    snapshot => snapshot.librarySyncing,
  );

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: pal.bg }]}>
      <View onLayout={onLayout} style={styles.field}>
        {layout !== null && viewport !== null ? (
          <GestureDetector gesture={fieldCamera.gesture}>
            <View collapsable={false} style={styles.field}>
              <FieldCanvas
                camera={fieldCamera.camera}
                layout={layout}
                palette={pal}
                placements={fieldCamera.renderedPlacements}
                jobs={controller.jobs}
                playingKey={playingKey}
                presentations={controller.presentations}
                viewport={viewport}
              />
            </View>
          </GestureDetector>
        ) : null}
        {layout !== null ? (
          <>
            <FieldA11yList
              focus={fieldCamera.focus}
              layout={layout}
              level={fieldCamera.level}
              onSelect={fieldCamera.descend}
              placements={fieldCamera.renderedPlacements}
              presentations={controller.presentations}
            />
            <OriginMark
              camera={fieldCamera.camera}
              layout={layout}
              level={fieldCamera.level}
              onPress={fieldCamera.home}
            />
          </>
        ) : null}
        {fieldCamera.level === 'song' && focused !== null && viewport !== null ? (
          <SongSurface
            isCurrent={focusedIsCurrent}
            onOpenDetail={() => {
              setPlaybackError(null);
              setSongSheetOpen(true);
            }}
            onSeek={transport.seek}
            onToggle={() => void playFocused()}
            positionSeconds={transport.positionSeconds}
            snapshot={
              playbackError === null
                ? transport.snapshot
                : { ...transport.snapshot, error: playbackError }
            }
            song={{
              key: focused.entity.key,
              title: focused.song.title,
              model: focused.song.model,
              seed: focused.song.seed,
              durationMs: focused.song.duration_ms,
              nodeLabel: focused.nodeLabels[0] ?? focused.backend.petname,
              audioState: focused.localAudio.state,
            }}
            width={viewport.width}
          />
        ) : null}
        <FieldOverlay
          level={fieldCamera.level}
          offline={offline}
          onOpenEngines={() => {
            fieldCamera.cancelGesture();
            openEngines();
          }}
          storageError={storageError}
        />
      </View>

      <EnginesSheet
        backends={backends}
        onClose={() => setEnginesOpen(false)}
        onPair={() => {
          setEnginesOpen(false);
          commands.showPairing();
        }}
        onRefresh={commands.refreshLibraries}
        refreshing={refreshing}
        snapshots={snapshots}
        visible={enginesOpen}
      />
      <PullSheet
        onClose={() => setComposerNoticeOpen(false)}
        visible={composerNoticeOpen}
      />
      <PairBackendModal
        onClose={commands.hidePairing}
        onPair={commands.pairBackend}
        visible={pairing}
      />
      {focused !== null ? (
        <SongSheet
          audioState={focused.localAudio.state}
          busy={songBusy}
          detail={songDetail}
          detailError={songDetailError}
          nodeLabel={focused.nodeLabels[0] ?? focused.backend.petname}
          onAddTag={tag =>
            patchFocused({ tags: [...normalise([...focused.song.tags, tag])] })
          }
          onClose={() => setSongSheetOpen(false)}
          onPin={() => runAudioAction('pin')}
          onRemoveDownload={() => runAudioAction('remove')}
          onRemoveTag={tag =>
            patchFocused({
              tags: focused.song.tags.filter(value => value !== tag),
            })
          }
          onRename={title => patchFocused({ title })}
          onToggleFavourite={() =>
            patchFocused({ favorite: !focused.song.favorite })
          }
          onTrash={() =>
            void runSongCommand(async () => {
              if (focusedIsCurrent) await transport.close();
              await commands.changeSongPresence(
                focused.entity.nodePublicKey,
                focused.song,
              );
              setSongSheetOpen(false);
            })
          }
          onUnpin={() => runAudioAction('unpin')}
          song={focused.song}
          visible={songSheetOpen}
        />
      ) : null}
      <PlayerHost player={player} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  field: { flex: 1 },
});
