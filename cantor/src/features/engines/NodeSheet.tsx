import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ModelView } from '../../../../protocol/ModelView';
import type { BackendRecord, ConnectionSnapshot } from '../../backends/types';
import { lyricsContractFor } from '../../core/protocol/lyrics';
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
import { font, space, touch, type, usePalette } from '../../theme/tokens';
import type { BackendFootprint } from './EnginesSheet';
import {
  nodeState,
  songsInTheMaking,
  variantLabel,
  type KnownModel,
} from './nodeState';

/** KNOBS — one model variant's line inside its family. */
const NODE_SHEET_KNOBS = {
  /** A variant line: tighter than a row, since a family holds several. */
  VARIANT_PX: 32,
  VARIANT_SIZE_PX: 12,
} as const;

/**
 * One node, one level into the nodes panel (`folio.html` frame `f-node`): what
 * it holds, what it is doing, and the models it has — with the ones another
 * paired node has and this one lacks in grey, saying where they are. The head
 * (its name, its state) belongs to the sheet this page opens inside.
 *
 * This is where `ModelsSheet` went: a node's models were always a page about
 * that node.
 */
export function NodeSheet({
  backend,
  snapshot,
  footprint,
  known,
  nameOf,
  onForget,
}: {
  backend: BackendRecord | undefined;
  snapshot: ConnectionSnapshot | undefined;
  footprint: BackendFootprint | undefined;
  known: ReadonlyMap<string, KnownModel>;
  /** A paired node's name, from its public key. */
  nameOf: (nodePublicKey: string) => string;
  onForget: () => void;
}) {
  const pal = usePalette();
  const [expanded, setExpanded] = useState<string | null>(null);
  const installed = backend?.lastNodeInfo?.models;
  const families = useMemo(() => {
    const models = new Map<string, ModelView>();
    for (const [selector, entry] of known) models.set(selector, entry.model);
    // This node's declaration wins over another node's version of the model.
    for (const model of installed ?? []) models.set(model.selector, model);
    const groups = new Map<string, ModelView[]>();
    for (const model of [...models.values()].sort((a, b) =>
      a.selector.localeCompare(b.selector),
    )) {
      const group = groups.get(model.family) ?? [];
      group.push(model);
      groups.set(model.family, group);
    }
    return [...groups.entries()];
  }, [installed, known]);

  if (backend === undefined)
    return (
      <>
        <Stave>
          <Measure>
            <Row>
              <Text style={[type.body, { color: pal.muted }]}>
                This node is no longer paired.
              </Text>
            </Row>
          </Measure>
        </Stave>
        <Coda />
      </>
    );

  const name = nameOf(backend.nodePubkey);
  const making = songsInTheMaking(snapshot);
  const state = nodeState(snapshot);
  const songs = footprint?.songs ?? 0;
  const kept = footprint?.downloaded ?? 0;
  const cached = footprint?.borrowed ?? 0;
  const here = (model: ModelView) =>
    installed?.some(entry => entry.selector === model.selector) ?? false;

  return (
    <>
      <Stave keyboardShouldPersistTaps="handled">
        <Measure>
          <Row
            label="Songs"
            note={
              footprint === undefined
                ? 'NOT SYNCED YET'
                : `${kept} KEPT HERE · ${cached} CACHED`
            }
          >
            <Text style={[type.body, { color: pal.ink }]}>{songs}</Text>
          </Row>
          <Row label="Playlists">
            <Text style={[type.body, { color: pal.ink }]}>
              {footprint?.playlists ?? 0}
            </Text>
          </Row>
          <Row label="Now">
            <Text
              style={[
                type.body,
                { color: state === 'offline' ? pal.faint : pal.ink },
              ]}
            >
              {state === 'offline'
                ? 'out of reach'
                : state === 'connecting'
                ? 'connecting'
                : making === 0
                ? 'idle'
                : making === 1
                ? 'making a song'
                : `making ${making} songs`}
            </Text>
          </Row>
          {snapshot?.error ? (
            <Row label="Why">
              <Text
                accessibilityRole="alert"
                style={[type.small, { color: pal.ink }]}
              >
                {snapshot.error}
              </Text>
            </Row>
          ) : null}
        </Measure>
        <Rest />
        <Measure>
          {families.length === 0 ? (
            <Row>
              <Text style={[type.body, { color: pal.muted }]}>
                No models reported yet.
              </Text>
            </Row>
          ) : null}
          {families.map(([family, models]) => {
            const ours = models.find(here) ?? models[0];
            return (
              <Row key={family} label={family} note={familyNote(ours)}>
                {models.map(model => {
                  const isHere = here(model);
                  const open = expanded === model.selector;
                  const elsewhere = (
                    known.get(model.selector)?.on ?? []
                  ).filter(key => key !== backend.nodePubkey);
                  return (
                    <View key={model.selector}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Model ${model.selector}`}
                        accessibilityState={{ expanded: open }}
                        onPress={() =>
                          setExpanded(open ? null : model.selector)
                        }
                        style={styles.variant}
                      >
                        <Text
                          style={[
                            styles.variantWord,
                            isHere
                              ? { color: pal.ink }
                              : [styles.missing, { color: pal.faint }],
                          ]}
                        >
                          {variantLabel(model)}
                        </Text>
                        <Text
                          style={[
                            LEDGER_NOTE_STYLE,
                            { color: isHere ? pal.ink : pal.faint },
                          ]}
                        >
                          {isHere
                            ? 'HERE'
                            : installed === undefined
                            ? 'UNKNOWN HERE'
                            : elsewhere.length > 0
                            ? `ON ${nameOf(elsewhere[0]).toUpperCase()}`
                            : 'ELSEWHERE'}
                        </Text>
                      </Pressable>
                      {open && isHere ? (
                        <View style={styles.detail}>
                          <Text style={[type.small, { color: pal.muted }]}>
                            {model.stages?.length
                              ? `${
                                  model.stages.length
                                } stages: ${model.stages.join(' → ')}`
                              : 'Stages not declared'}
                          </Text>
                          {model.parameters?.length ? (
                            <Text style={[type.small, { color: pal.muted }]}>
                              Controls:{' '}
                              {model.parameters
                                .map(parameter => parameter.label)
                                .join(', ')}
                            </Text>
                          ) : null}
                        </View>
                      ) : null}
                      {open && !isHere ? (
                        <View style={styles.detail}>
                          <View
                            style={[
                              styles.command,
                              { backgroundColor: pal.line },
                            ]}
                          >
                            <Text
                              selectable
                              accessibilityLabel={`Install ${model.selector}`}
                              style={[styles.commandWord, { color: pal.ink }]}
                            >
                              {`cantor pull ${model.selector}`}
                            </Text>
                          </View>
                          <Text style={[type.small, { color: pal.muted }]}>
                            Run it on {name}. The node checks availability and
                            requirements.
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </Row>
            );
          })}
        </Measure>
      </Stave>
      <Coda>
        {/*
          The one act on this page, and a destructive one: muted until it is
          held. F7 turns it into a strike; until then it opens the page that
          counts what goes.
        */}
        <PanelPressable
          accessibilityLabel={`Forget ${name}`}
          accessibilityRole="button"
          onPress={onForget}
          style={styles.act}
        >
          <Text style={[FOLIO_ACT_STYLE, { color: pal.muted }]}>
            Forget this node
          </Text>
        </PanelPressable>
        <Text style={[FOLIO_NOTE_STYLE, { color: pal.faint }]}>
          {`${songs - kept} LEAVE · ${kept} KEPT STAY`}
        </Text>
      </Coda>
    </>
  );
}

/** `4 STAGES · WRITES WORDS`: what the family's model here can do. */
function familyNote(model: ModelView | undefined): string | undefined {
  if (model === undefined) return undefined;
  const parts: string[] = [];
  if (model.stages?.length) parts.push(`${model.stages.length} stages`);
  parts.push(
    lyricsContractFor(model).writerLabel === null
      ? 'your own words'
      : 'writes words',
  );
  return parts.join(' · ');
}

const styles = StyleSheet.create({
  variant: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: NODE_SHEET_KNOBS.VARIANT_PX,
  },
  variantWord: {
    fontFamily: font.mono,
    fontSize: NODE_SHEET_KNOBS.VARIANT_SIZE_PX,
    letterSpacing: 0.4,
  },
  /** A model this node lacks: underlined with dots, as a thing to fetch. */
  missing: { textDecorationLine: 'underline', textDecorationStyle: 'dotted' },
  detail: { gap: space.xs, paddingBottom: space.sm },
  command: { paddingHorizontal: space.sm, paddingVertical: 6 },
  commandWord: { fontFamily: font.mono, fontSize: 11.5 },
  act: { justifyContent: 'center', minHeight: touch.min },
});
