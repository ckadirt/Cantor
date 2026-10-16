import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  formatInstallBytes,
  installCommand,
  type ActDoor,
  type ActId,
  type ActWords,
} from '../../core/audioActs';
import { modelLabel } from '../../field/arrangements/byRecord';
import { Fermata, LEDGER_NOTE_STYLE, Row, RowAct } from '../controls';
import { font, space, type, usePalette } from '../../theme/tokens';

/** One act the front page offers from a song: its words and its door. */
export type FromItAct = Readonly<{ id: ActId; words: ActWords; door: ActDoor }>;

/** The acts the front page offers from a song, and what each needs. */
export type SongAudioActs = Readonly<{
  /** In the order offered (`actsFor`): the built-in ones, then the rest. */
  acts: readonly FromItAct[];
  /** The node's name, for `NOT ON AGENTBOX YET` and `AGENTBOX IS AWAY`. */
  nodeLabel: string;
  /**
   * Where the song lives: on its node, which must be here to make anything
   * of it, or on this phone, which can send it to whichever node comes back.
   */
  lives: 'node' | 'phone';
  onAct: (act: ActId) => void;
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

type Shut = Extract<ActDoor, { kind: 'no-model' }>;

/**
 * `From it`: making a new song out of this one.
 *
 * An act this node can do is a door with its promise; one whose node is away
 * holds on the fermata. Acts no model there can do share one soft-grey door,
 * `NOT ON AGENTBOX YET`, since they are shut for one reason; pressing it opens
 * the command that would open them, once per distinct command, and nothing
 * more. Nothing is installed from the phone. A node that predates audio offers
 * no act and the row is not drawn. The acts are whatever the sheet is given
 * (`actsFor`): a new one is a new door, in its catalog words.
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
  const open = acts.acts.filter(
    act => act.door.kind === 'ready' || act.door.kind === 'away',
  );
  const shut = acts.acts.filter(
    (act): act is FromItAct & { door: Shut } => act.door.kind === 'no-model',
  );
  if (open.length === 0 && shut.length === 0) return null;
  return (
    <>
      {open.map((act, index) => (
        <Row control key={act.id} label={index === 0 ? 'From it' : undefined}>
          <OpenDoor
            words={act.words}
            disabled={disabled}
            door={act.door}
            nodeLabel={acts.nodeLabel}
            lives={acts.lives}
            onAct={() => acts.onAct(act.id)}
          />
        </Row>
      ))}
      {shut.length > 0 ? (
        <Row control label={open.length === 0 ? 'From it' : undefined}>
          <ShutDoor acts={shut} copy={copy} nodeLabel={acts.nodeLabel} />
        </Row>
      ) : null}
    </>
  );
}

function OpenDoor({
  words,
  disabled,
  door,
  nodeLabel,
  lives,
  onAct,
}: {
  words: ActWords;
  disabled: boolean;
  door: ActDoor;
  nodeLabel: string;
  lives: SongAudioActs['lives'];
  onAct: () => void;
}) {
  const pal = usePalette();
  if (door.kind === 'ready') {
    return (
      <View>
        <RowAct disabled={disabled} label={words.label} onPress={onAct} />
        {words.promise !== '' ? (
          <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
            {words.promise}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View
      accessible
      accessibilityLabel={
        lives === 'phone'
          ? `${words.label}: waiting for a node`
          : `${words.label}: ${nodeLabel} is away, the song lives there`
      }
    >
      <View style={styles.held}>
        <Fermata colour={pal.faint} />
        <Text style={[type.body, { color: pal.faint }]}>{words.label}</Text>
      </View>
      <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
        {lives === 'phone'
          ? 'WAITING FOR A NODE'
          : `${nodeLabel.toUpperCase()} IS AWAY · THE SONG LIVES THERE`}
      </Text>
    </View>
  );
}

/** One command, and what it installs or finds. */
type Hint = Readonly<{ command: string; note: string }>;

function hintsFor(acts: readonly (FromItAct & { door: Shut })[]): Hint[] {
  const hints = new Map<string, string>();
  for (const { id, door } of acts) {
    const command = installCommand(door, id);
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
  acts: readonly (FromItAct & { door: Shut })[];
  copy: CopyWrap;
  nodeLabel: string;
}) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const label = acts.map(act => act.words.label).join(' · ');
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
