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
  buildFieldController,
  useFieldCamera,
} from '../features/field';
import { ComposerSheet, type ComposerTarget } from '../features/composer';
import { CondenseOverlay } from '../features/composer/CondenseOverlay';
import type { GrainRender } from '../features/field/FieldCanvas';
import { LensPicker } from '../features/song/LensPicker';
import { PlaylistChips } from '../features/song/PlaylistChips';
import { SongSheet } from '../features/song/SongSheet';
import { SongSurface } from '../features/song/SongSurface';
import { shelfLabel } from '../features/field/shelfLabels';
import {
  arrangementByKey,
  byDate,
  byTime,
  columnsFor,
  gatherFraction,
  grainWindow,
  layoutField,
  placementPoint,
  visibleSecondsAt,
  worldToScreen,
  type DateResolution,
  type FieldLayout,
  type Viewport,
} from '../field';
import { allPlaylists, normalise, toggle } from '../playlists';
import type { SongDetail } from '../core/protocol';
import type { AppIdentity } from '../identity/derive';
import {
  AnalysisCache,
  DEFAULT_LENS_KEY,
  analyseWindow,
  type SongAnalysis,
} from '../lenses';
import { createAudioApiPlayer, PlayerHost, usePlayer } from '../player';
import { useBackendRuntime } from '../runtime';
import { readError } from '../core/errors';
import { space, usePalette } from '../theme/tokens';

type Props = {
  identity: AppIdentity;
};

