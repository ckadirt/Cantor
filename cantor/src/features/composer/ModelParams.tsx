import React from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';
import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import { parameterProblem } from '../../core/protocol/parameters';
import { Dial, LEDGER_DIAL_ITEM, Row } from '../controls';
import { font, space, type, usePalette } from '../../theme/tokens';

type Props = {
  /** What the selected model declared. Empty renders nothing at all. */
  declared: readonly ModelParameter[];
  values: Readonly<Record<string, ParameterValue>>;
  disabled: boolean;
  onChange: (key: string, value: ParameterValue) => void;
};

/**
 * Controls for whatever the node declared, one ledger row each.
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
 *
 * The label is the row's label, in the label column, so a declared control is
 * indistinguishable in shape from `Engine` or `Length`. It used to be an
 * eyebrow stacked over its control, which made every declared knob two rows
 * tall and the declared block the loudest thing under the caption.
 */
export function ModelParams({ declared, values, disabled, onChange }: Props) {
  const pal = usePalette();
  if (declared.length === 0) return null;

  return (
    <>
      {declared.map(parameter => {
        const value = values[parameter.key] ?? parameter.default;
        const problem = parameterProblem(parameter, value);
        return (
          <Row key={parameter.key} label={parameter.label}>
            {parameter.kind === 'boolean' ? (
              <Dial
                activeColour={pal.ink}
                activeKey={value === true ? 'on' : 'off'}
                items={SWITCH.map(state => ({
                  key: state,
                  label: state.toUpperCase(),
                  accessibilityLabel: `${parameter.label}: ${state}`,
                }))}
                itemStyle={LEDGER_DIAL_ITEM}
                onSelect={key => {
                  if (!disabled) onChange(parameter.key, key === 'on');
                }}
                restColour={pal.faint}
                textStyle={styles.word}
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
                itemStyle={LEDGER_DIAL_ITEM}
                onSelect={key => {
                  if (!disabled) onChange(parameter.key, key);
                }}
                restColour={pal.faint}
                scroll
                textStyle={styles.word}
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
              <Text style={[styles.problem, { color: pal.ink }]}>
                {problem}
              </Text>
            ) : null}
          </Row>
        );
      })}
    </>
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
  /** A dial word, at the size every dial in a ledger row is set in. */
  word: { fontFamily: font.mono, fontSize: 12, letterSpacing: 0.4 },
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
  problem: { ...type.small, marginTop: space.xs },
});
