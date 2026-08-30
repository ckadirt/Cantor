import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { FieldLayout, Level, Placement } from '../../field';
import type { FieldPresentation } from './useFieldController';

type Props = {
  layout: FieldLayout;
  placements: readonly Placement[];
  presentations: ReadonlyMap<string, FieldPresentation>;
  level: Level;
  focus: Placement | null;
  onSelect: (placement: Placement) => void;
};

/** Skia is hidden from screen readers; this mirror uses the same field data. */
function FieldA11yListImpl({
  layout,
  placements,
  presentations,
  level,
  focus,
  onSelect,
}: Props) {
  const visible =
    level === 'field'
      ? placements
      : focus === null
      ? []
      : placements.filter(placement => placement.groupKey === focus.groupKey);
  return (
    <View accessible={false} style={styles.root}>
      {level === 'field'
        ? layout.groups.map(group => (
            <Pressable
              key={`group:${group.key}`}
              accessibilityHint="Opens this week of songs"
              accessibilityLabel={`${group.label}, ${group.entityKeys.length} songs`}
              accessibilityRole="button"
              onPress={() => {
                const placement = placements.find(
                  candidate => candidate.groupKey === group.key,
                );
                if (placement) onSelect(placement);
              }}
              style={styles.item}
            />
          ))
        : null}
      {visible.map(placement => {
        const presentation = presentations.get(placement.entityKey);
        const group = layout.groups.find(
          candidate => candidate.key === placement.groupKey,
        );
        if (presentation === undefined || group === undefined) return null;
        return (
          <Pressable
            key={placement.key}
            accessibilityHint={
              level === 'field'
                ? 'Opens this song group'
                : 'Records this song as the focused row'
            }
            accessibilityLabel={`${presentation.song.title}, ${
              group.label
            }, ${Math.round(presentation.song.duration_ms / 1000)} seconds`}
            accessibilityRole="button"
            onPress={() => onSelect(placement)}
            style={styles.item}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    height: 1,
    left: -10_000,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  item: { height: 1, width: 1 },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const FieldA11yList = React.memo(FieldA11yListImpl);
