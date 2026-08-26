import React from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import { parameterProblem } from '../../core/protocol/parameters';
import { space, touch, type, usePalette } from '../../theme/tokens';

type Props = {
  /** What the selected model declared. Empty renders nothing at all. */
  declared: readonly ModelParameter[];
  values: Readonly<Record<string, ParameterValue>>;
  disabled: boolean;
  onChange: (key: string, value: ParameterValue) => void;
};

/**
 * Controls for whatever the node declared, rendered from the declaration.
 *
 * There is deliberately no engine name, model name or family anywhere in this
 * file. If ACE-Step shows steps and CFG while another engine shows nothing,
 * that is because their catalogs say so — not because the app knows which is
 * which. That is the whole point of declaring parameters on the wire.
 */
export function ModelParams({ declared, values, disabled, onChange }: Props) {
  const pal = usePalette();
  if (declared.length === 0) return null;

  return (
    <View style={styles.root}>
      {declared.map(parameter => {
        const value = values[parameter.key] ?? parameter.default;
        const problem = parameterProblem(parameter, value);
        return (
          <View key={parameter.key} style={styles.field}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>
              {parameter.label.toUpperCase()}
            </Text>
            {parameter.kind === 'boolean' ? (
              <Pressable
                accessibilityLabel={parameter.label}
                accessibilityRole="switch"
                accessibilityState={{ checked: value === true, disabled }}
                disabled={disabled}
                onPress={() => onChange(parameter.key, value !== true)}
                style={[styles.chip, { borderColor: pal.ink }]}>
                <Text style={[type.mono, { color: pal.ink }]}>
                  {value === true ? 'on' : 'off'}
                </Text>
              </Pressable>
            ) : parameter.kind === 'choice' ? (
              <View style={styles.chips}>
                {parameter.choices.map(choice => (
                  <Pressable
                    accessibilityLabel={`${parameter.label}: ${choice}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: value === choice, disabled }}
                    disabled={disabled}
                    key={choice}
                    onPress={() => onChange(parameter.key, choice)}
                    style={[
                      styles.chip,
                      { borderColor: value === choice ? pal.ink : pal.line },
                      value === choice ? styles.selected : null,
                    ]}>
                    <Text
                      style={[
                        type.mono,
                        { color: value === choice ? pal.ink : pal.muted },
                      ]}>
                      {choice}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={parameter.label}
                editable={!disabled}
                inputMode={parameter.kind === 'text' ? 'text' : 'numeric'}
                onChangeText={next =>
                  onChange(
                    parameter.key,
                    parameter.kind === 'text' ? next : toNumber(next),
                  )
                }
                style={[
                  styles.input,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
                value={String(value)}
              />
            )}
            {problem !== null ? (
              <Text style={[type.mono, { color: pal.muted }]}>{problem}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Keep a half-typed number as a number.
 *
 * An empty or partial entry becomes NaN, which `parameterProblem` reports as
 * "must be a number" rather than silently becoming zero.
 */
function toNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? Number.NaN : Number(trimmed);
}

const styles = StyleSheet.create({
  root: { gap: space.md },
  field: { gap: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: touch.min,
    paddingHorizontal: space.sm,
  },
  selected: { borderWidth: 2 },
  input: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
});
