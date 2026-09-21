/** Visual-only fixtures; nothing is written to the library or sent to a node. */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFieldCamera } from '../features/field/useFieldCamera';
import { FieldCanvas } from '../features/field/FieldCanvas';
import type { FieldPresentation } from '../features/field/useFieldController';
import { byDate, layoutField, type DateResolution } from '../field';
import {
  GROUP_SCENARIOS,
  groupScenario,
} from '../field/fixtures/groupScenarios';
import { usePalette } from '../theme/tokens';

const names = Object.keys(GROUP_SCENARIOS) as (keyof typeof GROUP_SCENARIOS)[];
export function FieldGroupLab() {
  const palette = usePalette();
  const [nowMs] = useState(Date.now);
  const [scenario, setScenario] = useState(names.indexOf('crowdedWeek'));
  const [viewport, setViewport] = useState({ width: 393, height: 680 });
  const [resolution, setResolution] = useState<DateResolution>('week');
  const entities = useMemo(
    () =>
      groupScenario(
        GROUP_SCENARIOS[names[scenario]],
        names[scenario] === 'sixMonths' ? new Date(2026, 3, 6, 12) : undefined,
      ),
    [scenario],
  );
  const layout = useMemo(
    () => layoutField({ entities, arrangement: byDate(resolution), viewport }),
    [entities, viewport, resolution],
  );
  const presentations = useMemo(
    () =>
      new Map(
        entities.map(entity => [
          entity.key,
          {
            entity,
            song: {
              id: entity.entityId,
              revision: 1,
              title: `Test song ${entity.entityId}`,
              caption_summary: 'Artificial layout sample',
              created_at: new Date(entity.createdAtMs).toISOString(),
              duration_ms: entity.durationMs,
              model: 'fixture',
              favorite: false,
              tags: [...entity.tags],
              trashed: false,
              artifacts: [],
            },
            backend: {
              nodePubkey: 'layout-fixture',
              petname: 'Layout test',
              relayUrl: '',
              lastNodeInfo: null,
            },
            ready: false,
            nodeLabels: ['Layout test'],
            delivery: undefined,
            localAudio: { state: 'remote', bytes: 0 },
          } satisfies FieldPresentation,
        ]),
      ),
    [entities],
  );
  const busiest = layout.groups.reduce((best, group) =>
    group.entityKeys.length > best.entityKeys.length ? group : best,
  );
  const focus = layout.placements.find(
    placement => placement.groupKey === busiest.key,
  )!;
  const fieldCamera = useFieldCamera({
    layout,
    viewport,
    onOpenComposer: noop,
    onOpenEngines: noop,
    nativeRelayout: true,
  });
  const shelf = fieldCamera.level !== 'field';
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]}>
      <View
        style={styles.canvas}
        onLayout={event => setViewport(event.nativeEvent.layout)}
      >
        <GestureDetector gesture={fieldCamera.gesture}>
          <View style={styles.canvas}>
            <FieldCanvas
              layout={layout}
              viewport={viewport}
              presentations={presentations}
              palette={palette}
              camera={fieldCamera.camera}
              cameraShared={fieldCamera.cameraShared}
              fitScaleShared={fieldCamera.fitScaleShared}
              placements={fieldCamera.visualPlacements}
              renderFitScale={fieldCamera.renderFitScale}
              recut={fieldCamera.recut}
              labelFromGroups={fieldCamera.labelFromGroups}
              relayoutLinear={fieldCamera.relayoutLinear}
              transitionGeneration={fieldCamera.transitionGeneration}
              nowMs={nowMs}
            />
          </View>
        </GestureDetector>
      </View>
      <View style={[styles.toolbar, { backgroundColor: palette.bg }]}>
        <Text style={[styles.metrics, { color: palette.ink }]}>
          GROUP LAB · {names[scenario]} · {entities.length} songs ·{' '}
          {layout.groups.length} {resolution}s{'\n'}
          {viewport.width.toFixed(2)} × {viewport.height.toFixed(2)} dp · FIT{' '}
          {layout.fitScale.toFixed(6)}
          {'\n'}CAM {fieldCamera.camera.x.toFixed(2)},{' '}
          {fieldCamera.camera.y.toFixed(2)} ·{' '}
          {fieldCamera.camera.scale.toFixed(6)}
        </Text>
        <View style={styles.controls}>
          <Pressable onPress={fieldCamera.home}>
            <Text style={{ color: palette.ink }}>FIT MAP</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setScenario((scenario + 1) % names.length);
              fieldCamera.home();
            }}
          >
            <Text style={{ color: palette.ink }}>NEXT SCENARIO</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              shelf ? fieldCamera.home() : fieldCamera.descend(focus)
            }
          >
            <Text style={{ color: palette.ink }}>
              {shelf ? 'MAP' : 'BUSIEST SHELF'}
            </Text>
          </Pressable>
        </View>
        <Pressable
          onPress={() => {
            setResolution(resolution === 'week' ? 'month' : 'week');
            fieldCamera.home();
          }}
        >
          <Text style={{ color: palette.ink }}>
            SHOW {resolution === 'week' ? 'MONTHS' : 'WEEKS'} · DRAG TO EXPLORE
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
const noop = () => {};
const styles = StyleSheet.create({
  root: { flex: 1 },
  metrics: { fontSize: 10 },
  toolbar: { position: 'absolute', top: 24, left: 0, right: 0 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
  },
  canvas: { flex: 1 },
});
