import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { ModelParameter } from '../../../../protocol/ModelParameter';
import type { ParameterValue } from '../../../../protocol/ParameterValue';
import { parameterProblem } from '../../core/protocol/parameters';
import { declaredStep, Dial, LEDGER_DIAL_ITEM, Row, Scrub } from '../controls';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

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
 * A declared number is a `Scrub` — dragged, or tapped for the keyboard — and
 * labels that share a first word become one row (`folio.html#choosing`).
 *
 * The label is the row's label, in the label column, so a declared control is
 * indistinguishable in shape from `Engine` or `Length`. It used to be an
 * eyebrow stacked over its control, which made every declared knob two rows
 * tall and the declared block the loudest thing under the caption.
 */
export function ModelParams({ declared, values, disabled, onChange }: Props) {
  if (declared.length === 0) return null;
  return (
    <>
      {groupDeclared(declared).map(group =>
        group.members.length === 1 ? (
          <Row
            key={group.members[0].key}
            label={group.members[0].label}
            control
          >
            <Declared
              disabled={disabled}
              onChange={onChange}
              parameter={group.members[0]}
              value={values[group.members[0].key]}
            />
          </Row>
        ) : (
          // Declared labels that share a first word are one row: the word is
          // the label, and the rest of each name sits beside its control.
          <Row key={group.word} label={group.word} control>
            {group.members.map(parameter => (
              <GroupedDeclared
                key={parameter.key}
                disabled={disabled}
                name={restOf(parameter.label)}
                onChange={onChange}
                parameter={parameter}
                value={values[parameter.key]}
              />
            ))}
          </Row>
        ),
      )}
    </>
  );
}

/** Declared parameters, grouped by a shared first word, in declared order. */
export type DeclaredGroup = Readonly<{
  word: string;
  members: readonly ModelParameter[];
}>;

/**
 * Group declared parameters whose labels share a first word (`Lyric
 * temperature`, `Lyric guidance` → `Lyric`). The app cannot shorten another
 * machine's words, but it can stop repeating the one they share. A label with
 * no partner stands alone, and `Row` moves it into the value column if it is
 * still too long. Order is the node's: a group stands where its first member
 * was declared.
 */
export function groupDeclared(
  declared: readonly ModelParameter[],
): DeclaredGroup[] {
  const firstWord = (label: string) => label.trim().split(/\s+/)[0] ?? label;
  const counts = new Map<string, number>();
  for (const parameter of declared) {
    const words = parameter.label.trim().split(/\s+/);
    if (words.length < 2) continue;
    const key = firstWord(parameter.label).toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups: { word: string; members: ModelParameter[] }[] = [];
  const byWord = new Map<string, { word: string; members: ModelParameter[] }>();
  for (const parameter of declared) {
    const key = firstWord(parameter.label).toLocaleLowerCase();
    const shared =
      (counts.get(key) ?? 0) >= 2 &&
      parameter.label.trim().split(/\s+/).length >= 2;
    if (!shared) {
      groups.push({ word: parameter.label, members: [parameter] });
      continue;
    }
    const existing = byWord.get(key);
    if (existing !== undefined) existing.members.push(parameter);
    else {
      const group = { word: firstWord(parameter.label), members: [parameter] };
      byWord.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

/** A label without its first word: `Lyric temperature` → `temperature`. */
function restOf(label: string): string {
  return label.trim().split(/\s+/).slice(1).join(' ');
}

/** One member of a grouped row: its name, and its control beside it. */
function GroupedDeclared({
  disabled,
  name,
  onChange,
  parameter,
  value,
}: {
  disabled: boolean;
  name: string;
  onChange: (key: string, value: ParameterValue) => void;
  parameter: ModelParameter;
  value: ParameterValue | undefined;
}) {
  const pal = usePalette();
  return (
    <View style={styles.member}>
      <Text numberOfLines={1} style={[styles.memberName, { color: pal.muted }]}>
        {name}
      </Text>
      <Declared
        disabled={disabled}
        onChange={onChange}
        parameter={parameter}
        value={value}
      />
    </View>
  );
}

/** The control a declared parameter takes, by its kind. */
function Declared({
  disabled,
  onChange,
  parameter,
  value: given,
}: {
  disabled: boolean;
  onChange: (key: string, value: ParameterValue) => void;
  parameter: ModelParameter;
  value: ParameterValue | undefined;
}) {
  const pal = usePalette();
  const value = given ?? parameter.default;
  const problem = parameterProblem(parameter, value);
  return (
    <View>
      {parameter.kind === 'boolean' ? (
        <Dial
          compact
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
          compact
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
      ) : parameter.kind === 'text' ? (
        <TextInput
          accessibilityLabel={parameter.label}
          editable={!disabled}
          inputMode="text"
          onChangeText={next => onChange(parameter.key, next)}
          style={[styles.input, type.body, { color: pal.ink }]}
          value={String(value)}
        />
      ) : (
        // A declared number is dragged, and a tap still types it exactly.
        <Scrub
          accessibilityLabel={parameter.label}
          disabled={disabled}
          maximum={parameter.maximum}
          minimum={parameter.minimum}
          onChange={next => onChange(parameter.key, next)}
          step={declaredStep(
            parameter.kind,
            parameter.minimum,
            parameter.maximum,
            parameter.step,
          )}
          value={typeof value === 'number' ? value : Number(value)}
        />
      )}
      {problem !== null ? (
        <Text style={[styles.problem, { color: pal.ink }]}>{problem}</Text>
      ) : null}
    </View>
  );
}

/** The two positions of a declared switch, in the order a switch reads. */
const SWITCH = ['off', 'on'] as const;

/** Wide enough for a number or a short word, and for a finger. */
const FIELD_WIDTH_PX = 120;

const styles = StyleSheet.create({
  /** A dial word, at the size every dial in a ledger row is set in. */
  word: { fontFamily: font.mono, fontSize: 12, letterSpacing: 0.4 },
  input: {
    alignSelf: 'flex-start',
    minHeight: touch.min,
    includeFontPadding: false,
    minWidth: FIELD_WIDTH_PX,
    padding: 0,
    textAlignVertical: 'center',
  },
  problem: { ...type.small, marginTop: space.xs },
  /** A grouped member: its name on the left, its control on the right. */
  member: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.md,
  },
  memberName: { flexShrink: 1, fontFamily: font.text, fontSize: 14 },
});
