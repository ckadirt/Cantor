import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  Coda,
  FOLIO_ACT_STYLE,
  FOLIO_NOTE_STYLE,
  LEDGER_NOTE_STYLE,
  Measure,
  PanelPressable,
  Rest,
  Row,
  Stave,
} from '../controls';
import {
  diagnosticsReport,
  redact,
  type Failure,
} from '../../runtime/diagnostics';
import { font, space, touch, type, usePalette } from '../../theme/tokens';

/**
 * Settings · Diagnostics (`folio.html` frame `f-diag`): the last twenty
 * failures, newest first, grouped by day. Each has its time in the label
 * column, the sentence the interface showed, and its code and node in mono; a
 * tap opens the raw message, which is shown nowhere else. `Copy all` copies
 * them for a bug report with anything key-like taken out.
 */
export function DiagnosticsSheet({
  failures,
}: {
  failures: readonly Failure[];
}) {
  const pal = usePalette();
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const days = useMemo(() => byDay(failures), [failures]);
  return (
    <>
      <Stave>
        {failures.length === 0 ? (
          <Measure>
            <Row>
              <Text style={[type.body, { color: pal.muted }]}>
                Nothing has gone wrong yet.
              </Text>
            </Row>
          </Measure>
        ) : null}
        {days.map(([day, entries], dayIndex) => (
          <React.Fragment key={day}>
            {dayIndex === 0 ? null : <Rest />}
            <Measure>
              <Row>
                <Text style={[styles.day, { color: pal.ink }]}>{day}</Text>
              </Row>
              {entries.map(failure => {
                const shown = open === failure.atMs;
                return (
                  <Row key={failure.atMs} label={clockOf(failure.atMs)}>
                    <Pressable
                      accessibilityLabel={`${failure.sentence} ${
                        shown ? 'Hide' : 'Show'
                      } what the node said`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: shown }}
                      onPress={() => setOpen(shown ? null : failure.atMs)}
                    >
                      <Text style={[type.body, { color: pal.ink }]}>
                        {failure.sentence}
                      </Text>
                      <Text style={[LEDGER_NOTE_STYLE, { color: pal.faint }]}>
                        {`${failure.code} · ${failure.node}`.toUpperCase()}
                      </Text>
                      {shown ? (
                        <View
                          style={[styles.raw, { backgroundColor: pal.line }]}
                        >
                          <Text
                            selectable
                            style={[styles.rawWord, { color: pal.muted }]}
                          >
                            {redact(failure.raw)}
                          </Text>
                        </View>
                      ) : null}
                    </Pressable>
                  </Row>
                );
              })}
            </Measure>
          </React.Fragment>
        ))}
      </Stave>
      <Coda>
        <PanelPressable
          accessibilityLabel="Copy all"
          accessibilityRole="button"
          onPress={() => {
            Clipboard.setString(diagnosticsReport(failures));
            setCopied(true);
          }}
          style={styles.act}
        >
          <Text style={[FOLIO_ACT_STYLE, { color: pal.ink }]}>
            {copied ? 'Copied' : 'Copy all'}
          </Text>
        </PanelPressable>
        <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
          NO KEYS, NO WORDS
        </Text>
      </Coda>
    </>
  );
}

/** `Today`, `Yesterday`, or the date, newest day first. */
function byDay(failures: readonly Failure[]): [string, Failure[]][] {
  const groups = new Map<string, Failure[]>();
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  for (const failure of failures) {
    const at = new Date(failure.atMs);
    const day = same(at, today)
      ? 'Today'
      : same(at, yesterday)
      ? 'Yesterday'
      : at.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    const group = groups.get(day) ?? [];
    group.push(failure);
    groups.set(day, group);
  }
  return [...groups.entries()];
}

function clockOf(atMs: number): string {
  const at = new Date(atMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(
    at.getMinutes(),
  ).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  day: { fontFamily: font.display, fontSize: 20, lineHeight: 24 },
  raw: { marginTop: space.xs, paddingHorizontal: space.sm, paddingVertical: 6 },
  rawWord: { fontFamily: font.mono, fontSize: 10.5, lineHeight: 15 },
  act: { justifyContent: 'center', minHeight: touch.min },
});
