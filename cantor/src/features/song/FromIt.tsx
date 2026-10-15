import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ACT_WORDS,
  formatInstallBytes,
  installCommand,
  type ActDoor,
  type AudioActName,
} from '../../core/audioActs';
import { Fermata, LEDGER_NOTE_STYLE, Row, RowAct } from '../controls';
import { font, space, type, usePalette } from '../../theme/tokens';

/** The two acts the front page offers from a song, and what each needs. */
export type SongAudioActs = Readonly<{
  version: ActDoor;
  longer: ActDoor;
  /** The node's name, for `NO MODEL ON AGENTBOX …` and `AGENTBOX IS AWAY`. */
  nodeLabel: string;
  onAct: (act: 'version' | 'longer') => void;
}>;

const PROMISE: Readonly<Record<'version' | 'longer', string>> = {
  version: 'THE SAME SONG, CHANGED',
  longer: 'MORE OF IT, AT THE END OR THE START',
};

const LABEL: Readonly<Record<'version' | 'longer', string>> = {
  version: 'A version',
  longer: 'Longer',
};

/**
 * `From it`: making a new song out of this one.
 *
 * Each act's door says what it can: ready, the node is away (the fermata,
 * waiting), or no model there can do it, in which case pressing it opens, in
 * place, the model that would and the command that installs it. Nothing is
 * installed from the phone. A node that predates audio offers neither act and
 * the row is not drawn.
 */
export function FromIt({
  acts,
  disabled,
}: {
  acts: SongAudioActs;
  disabled: boolean;
}) {
  const shown = (['version', 'longer'] as const).filter(
    act => acts[act].kind !== 'unsupported',
  );
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((act, index) => (
        <Row control key={act} label={index === 0 ? 'From it' : undefined}>
          <ActDoorView
            act={act}
            disabled={disabled}
            door={acts[act]}
            nodeLabel={acts.nodeLabel}
            onAct={() => acts.onAct(act)}
          />
        </Row>
      ))}
    </>
  );
}

function ActDoorView({
  act,
  disabled,
  door,
  nodeLabel,
  onAct,
}: {
  act: 'version' | 'longer';
  disabled: boolean;
  door: ActDoor;
  nodeLabel: string;
  onAct: () => void;
}) {
  const pal = usePalette();
  const [open, setOpen] = useState(false);
  const node = nodeLabel.toUpperCase();
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
  if (door.kind === 'away') {
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
          {`${node} IS AWAY · THE SONG LIVES THERE`}
        </Text>
      </View>
    );
  }
  if (door.kind !== 'no-model') return null;
  const why = `NO MODEL ON ${node} ${ACT_WORDS[act as AudioActName]}`;
  return (
    <View>
      <Pressable
        accessibilityHint="Shows which model would do it"
        accessibilityLabel={`${LABEL[act]}: no model on ${nodeLabel} can do this`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(current => !current)}
      >
        <Text style={[type.body, { color: pal.faint }]}>{LABEL[act]}</Text>
        <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>{why}</Text>
      </Pressable>
      {open ? (
        <View style={styles.hint}>
          {door.suggestion ? (
            <>
              <Text style={[type.body, { color: pal.ink }]}>
                {`${door.suggestion.selector} can`}
              </Text>
              <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
                {[
                  ...door.suggestion.capabilities,
                  formatInstallBytes(door.suggestion.bytes),
                ]
                  .join(' · ')
                  .toUpperCase()}
              </Text>
            </>
          ) : null}
          <View style={[styles.command, { backgroundColor: pal.line }]}>
            <Text
              accessibilityLabel={`Command: ${installCommand(door, act)}`}
              numberOfLines={1}
              selectable
              style={[styles.commandWord, { color: pal.ink }]}
            >
              {installCommand(door, act)}
            </Text>
          </View>
          <Text style={[type.small, { color: pal.muted }]}>
            {door.suggestion
              ? `Run it on ${nodeLabel}. Then this is a ${
                  act === 'version' ? 'version' : 'longer song'
                } away.`
              : `Run it on ${nodeLabel} to see what can.`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  held: { alignItems: 'center', flexDirection: 'row', gap: space.xs },
  hint: { gap: space.xs, paddingBottom: space.sm, paddingTop: space.xs },
  command: { paddingHorizontal: space.sm, paddingVertical: 6 },
  commandWord: { fontFamily: font.mono, fontSize: 11.5 },
});