/** KNOBS */
const ANALYSIS_BUCKETS = 512; // resolution the Cantor intervals are reduced from

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
  const [composerOpen, setComposerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * The caption in flight, from the moment it is sent until it has become a
   * mark. `jobKey` is filled in when the node names the job.
   */
  const [condensing, setCondensing] = useState<{
    caption: string;
    nodePublicKey: string;
    jobKey: string | null;
  } | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [songSheetOpen, setSongSheetOpen] = useState(false);
  const [songDetail, setSongDetail] = useState<SongDetail | null>(null);
  const [songDetailError, setSongDetailError] = useState<string | null>(null);
  const [songBusy, setSongBusy] = useState(false);
  const [lensKey, setLensKey] = useState(DEFAULT_LENS_KEY);
  const [arrangementKey, setArrangementKey] = useState(byTime.key);
  const [dateResolution, setDateResolution] = useState<DateResolution>('week');
  const [grain, setGrain] = useState<GrainRender | null>(null);
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, SongAnalysis>>(
    () => new Map(),
  );
  const analysisCache = useRef(new AnalysisCache());
  const previousPlacements = useRef<FieldLayout['placements']>([]);
  const controller = useMemo(
    () => buildFieldController({ backends, snapshots, localAudio, outbox }),
    [backends, localAudio, outbox, snapshots],
  );
  const layout = useMemo(() => {
    if (viewport === null) return null;
    // Resolution is a property of the date axis, so it is applied here rather
    // than being a third entry in the registry.
    const arrangement =
      arrangementKey === byTime.key
        ? byDate(dateResolution)
        : arrangementByKey(arrangementKey) ?? byTime;
    return layoutField({
      entities: controller.entities,
      arrangement,
      previousPlacements: previousPlacements.current,
      viewport,
    });
  }, [arrangementKey, controller.entities, dateResolution, viewport]);
  useEffect(() => {
    if (layout !== null) previousPlacements.current = layout.placements;
  }, [layout]);

  const openComposer = useCallback(() => {
    setSubmitError(null);
    setComposerOpen(true);
  }, []);

  /** What each paired node advertises, which is what the composer validates against. */
  const composerTargets = useMemo<readonly ComposerTarget[]>(
    () =>
      (backends ?? []).map(backend => {
        const snapshot = snapshots[backend.nodePubkey];
        const info = backend.lastNodeInfo;
        return {
          nodePublicKey: backend.nodePubkey,
          label:
            backend.petname || info?.name || backend.nodePubkey.slice(0, 8),
          ready: snapshot?.phase === 'ready',
          models: info?.models ?? [],
          limits: info?.limits ?? null,
        };
      }),
    [backends, snapshots],
  );

  /**
   * Send one generation.
   *
   * Routed through `runtime.submit` so the persisted outbox and its idempotency
   * behaviour stay intact: a submission survives the app dying between the tap
   * and the node's answer.
   */
  const submitDraft = useCallback(
    async (
      nodePublicKey: string,
      modelSelector: string,
      generation: Parameters<typeof commands.submit>[2],
    ) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        setCondensing({
          caption: generation.caption,
          nodePublicKey,
          jobKey: null,
        });
        setComposerOpen(false);
        await commands.submit(nodePublicKey, modelSelector, generation);
      } catch (error) {
        setCondensing(null);
        setSubmitError(error instanceof Error ? error.message : String(error));
      } finally {
        setSubmitting(false);
      }
    },
    [commands],
  );
  const openEngines = useCallback(() => setEnginesOpen(true), []);
  const closeEngines = useCallback(() => setEnginesOpen(false), []);
  const closeComposer = useCallback(() => setComposerOpen(false), []);
  const closeSongSheet = useCallback(() => setSongSheetOpen(false), []);
  const pairFromEngines = useCallback(() => {
    setEnginesOpen(false);
    commands.showPairing();
  }, [commands]);
  const onComposerSubmit = useCallback<
    React.ComponentProps<typeof ComposerSheet>['onSubmit']
  >(
    (nodePublicKey, modelSelector, generation) =>
      void submitDraft(nodePublicKey, modelSelector, generation),
    [submitDraft],
  );
  const fieldCamera = useFieldCamera({
    layout,
    viewport,
    onOpenComposer: openComposer,
    onOpenEngines: openEngines,
  });
  // The overlay button drops any gesture in flight before the sheet arrives.
  const { cancelGesture } = fieldCamera;
  const openEnginesFromField = useCallback(() => {
    cancelGesture();
    openEngines();
  }, [cancelGesture, openEngines]);
  // The song the camera is focused on, if the field still knows about it.
  const focused = useMemo(() => {
    const key = fieldCamera.focus?.entityKey;
    return key === undefined
      ? null
      : controller.presentations.get(key) ?? null;
  }, [controller.presentations, fieldCamera.focus]);

  /** Every playlist that exists, which is every `p/` tag on every song. */
  const knownPlaylists = useMemo(
    () => allPlaylists(controller.entities.map(entity => entity.tags)),
    [controller.entities],
  );

  const currentTrack = transport.snapshot.track;
  // One key lights every placement of that song, which is what M6 needs when a
  // song sits in several playlists at once.
  const playingKey =
    transport.snapshot.state === 'playing' && currentTrack !== null
      ? `${currentTrack.nodeKey}:${currentTrack.songId}`
      : null;
  const playingProgress =
    transport.snapshot.durationSeconds > 0
      ? transport.snapshot.positionSeconds / transport.snapshot.durationSeconds
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
      if (
        focused.localAudio.state !== 'cached' &&
        focused.localAudio.state !== 'pinned'
      ) {
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
  const runSongCommand = useCallback(async (work: () => Promise<void>) => {
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
  }, []);

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

  /**
   * Where the caption in flight should land.
   *
   * Null until the node has named the job *and* the field has laid out a
   * placement for it. Both halves matter: a placement that does not exist yet
   * is not a position to fly to, and guessing one would land the caption
   * somewhere the mark is not.
   */
  const condenseTarget = useMemo(() => {
    if (condensing === null || viewport === null) return null;
    const key =
      condensing.jobKey ??
      [...controller.jobs.keys()].find(candidate =>
        candidate.startsWith(`${condensing.nodePublicKey}:`),
      ) ??
      null;
    if (key === null) return null;
    const placement = fieldCamera.renderedPlacements.find(
      candidate => candidate.entityKey === key,
    );
    if (placement === undefined) return null;
    // The same pose the canvas drew this mark at, or the panel condenses onto
    // the seat the job would have had if its cluster were gathered.
    return worldToScreen(
      placementPoint(
        placement,
        gatherFraction(fieldCamera.camera.scale, layout?.fitScale ?? 0),
      ),
      fieldCamera.camera,
      viewport,
    );
  }, [
    condensing,
    controller.jobs,
    fieldCamera.camera,
    fieldCamera.renderedPlacements,
    layout,
    viewport,
  ]);

  /**
   * Measure the focused song, once its audio is already on the phone.
   *
   * Deliberately narrow: decoding a song costs tens of megabytes, so this runs
   * for the song being looked at rather than for every cached song in the
   * field. Everything else draws the neutral skeleton, and nothing is ever
   * downloaded in order to decorate a mark.
   */
  useEffect(() => {
    if (focused === null || focused.delivery === undefined) return;
    const onPhone =
      focused.localAudio.state === 'cached' ||
      focused.localAudio.state === 'pinned';
    if (!onPhone) return;

    const key = {
      nodePublicKey: focused.entity.nodePublicKey,
      songId: focused.entity.entityId,
      artifactDigest: focused.delivery.sha256,
      resolution: ANALYSIS_BUCKETS,
    };
    const cached = analysisCache.current.get(key);
    const entityKey = focused.entity.key;
    if (cached !== null) {
      setAnalyses(current =>
        current.get(entityKey) === cached
          ? current
          : new Map(current).set(entityKey, cached),
      );
      return;
    }

    let active = true;
    const artifact = focused.delivery;
    void (async () => {
      try {
        const path = await commands.audioPath(
          focused.entity.nodePublicKey,
          focused.song,
          artifact,
        );
        const window = await player.samples({
          ref: {
            nodeKey: focused.entity.nodePublicKey,
            songId: focused.entity.entityId,
            digest: artifact.sha256,
          },
          localPath: path,
          startSeconds: 0,
          endSeconds: focused.song.duration_ms / 1000,
          buckets: ANALYSIS_BUCKETS,
        });
        if (!active) return;
        const analysis = analyseWindow(window);
        analysisCache.current.put(key, analysis);
        setAnalyses(current => new Map(current).set(entityKey, analysis));
      } catch (error) {
        // A song we cannot measure keeps its skeleton — drawing is not worth an
        // error surface of its own. It is still worth saying why in the log,
        // because a silent fallback and a broken decoder look identical.
        console.warn('lens analysis failed', readError(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [commands, focused, player]);

  /**
   * Resolve the visible slice of audio while the camera is inside a song.
   *
   * The window follows the camera scale, so zooming *is* scrubbing: the request
   * is re-issued as the span changes, and only for the span on screen rather
   * than for the whole song.
   */
  useEffect(() => {
    if (
      fieldCamera.level !== 'grain' ||
      focused === null ||
      viewport === null
    ) {
      setGrain(null);
      return;
    }
    const artifact = focused.delivery;
    const onPhone =
      focused.localAudio.state === 'cached' ||
      focused.localAudio.state === 'pinned';
    if (artifact === undefined || !onPhone) {
      setGrain(null);
      return;
    }

    const duration = focused.song.duration_ms / 1000;
    const visible = visibleSecondsAt(
      fieldCamera.camera.scale,
      layout?.fitScale ?? fieldCamera.camera.scale,
    );
    const centre = transport.snapshot.positionSeconds;
    const window = grainWindow(centre, visible, duration);

    let active = true;
    void (async () => {
      try {
        const path = await commands.audioPath(
          focused.entity.nodePublicKey,
          focused.song,
          artifact,
        );
        const samples = await player.samples({
          ref: {
            nodeKey: focused.entity.nodePublicKey,
            songId: focused.entity.entityId,
            digest: artifact.sha256,
          },
          localPath: path,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          buckets: columnsFor(viewport.width),
        });
        if (!active) return;
        setGrain({
          window: samples,
          label: `${window.visibleSeconds.toFixed(
            2,
          )}s VISIBLE · ${window.centerSeconds.toFixed(2)}s`,
        });
      } catch (error) {
        if (active) setGrain(null);
        console.warn('grain window failed', readError(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [
    commands,
    fieldCamera.camera.scale,
    fieldCamera.level,
    focused,
    layout,
    player,
    transport.snapshot.positionSeconds,
    viewport,
  ]);

  const closeTopmostSheet = useCallback((): boolean => {
    if (songSheetOpen) {
      setSongSheetOpen(false);
      return true;
    }
    if (pairing) {
      commands.hidePairing();
      return true;
    }
    if (composerOpen) {
      setComposerOpen(false);
      return true;
    }
    if (enginesOpen) {
      setEnginesOpen(false);
      return true;
    }
    return false;
  }, [commands, composerOpen, enginesOpen, pairing, songSheetOpen]);
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

  /**
   * What the phone thinks the time is, for labels that read relatively.
   *
   * Re-read when the library changes rather than on a timer: a clock ticking
   * in state would re-record the field picture every minute for a word that
   * changes once a week, and the library changing is the only moment the
   * screen is already re-rendering *and* a week boundary could have passed
   * unnoticed.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
  }, [controller.entities]);
  const songCount = controller.presentations.size;
  /** The cluster you are inside, named the way its axis names it. */
  const focusedGroupLabel = useMemo(() => {
    const key = fieldCamera.focus?.groupKey;
    if (key === undefined || layout === null) return null;
    const group = layout.groups.find(candidate => candidate.key === key);
    return group === undefined ? null : shelfLabel(group.label, nowMs).primary;
  }, [fieldCamera.focus, layout, nowMs]);

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
                activeLensKey={lensKey}
                analyses={analyses}
                grain={grain}
                jobs={controller.jobs}
                playingKey={playingKey}
                nowMs={nowMs}
                playingProgress={playingProgress}
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
        {fieldCamera.level === 'song' &&
        focused !== null &&
        viewport !== null ? (
          <SongSurface
            available={focused.delivery !== undefined}
            isCurrent={focusedIsCurrent}
            lens={<LensPicker activeKey={lensKey} onChange={setLensKey} />}
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
          arrangementKey={arrangementKey}
          dateResolution={dateResolution}
          groupCount={layout?.groups.length ?? 0}
          groupLabel={focusedGroupLabel}
          level={fieldCamera.level}
          onChangeArrangement={setArrangementKey}
          onChangeDateResolution={setDateResolution}
          offline={offline}
          onOpenComposer={openComposer}
          onOpenEngines={openEnginesFromField}
          songCount={songCount}
          storageError={storageError}
        />
      </View>

      <EnginesSheet
        backends={backends}
        onClose={closeEngines}
        onPair={pairFromEngines}
        onRefresh={commands.refreshLibraries}
        refreshing={refreshing}
        snapshots={snapshots}
        visible={enginesOpen}
      />
      <ComposerSheet
        error={submitError}
        onClose={closeComposer}
        onSubmit={onComposerSubmit}
        submitting={submitting}
        targets={composerTargets}
        visible={composerOpen}
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
          onClose={closeSongSheet}
          onPin={() => runAudioAction('pin')}
          onRemoveDownload={() => runAudioAction('remove')}
          onRemoveTag={tag =>
            patchFocused({
              tags: focused.song.tags.filter(value => value !== tag),
            })
          }
          onRename={title => patchFocused({ title })}
          playlists={
            <PlaylistChips
              busy={songBusy}
              known={knownPlaylists}
              onToggle={(name, member) =>
                patchFocused({
                  tags: [...toggle(focused.song.tags, name, member)],
                })
              }
              tags={focused.song.tags}
            />
          }
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
      {condensing !== null && viewport !== null ? (
        <CondenseOverlay
          caption={condensing.caption}
          from={{
            x: space.lg,
            y: viewport.height * 0.24,
            width: viewport.width - space.lg * 2,
          }}
          onSettled={() => setCondensing(null)}
          to={condenseTarget}
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
