import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import { parameterProblem } from '../../core/protocol/parameters';
import { Dial } from '../controls';
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
 *
 * A declared choice is a dial and a declared switch is a two-word dial, so a
 * knob the node invented reads exactly like the ones the composer ships with.
 * Anything typed is a line with a rule under it rather than a box around it:
 * this design has no boxes, and a field that draws one is the tell that some
 * part of the sheet came from somewhere else.
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
            <Text style={[styles.meta, { color: pal.muted }]}>
              {parameter.label.toUpperCase()}
            </Text>
            {parameter.kind === 'boolean' ? (
              <Dial
                activeColour={pal.ink}
                activeKey={value === true ? 'on' : 'off'}
                items={SWITCH.map(state => ({
                  key: state,
                  label: state.toUpperCase(),
                  accessibilityLabel: `${parameter.label}: ${state}`,
                }))}
                itemStyle={styles.dialItem}
                onSelect={key => {
                  if (!disabled) onChange(parameter.key, key === 'on');
                }}
                restColour={pal.faint}
                textStyle={styles.meta}
                tickColour={pal.ink}
              />
            ) : parameter.kind === 'choice' ? (
              <Dial
                activeColour={pal.ink}
                activeKey={String(value)}
                items={parameter.choices.map(choice => ({
                  key: choice,
                  label: choice.toUpperCase(),
                  accessibilityLabel: `${parameter.label}: ${choice}`,
                }))}
                itemStyle={styles.dialItem}
                onSelect={key => {
                  if (!disabled) onChange(parameter.key, key);
                }}
                restColour={pal.faint}
                scroll
                textStyle={styles.meta}
                tickColour={pal.ink}
              />
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
                  { borderColor: pal.line, color: pal.ink },
                ]}
                value={String(value)}
              />
            )}
            {problem !== null ? (
              <Text style={[styles.meta, { color: pal.ink }]}>{problem}</Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** The two positions of a declared switch, in the order a switch reads. */
const SWITCH = ['off', 'on'] as const;

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

/** Wide enough for a number or a short word, and for a finger. */
const FIELD_WIDTH_PX = 120;

const styles = StyleSheet.create({
  root: { gap: space.md },
  field: { gap: space.xs },
  meta: { ...type.eyebrow, fontSize: 12, letterSpacing: 0.7, lineHeight: 19 },
  dialItem: { justifyContent: 'center', minHeight: touch.min },
  /**
   * A rule under the words, not a box around them — and only as wide as the
   * answer it is ruled for. A full-width rule under a two-digit number reads
   * as a section divider, which is what it looked like on the phone.
   */
  input: {
    alignSelf: 'flex-start',
    borderBottomWidth: 1,
    minWidth: FIELD_WIDTH_PX,
    padding: 0,
    // The rule belongs to the answer, so it sits just under it. Given the
    // whole of `touch.min` the digits floated in the middle of an empty box
    // and the rule read as another divider.
    paddingBottom: space.xs,
  },
});
