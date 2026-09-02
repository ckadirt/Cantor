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
import {
  ComposerCurtain,
  ComposerSheet,
  type ComposerTarget,
} from '../features/composer';
import { FIELD_CAMERA_KNOBS } from '../features/field/useFieldCamera';
import { CondenseOverlay } from '../features/composer/CondenseOverlay';
import type { GrainRender } from '../features/field/FieldCanvas';
import type { FieldPresentation } from '../features/field/useFieldController';
import { LensPicker } from '../features/song/LensPicker';
import { PlaylistChips } from '../features/song/PlaylistChips';
import { SongSheet } from '../features/song/SongSheet';
import { SongSurface } from '../features/song/SongSurface';
import { JobSheet } from '../features/field/JobSheet';
import { shelfLabel } from '../features/field/shelfLabels';
import {
  DEFAULT_ORDER_KEY,
  arrangementByKey,
  byDate,
  byPlaylist,
  byTime,
  columnsFor,
  gatherFraction,
  grainWindow,
  layoutField,
  orderByKey,
  representationAlphas,
  placementPoint,
  visibleSecondsAt,
  worldToScreen,
  type DateResolution,
  type Placement,
  type Viewport,
} from '../field';
import { allPlaylists, normalise, playlistsOf, toggle } from '../playlists';
import type { SongDetail } from '../core/protocol';
import type { AppIdentity } from '../identity/derive';
import {
  AnalysisCache,
  DEFAULT_LENS_KEY,
  analyseWindow,
  availabilityAction,
  availabilityOf,
  formatBytes,
  type AvailabilityAction,
  type SongAnalysis,
} from '../lenses';
import {
  DEFAULT_AUDIO_CACHE_BYTES,
  loadAudioBudget,
  saveAudioBudget,
} from '../audio/budget';
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
  /**
   * The song the sheet is open on, and the cluster it was opened from.
   *
   * A subject rather than a flag: the sheet used to be reachable only from the
   * player, so "the focused song" was the only song it could mean. A hold at
   * L0 opens it on a song the camera is nowhere near, and the placement is
   * what says which of a song's several marks was held.
   */
  const [sheetTarget, setSheetTarget] = useState<{
    entityKey: string;
    groupKey: string | null;
  } | null>(null);
  const [songDetail, setSongDetail] = useState<SongDetail | null>(null);
  const [songDetailError, setSongDetailError] = useState<string | null>(null);
  const [songBusy, setSongBusy] = useState(false);
  const [lensKey, setLensKey] = useState(DEFAULT_LENS_KEY);
  const [arrangementKey, setArrangementKey] = useState(byTime.key);
  /**
   * How members are seated, and the seed a random seating is held at.
   *
   * The seed changes only when random is asked for again, which is what makes
   * a shuffle an order rather than a re-roll on every render.
   */
  const [orderKey, setOrderKey] = useState<string>(DEFAULT_ORDER_KEY);
  /** The cache ceiling, read once and written when it is changed. */
  const [budgetBytes, setBudgetBytes] = useState(DEFAULT_AUDIO_CACHE_BYTES);
  useEffect(() => {
    let active = true;
    void loadAudioBudget().then(bytes => {
      if (active) setBudgetBytes(bytes);
    });
    return () => {
      active = false;
    };
  }, []);
  const changeBudget = useCallback((bytes: number) => {
    setBudgetBytes(bytes);
    saveAudioBudget(bytes).catch(error => setAudioError(readError(error)));
  }, []);

  /** The generation whose detail is open, if any. */
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [orderSeed, setOrderSeed] = useState(() => Date.now());
  const chooseOrder = useCallback((key: string) => {
    setOrderKey(current => {
      if (key === 'random' && current === 'random') {
        // Asking for random again is asking for a different random.
        setOrderSeed(Date.now());
      }
      return key;
    });
  }, []);
  const [dateResolution, setDateResolution] = useState<DateResolution>('week');
  const [grain, setGrain] = useState<GrainRender | null>(null);
  /** Rows whose audio command is in flight, so a second tap cannot double it. */
  const audioBusy = useRef(new Set<string>());
  const [audioError, setAudioError] = useState<string | null>(null);
  const [analyses, setAnalyses] = useState<ReadonlyMap<string, SongAnalysis>>(
    () => new Map(),
  );
  const analysisCache = useRef(new AnalysisCache());
  const controller = useMemo(
    () => buildFieldController({ backends, snapshots, localAudio, outbox }),
    [backends, localAudio, outbox, snapshots],
  );
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
      viewport,
      order: orderByKey(orderKey),
      orderSeed,
    });
  }, [
    arrangementKey,
    controller.entities,
    dateResolution,
    orderKey,
    orderSeed,
    viewport,
  ]);

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
  const closeSongSheet = useCallback(() => setSheetTarget(null), []);
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
  /**
   * One row's audio action, from the word at the end of the row.
   *
   * `GET` downloads *and* pins, because asking for a song is the definition of
   * a download: cached is what you get by listening. `KEEP` promotes the loan
   * the budget may reclaim into the promise it may not, and `REMOVE` takes the
   * bytes off the phone — the megabytes the row names are the ones it frees.
   *
   * Both compound verbs are compositions rather than new commands: native
   * storage refuses to delete a pinned artifact outright — `removeCached` says
   * *"Unpin this artifact before removing it"* — so `REMOVE` unpins first, and
   * pinning requires a verified cached file, so `GET` downloads first.
   */
  const runRowAudio = useCallback(
    async (presentation: FieldPresentation, action: AvailabilityAction) => {
      const artifact = presentation.delivery;
      if (artifact === undefined) return;
      const key = presentation.entity.key;
      // A second tap on a row already working would submit the same transfer
      // twice; the runtime would survive it, the row would not read honestly.
      if (audioBusy.current.has(key)) return;
      audioBusy.current.add(key);
      setAudioError(null);
      const run = (verb: Parameters<typeof commands.audio>[3]) =>
        commands.audio(
          presentation.entity.nodePublicKey,
          presentation.song,
          artifact,
          verb,
        );
      try {
        if (action === 'GET') {
          await run('download');
          await run('pin');
        } else if (action === 'KEEP') {
          await run('pin');
        } else {
          // Never delete a file the player still holds open.
          const track = transport.snapshot.track;
          if (
            track?.nodeKey === presentation.entity.nodePublicKey &&
            track?.songId === presentation.entity.entityId
          ) {
            await transport.close();
          }
          if (presentation.localAudio.state === 'pinned') await run('unpin');
          await run('remove');
        }
      } catch (error) {
        setAudioError(readError(error));
      } finally {
        audioBusy.current.delete(key);
      }
    },
    [commands, transport],
  );

  const onRowAction = useCallback(
    (placement: Placement): boolean => {
      const presentation = controller.presentations.get(placement.entityKey);
      if (presentation === undefined || presentation.delivery === undefined) {
        return false;
      }
      const action = availabilityAction(
        availabilityOf(presentation.localAudio.state),
      );
      if (action === null) return false;
      void runRowAudio(presentation, action);
      return true;
    },
    [controller.presentations, runRowAudio],
  );

  /** A generating mark opens what it is doing; it has no inside to descend to. */
  const onClaimTap = useCallback(
    (placement: Placement): boolean => {
      if (!controller.jobs.has(placement.entityKey)) return false;
      setJobKey(placement.entityKey);
      return true;
    },
    [controller.jobs],
  );

  /** Hold acts: everything about a song that is not the act of listening. */
  const onHoldPlacement = useCallback((placement: Placement) => {
    setPlaybackError(null);
    setSheetTarget({
      entityKey: placement.entityKey,
      groupKey: placement.groupKey,
    });
  }, []);

  const fieldCamera = useFieldCamera({
    layout,
    viewport,
    onOpenComposer: openComposer,
    onOpenEngines: openEngines,
    onRowAction,
    onHoldPlacement,
    onClaimTap,
    nativeRelayout:
      lensKey === 'name' &&
      layout !== null &&
      layout.placements.every(placement =>
        controller.presentations.has(placement.entityKey),
      ),
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
    return key === undefined ? null : controller.presentations.get(key) ?? null;
  }, [controller.presentations, fieldCamera.focus]);

  /**
   * How present the player is, 0..1, from the same band the canvas draws from.
   *
   * `representationAlphas` has computed this since the beginning and nothing
   * read it: `SongSurface` mounted on `level === 'song'`, which is `13·FIT` —
   * where the row is still at 0.998 and the song at 0.003 — so the player cut
   * in seven units of FIT before its own crossfade would have begun. Reading
   * the band is the whole of the seam: the row grows into the player across
   * `12→27·FIT`, chrome and picture on one number.
   */
  const songAlpha = useMemo(
    () =>
      representationAlphas(fieldCamera.camera.scale, fieldCamera.renderFitScale)
        .song,
    [fieldCamera.camera.scale, fieldCamera.renderFitScale],
  );

  /** The song the sheet is open on, if the field still knows about it. */
  const sheetSong = useMemo(
    () =>
      sheetTarget === null
        ? null
        : controller.presentations.get(sheetTarget.entityKey) ?? null,
    [controller.presentations, sheetTarget],
  );

  /**
   * What the sheet is allowed to say about scope.
   *
   * A mark is a `(song, group)` pair, so the same song can be three marks in
   * three clusters. The sheet names the one that was held, counts the rest,
   * and — when that cluster is a playlist — offers to leave just that one.
   */
  const sheetScope = useMemo(() => {
    if (sheetSong === null) {
      return {
        label: null as string | null,
        playlist: null as string | null,
        placements: 0,
        playlists: 0,
      };
    }
    const group =
      sheetTarget?.groupKey === undefined || layout === null
        ? undefined
        : layout.groups.find(
            candidate => candidate.key === sheetTarget.groupKey,
          );
    const playlists = playlistsOf(sheetSong.song.tags);
    const onPlaylistAxis = arrangementKey === byPlaylist.key;
    const isPlaylistGroup =
      onPlaylistAxis &&
      group !== undefined &&
      playlists.some(name => name === group.label);
    return {
      label:
        group === undefined ? null : shelfLabel(group.label, nowMs).primary,
      playlist: isPlaylistGroup ? group.label : null,
      placements:
        layout?.placements.filter(
          placement => placement.entityKey === sheetSong.entity.key,
        ).length ?? 1,
      playlists: playlists.length,
    };
  }, [arrangementKey, layout, nowMs, sheetSong, sheetTarget]);

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
        {
          title: focused.song.title,
          artist: focused.nodeLabels[0] ?? 'Cantor',
        },
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

  const patchSheetSong = useCallback(
    (patch: Parameters<typeof commands.patchSong>[2]) => {
      if (sheetSong === null) return;
      void runSongCommand(() =>
        commands.patchSong(sheetSong.entity.nodePublicKey, sheetSong.song, patch),
      );
    },
    [commands, runSongCommand, sheetSong],
  );

  const runAudioAction = useCallback(
    (action: 'pin' | 'unpin' | 'remove') => {
      if (sheetSong === null || sheetSong.delivery === undefined) return;
      const artifact = sheetSong.delivery;
      const track = transport.snapshot.track;
      const isCurrent =
        track?.nodeKey === sheetSong.entity.nodePublicKey &&
        track?.songId === sheetSong.entity.entityId;
      void runSongCommand(async () => {
        // Never delete a file the player still holds open: drop the reference
        // first, then remove. Native storage stays authoritative either way.
        if (action === 'remove' && isCurrent) await transport.close();
        // Native storage refuses to delete a pinned artifact, so removing one
        // from the phone is unpin-then-remove — the same compound the row does.
        if (action === 'remove' && sheetSong.localAudio.state === 'pinned') {
          await commands.audio(
            sheetSong.entity.nodePublicKey,
            sheetSong.song,
            artifact,
            'unpin',
          );
        }
        await commands.audio(
          sheetSong.entity.nodePublicKey,
          sheetSong.song,
          artifact,
          action,
        );
      });
    },
    [commands, runSongCommand, sheetSong, transport],
  );

  // Ask the node for the recipe whenever the sheet opens on a song.
  // Keyed on the sheet's subject, not the camera's: they are no longer the
  // same song.
  useEffect(() => {
    if (sheetSong === null) return;
    let active = true;
    setSongDetail(null);
    setSongDetailError(null);
    commands
      .getSongDetail(sheetSong.entity.nodePublicKey, sheetSong.entity.entityId)
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
  }, [commands, sheetSong]);

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
        gatherFraction(fieldCamera.camera.scale, fieldCamera.renderFitScale),
      ),
      fieldCamera.camera,
      viewport,
    );
  }, [
    condensing,
    controller.jobs,
    fieldCamera.camera,
    fieldCamera.renderedPlacements,
    fieldCamera.renderFitScale,
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
      fieldCamera.renderFitScale,
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
    fieldCamera.renderFitScale,
    focused,
    player,
    transport.snapshot.positionSeconds,
    viewport,
  ]);

  const closeTopmostSheet = useCallback((): boolean => {
    if (sheetTarget !== null) {
      setSheetTarget(null);
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
  }, [commands, composerOpen, enginesOpen, pairing, sheetTarget]);
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

  const songCount = controller.presentations.size;
  /** The cluster you are inside, named the way its axis names it. */
  const focusedGroupLabel = useMemo(() => {
    const key = fieldCamera.focus?.groupKey;
    if (key === undefined || layout === null) return null;
    const group = layout.groups.find(candidate => candidate.key === key);
    return group === undefined ? null : shelfLabel(group.label, nowMs).primary;
  }, [fieldCamera.focus, layout, nowMs]);

  /**
   * What each node would take with it, if it were forgotten.
   *
   * Counted from the same read model the field is drawn from, so the warning
   * and the screen can never disagree about how many songs a node has here.
   */
  const footprints = useMemo(() => {
    const totals: Record<
      string,
      { songs: number; downloaded: number; bytesHere: number; playlists: number }
    > = {};
    const playlistsByNode: Record<string, Set<string>> = {};
    for (const presentation of controller.presentations.values()) {
      const key = presentation.entity.nodePublicKey;
      const entry = (totals[key] ??= {
        songs: 0,
        downloaded: 0,
        bytesHere: 0,
        playlists: 0,
      });
      entry.songs += 1;
      const state = presentation.localAudio.state;
      if (state === 'cached' || state === 'pinned') {
        entry.downloaded += 1;
        entry.bytesHere += presentation.delivery?.byte_length ?? 0;
      }
      const names = (playlistsByNode[key] ??= new Set<string>());
      for (const name of playlistsOf(presentation.song.tags)) names.add(name);
    }
    for (const [key, names] of Object.entries(playlistsByNode)) {
      const entry = totals[key];
      if (entry !== undefined) entry.playlists = names.size;
    }
    return totals;
  }, [controller.presentations]);

  /** What settings counts: the library as placements, not only as songs. */
  const libraryReport = useMemo(() => {
    const playlists = new Set<string>();
    for (const presentation of controller.presentations.values()) {
      for (const name of playlistsOf(presentation.song.tags)) {
        playlists.add(normalise([name])[0] ?? name);
      }
    }
    return {
      songs: controller.presentations.size,
      placements: layout?.placements.length ?? controller.presentations.size,
      playlists: playlists.size,
    };
  }, [controller.presentations, layout]);

  /** The two bands, counted apart because they promise different things. */
  const storageReport = useMemo(() => {
    let downloadedSongs = 0;
    let downloadedBytes = 0;
    let cachedSongs = 0;
    let cachedBytes = 0;
    for (const presentation of controller.presentations.values()) {
      const bytes = presentation.delivery?.byte_length ?? 0;
      if (presentation.localAudio.state === 'pinned') {
        downloadedSongs += 1;
        downloadedBytes += bytes;
      } else if (presentation.localAudio.state === 'cached') {
        cachedSongs += 1;
        cachedBytes += bytes;
      }
    }
    return { downloadedSongs, downloadedBytes, cachedSongs, cachedBytes };
  }, [controller.presentations]);

  /** The cluster you are standing inside, at L1 and nowhere else. */
  const shelfGroup = useMemo(() => {
    if (fieldCamera.level !== 'shelf' || layout === null) return null;
    const groupKey = fieldCamera.focus?.groupKey;
    return (
      layout.groups.find(candidate => candidate.key === groupKey) ?? null
    );
  }, [fieldCamera.focus, fieldCamera.level, layout]);

  /**
   * What `DOWNLOAD ALL` would fetch from the shelf you are standing in, and
   * what it weighs.
   *
   * The size is the point: downloads and the cache are different things, so
   * nothing here is measured against the cache budget and nothing is refused.
   * What a person is owed before asking for a whole shelf is the number.
   * Songs already downloaded are not counted — they are already yours.
   */
  const shelfDownload = useMemo(() => {
    if (shelfGroup === null) return null;
    const group = shelfGroup;
    const pending = group.entityKeys.flatMap(key => {
      const presentation = controller.presentations.get(key);
      return presentation === undefined ||
        presentation.delivery === undefined ||
        presentation.localAudio.state === 'pinned'
        ? []
        : [presentation];
    });
    if (pending.length === 0) return null;
    const bytes = pending.reduce(
      (total, presentation) => total + (presentation.delivery?.byte_length ?? 0),
      0,
    );
    return { pending, label: `DOWNLOAD ALL · ${formatBytes(bytes)}` };
  }, [controller.presentations, shelfGroup]);

  /** One at a time: the shelf shares one relay socket with everything else. */
  const downloadShelf = useCallback(() => {
    if (shelfDownload === null) return;
    void (async () => {
      for (const presentation of shelfDownload.pending) {
        await runRowAudio(presentation, 'GET');
      }
    })();
  }, [runRowAudio, shelfDownload]);

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
                cameraShared={fieldCamera.cameraShared}
                layout={layout}
                labelFromGroups={fieldCamera.labelFromGroups}
                palette={pal}
                placements={fieldCamera.visualPlacements}
                activeLensKey={lensKey}
                analyses={analyses}
                grain={grain}
                jobs={controller.jobs}
                focusKey={fieldCamera.focus?.key ?? null}
                playingKey={playingKey}
                nowMs={nowMs}
                playingProgress={playingProgress}
                relayoutLinear={fieldCamera.relayoutLinear}
                renderFitScale={fieldCamera.renderFitScale}
                transitionGeneration={fieldCamera.transitionGeneration}
                recut={fieldCamera.recut}
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
        {songAlpha > 0.01 && focused !== null && viewport !== null ? (
          <View
            // Touchable only once it is mostly here: a transport at 4% opacity
            // is a control nobody can see and everybody can press.
            pointerEvents={songAlpha > 0.6 ? 'box-none' : 'none'}
            style={[StyleSheet.absoluteFill, { opacity: songAlpha }]}>
            <SongSurface
            available={focused.delivery !== undefined}
            isCurrent={focusedIsCurrent}
            lens={<LensPicker activeKey={lensKey} onChange={setLensKey} />}
            onOpenDetail={() => {
              setPlaybackError(null);
              setSheetTarget({
                entityKey: focused.entity.key,
                groupKey: fieldCamera.focus?.groupKey ?? null,
              });
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
          </View>
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
          onChangeOrder={chooseOrder}
          onShelfAction={downloadShelf}
          orderKey={orderKey}
          shelfAction={shelfDownload?.label ?? null}
          songCount={shelfGroup?.entityKeys.length ?? songCount}
          storageError={audioError ?? storageError}
        />
      </View>

      <EnginesSheet
        backends={backends}
        onClose={closeEngines}
        onPair={pairFromEngines}
        onRefresh={commands.refreshLibraries}
        refreshing={refreshing}
        budgetBytes={budgetBytes}
        footprints={footprints}
        library={libraryReport}
        onChangeBudget={changeBudget}
        publicKey={identity.publicKey}
        storage={storageReport}
        onForget={nodePublicKey => {
          setEnginesOpen(false);
          void commands.forgetBackend(nodePublicKey);
        }}
        onRename={commands.renameBackend}
        snapshots={snapshots}
        visible={enginesOpen}
      />
      {/*
        The composer is a blind, not a modal: it hangs above the top edge and
        comes down with the finger that pulls it. `pullShared` is where it is,
        written by the field's own edge gesture on the UI thread; `composerOpen`
        is only whether it ends up down or back up.
      */}
      {viewport !== null ? (
        <ComposerCurtain
          onClose={closeComposer}
          open={composerOpen}
          openAtPx={FIELD_CAMERA_KNOBS.EDGE_PULL_OPEN_PX}
          pull={fieldCamera.pullShared}
          viewportHeight={viewport.height}>
          <ComposerSheet
            error={submitError}
            onClose={closeComposer}
            onSubmit={onComposerSubmit}
            submitting={submitting}
            targets={composerTargets}
          />
        </ComposerCurtain>
      ) : null}
      <PairBackendModal
        onClose={commands.hidePairing}
        onPair={commands.pairBackend}
        visible={pairing}
      />
      {sheetSong !== null ? (
        <SongSheet
          audioState={sheetSong.localAudio.state}
          busy={songBusy}
          detail={songDetail}
          detailError={songDetailError}
          downloadedBytes={sheetSong.delivery?.byte_length ?? null}
          nodeLabel={sheetSong.nodeLabels[0] ?? sheetSong.backend.petname}
          onAddTag={tag =>
            patchSheetSong({
              tags: [...normalise([...sheetSong.song.tags, tag])],
            })
          }
          onClose={closeSongSheet}
          onPin={() => runAudioAction('pin')}
          onRemoveDownload={() => runAudioAction('remove')}
          onRemoveFromScope={() => {
            const playlist = sheetScope.playlist;
            if (playlist === null) return;
            patchSheetSong({
              tags: [...toggle(sheetSong.song.tags, playlist, false)],
            });
            setSheetTarget(null);
          }}
          onRemoveTag={tag =>
            patchSheetSong({
              tags: sheetSong.song.tags.filter(value => value !== tag),
            })
          }
          onRename={title => patchSheetSong({ title })}
          placementCount={sheetScope.placements}
          playlistCount={sheetScope.playlists}
          playlists={
            <PlaylistChips
              busy={songBusy}
              known={knownPlaylists}
              onToggle={(name, member) =>
                patchSheetSong({
                  tags: [...toggle(sheetSong.song.tags, name, member)],
                })
              }
              tags={sheetSong.song.tags}
            />
          }
          onToggleFavourite={() =>
            patchSheetSong({ favorite: !sheetSong.song.favorite })
          }
          onTrash={() =>
            void runSongCommand(async () => {
              const track = transport.snapshot.track;
              if (
                track?.nodeKey === sheetSong.entity.nodePublicKey &&
                track?.songId === sheetSong.entity.entityId
              ) {
                await transport.close();
              }
              await commands.changeSongPresence(
                sheetSong.entity.nodePublicKey,
                sheetSong.song,
              );
              setSheetTarget(null);
            })
          }
          onUnpin={() => runAudioAction('unpin')}
          scopeLabel={sheetScope.label}
          scopePlaylist={sheetScope.playlist}
          song={sheetSong.song}
          visible={sheetSong !== null}
        />
      ) : null}
      <JobSheet
        busy={jobBusy}
        error={jobError}
        onClose={() => {
          setJobKey(null);
          setJobError(null);
        }}
        onControl={control => {
          const pending = jobKey === null ? null : controller.jobs.get(jobKey);
          if (pending === undefined || pending === null) return;
          setJobBusy(true);
          setJobError(null);
          void commands
            .controlJob(pending.entity.nodePublicKey, pending.job, control)
            .catch(problem => setJobError(readError(problem)))
            .finally(() => setJobBusy(false));
        }}
        pending={jobKey === null ? null : controller.jobs.get(jobKey) ?? null}
      />
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
