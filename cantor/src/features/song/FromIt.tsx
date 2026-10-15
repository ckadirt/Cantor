import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatInstallBytes,
  installCommand,
  type ActDoor,
} from '../../core/audioActs';
import { modelLabel } from '../../field/arrangements/byRecord';
import { Fermata, LEDGER_NOTE_STYLE, Row, RowAct } from '../controls';
import { font, space, type, usePalette } from '../../theme/tokens';

/** The two acts the front page offers from a song, and what each needs. */
export type SongAudioActs = Readonly<{
  version: ActDoor;
  longer: ActDoor;
  /** The node's name, for `NOT ON AGENTBOX YET` and `AGENTBOX IS AWAY`. */
  nodeLabel: string;
  onAct: (act: 'version' | 'longer') => void;
}>;

/** Wraps a value so it can be copied: the sheet's own `Copy` mark. */
export type CopyWrap = (
  value: string,
  what: string,
  children: React.ReactNode,
) => React.ReactNode;

/** Knobs: the install command's drawing, in px. */
export const FROM_IT_KNOBS = {
  /** The hairline to the left of the command, in place of a filled box. */
  COMMAND_RULE_PX: 1,
  /** From the hairline to the command's first letter. */
  COMMAND_INSET_PX: 10,
  /** The command's mono size; it wraps rather than clips. */
  COMMAND_SIZE_PX: 12,
  COMMAND_LINE_PX: 18,
} as const;

type Act = 'version' | 'longer';
type Shut = Extract<ActDoor, { kind: 'no-model' }>;

const PROMISE: Readonly<Record<Act, string>> = {
  version: 'THE SAME SONG, CHANGED',
  longer: 'MORE OF IT, AT THE END OR THE START',
};

const LABEL: Readonly<Record<Act, string>> = {
  version: 'A version',
  longer: 'Longer',
};

const ACTS: readonly Act[] = ['version', 'longer'];

/**
 * `From it`: making a new song out of this one.
 *
 * An act this node can do is a door with its promise; one whose node is away
 * holds on the fermata. Acts no model there can do share one soft-grey door,
 * `NOT ON AGENTBOX YET`, since they are shut for one reason; pressing it opens
 * the command that would open them, once per distinct command, and nothing
 * more. Nothing is installed from the phone. A node that predates audio offers
 * neither act and the row is not drawn.
 */
export function FromIt({
  acts,
  copy = (_value, _what, children) => children,
  disabled,
}: {
  acts: SongAudioActs;
  copy?: CopyWrap;
  disabled: boolean;
}) {
  const open = ACTS.filter(
    act => acts[act].kind === 'ready' || acts[act].kind === 'away',
  );
  const shut = ACTS.filter(act => acts[act].kind === 'no-model');
  if (open.length === 0 && shut.length === 0) return null;
  return (
    <>
      {open.map((act, index) => (
        <Row control key={act} label={index === 0 ? 'From it' : undefined}>
          <OpenDoor
            act={act}
            disabled={disabled}
            door={acts[act]}
            nodeLabel={acts.nodeLabel}
            onAct={() => acts.onAct(act)}
          />
        </Row>
      ))}
      {shut.length > 0 ? (
        <Row control label={open.length === 0 ? 'From it' : undefined}>
          <ShutDoor
            acts={shut.map(act => [act, acts[act] as Shut] as const)}
            copy={copy}
            nodeLabel={acts.nodeLabel}
          />
        </Row>
      ) : null}
    </>
  );
}

function OpenDoor({
  act,
  disabled,
  door,
  nodeLabel,
  onAct,
}: {
  act: Act;
  disabled: boolean;
  door: ActDoor;
  nodeLabel: string;
  onAct: () => void;
}) {
  const pal = usePalette();
  if (door.kind === 'ready') {
    return (
      <View>
        <RowAct disabled={disabled} label={LABEL[act]} onPress={onAct} />
        <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
          {PROMISE[act]}
        </Text>
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={`${LABEL[act]}: ${nodeLabel} is away, the song lives there`}
    >
      <View style={styles.held}>
        <Fermata colour={pal.faint} />
        <Text style={[type.body, { color: pal.faint }]}>{LABEL[act]}</Text>
      </View>
      <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
        {`${nodeLabel.toUpperCase()} IS AWAY · THE SONG LIVES THERE`}
      </Text>
    </View>
  );
}

/** One command, and what it installs or finds. */
type Hint = Readonly<{ command: string; note: string }>;

function hintsFor(acts: readonly (readonly [Act, Shut])[]): Hint[] {
  const hints = new Map<string, string>();
  for (const [act, door] of acts) {
    const command = installCommand(door, act);
    if (hints.has(command)) continue;
    hints.set(
      command,
      door.suggestion
        ? `${modelLabel(door.suggestion.selector)} · ${formatInstallBytes(
            door.suggestion.bytes,
          )}`.toUpperCase()
        : 'LISTS WHAT COULD',
    );
  }
  return [...hints].map(([command, note]) => ({ command, note }));
}

function ShutDoor({
  acts,
  copy,
  nodeLabel,
}: {
  acts: readonly (readonly [Act, Shut])[];
  copy: CopyWrap;
  nodeLabel: string;
}) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const label = acts.map(([act]) => LABEL[act]).join(' · ');
  return (
    <View>
      <Pressable
        accessibilityHint="Shows what to run on the node"
        accessibilityLabel={`${label}: not on ${nodeLabel} yet`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(current => !current)}
      >
        <Text style={[type.body, { color: pal.faint }]}>{label}</Text>
        <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
          {`NOT ON ${nodeLabel.toUpperCase()} YET`}
        </Text>
      </Pressable>
      {open
        ? hintsFor(acts).map(hint => (
            <View key={hint.command} style={styles.hint}>
              {copy(
                hint.command,
                'command',
                <View style={[styles.command, { borderColor: pal.faint }]}>
                  <Text
                    accessibilityLabel={`Command: ${hint.command}`}
                    selectable
                    style={[styles.commandWord, { color: pal.ink }]}
                  >
                    {hint.command}
                  </Text>
                </View>,
              )}
              <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
                {hint.note}
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  held: { alignItems: 'center', flexDirection: 'row', gap: space.xs },
  hint: { gap: space.xs, paddingTop: space.sm },
  command: {
    borderLeftWidth: FROM_IT_KNOBS.COMMAND_RULE_PX,
    paddingLeft: FROM_IT_KNOBS.COMMAND_INSET_PX,
  },
  commandWord: {
    fontFamily: font.mono,
    fontSize: FROM_IT_KNOBS.COMMAND_SIZE_PX,
    lineHeight: FROM_IT_KNOBS.COMMAND_LINE_PX,
  },
});
