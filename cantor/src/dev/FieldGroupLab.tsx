/** Visual-only fixtures; nothing is written to the library or sent to a node. */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { FieldCanvas } from '../features/field/FieldCanvas';
import type { FieldPresentation } from '../features/field/useFieldController';
import { byTime, layoutField, levelCameraTarget } from '../field';
import {
  GROUP_SCENARIOS,
  groupScenario,
} from '../field/fixtures/groupScenarios';
import { usePalette } from '../theme/tokens';

const names = Object.keys(GROUP_SCENARIOS) as (keyof typeof GROUP_SCENARIOS)[];
export function FieldGroupLab() {
  const palette = usePalette();
  const [scenario, setScenario] = useState(0);
  const [viewport, setViewport] = useState({ width: 393, height: 680 });
  const [shelf, setShelf] = useState(false);
  const entities = useMemo(
    () => groupScenario(GROUP_SCENARIOS[names[scenario]]),
    [scenario],
  );
  const layout = useMemo(
    () => layoutField({ entities, arrangement: byTime, viewport }),
    [entities, viewport],
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
  const camera = levelCameraTarget(shelf ? 'shelf' : 'field', layout, focus)!;
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <Text style={{ color: palette.ink }}>
        GROUP LAB · {names[scenario]} · {entities.length} songs
      </Text>
      <View style={styles.controls}>
        <Pressable
          onPress={() => {
            setScenario((scenario + 1) % names.length);
            setShelf(false);
          }}
        >
          <Text style={{ color: palette.ink }}>NEXT SCENARIO</Text>
        </Pressable>
        <Pressable onPress={() => setShelf(!shelf)}>
          <Text style={{ color: palette.ink }}>
            {shelf ? 'MAP' : 'BUSIEST SHELF'}
          </Text>
        </Pressable>
      </View>
      <View
        style={styles.canvas}
        onLayout={event => setViewport(event.nativeEvent.layout)}
      >
        <Scene
          key={`${scenario}:${shelf}:${viewport.width}:${viewport.height}`}
          {...{ layout, viewport, presentations, camera, palette }}
        />
      </View>
    </View>
  );
}
function Scene(
  props: Pick<
    React.ComponentProps<typeof FieldCanvas>,
    'layout' | 'viewport' | 'presentations' | 'camera' | 'palette'
  >,
) {
  const cameraShared = useSharedValue(props.camera);
  const fitScaleShared = useSharedValue(props.layout.fitScale);
  return (
    <FieldCanvas
      {...props}
      placements={props.layout.placements}
      cameraShared={cameraShared}
      fitScaleShared={fitScaleShared}
      nowMs={new Date(2026, 8, 20).getTime()}
    />
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 40 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 20,
  },
  canvas: { flex: 1 },
});
