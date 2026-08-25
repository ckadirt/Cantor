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
import { byTime, layoutField, type FieldLayout, type Viewport } from '../field';
import type { AppIdentity } from '../identity/derive';
import { useBackendRuntime } from '../runtime';
import { usePalette } from '../theme/tokens';

type Props = {
  identity: AppIdentity;
};

/** The post-onboarding surface: one field, no parallel console navigation. */
export function FieldScreen({ identity }: Props) {
  const pal = usePalette();
  const { state, commands } = useBackendRuntime(identity);
  const { backends, snapshots, localAudio, pairing, storageError } = state;
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const [composerNoticeOpen, setComposerNoticeOpen] = useState(false);
  const previousPlacements = useRef<FieldLayout['placements']>([]);
  const controller = useMemo(
    () => buildFieldController({ backends, snapshots, localAudio }),
    [backends, localAudio, snapshots],
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
  const closeTopmostSheet = useCallback((): boolean => {
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
  }, [commands, composerNoticeOpen, enginesOpen, pairing]);
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  field: { flex: 1 },
});
