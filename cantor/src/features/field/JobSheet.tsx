import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Canvas } from '@shopify/react-native-skia';
import type { GenerationStage } from '../../../../protocol/GenerationStage';
import { SymbolArtworkPath } from '../../motion/CanonicalSymbol';
import { STAGE_SYMBOLS, jobMarkModel } from '../../jobs/marks';
import { jobControls, jobStateLabel, type JobControl } from '../../jobs/policy';
import { space, touch, type, usePalette } from '../../theme/tokens';
import type { JobPresentation } from './useFieldController';

/** KNOBS — the stage list, which is the arc unrolled into a column. */
const JOB_SHEET_KNOBS = {
  STAGE_GLYPH_PX: 20,
  STAGE_ROW_HEIGHT_PX: 30,
  /** The bar under the stage being worked on: one hairline over another. */
  BAR_HEIGHT_PX: 1,
} as const;

type Props = {
  pending: JobPresentation | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onControl: (control: JobControl) => void;
};

/**
 * One generation, in detail: what it is doing, what it will do next, and the
 * three things you can do about it.
 *
 * `controlJob` has supported pause, resume, cancel and retry since M4 and
 * nothing surfaced them. The stage list is the mark's own arc unrolled into a
 * column — the same declared mask, so a shorter pipeline is a shorter list
 * rather than four rows with two greyed out.
 */
export function JobSheet({ pending, busy, error, onClose, onControl }: Props) {
  const pal = usePalette();
  if (pending === null) return null;

  const model = jobMarkModel(pending.job, [], pending.declaredStages);
  const controls = jobControls(pending.job);
  const stages =
    model.declaredStages.length > 0
      ? model.declaredStages
      : model.observedStages;
  const failure = pending.job.error;

  return (
    <Modal
      transparent
      animationType="slide"
      visible
      onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View
          style={[styles.sheet, { backgroundColor: pal.bg, borderColor: pal.line }]}>
          <View style={styles.header}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>
              {model.failed ? 'IT STOPPED' : 'GENERATING'}
            </Text>
            <Pressable
              accessibilityLabel="Close job"
              accessibilityRole="button"
              hitSlop={space.md}
              onPress={onClose}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            {/* The words that were typed are never lost, least of all here. */}
            <Text style={[type.title, styles.caption, { color: pal.ink }]}>
              {pending.caption ?? jobStateLabel(pending.job)}
            </Text>

            <View style={[styles.rule, { backgroundColor: pal.line }]} />

            {stages.map((stage, index) => (
              <Stage
                key={stage}
                stage={stage}
                state={
                  model.stageIndex < 0
                    ? 'next'
                    : index < model.stageIndex
                      ? 'done'
                      : index === model.stageIndex
                        ? 'now'
                        : 'next'
                }
                progress={
                  index === model.stageIndex &&
                  model.progress.kind === 'determinate'
                    ? model.progress
                    : null
                }
              />
            ))}

            {failure ? (
              <>
                <View style={[styles.rule, { backgroundColor: pal.ink }]} />
                <Text style={[type.body, { color: pal.ink }]}>
                  {/* The node's own words. The app does not paraphrase a failure. */}
                  {failure.message}
                </Text>
                <Text style={[type.eyebrow, { color: pal.faint }]}>
                  THE CAPTION IS KEPT
                </Text>
              </>
            ) : null}

            {error !== null ? (
              <Text style={[type.mono, { color: pal.ink }]}>{error}</Text>
            ) : null}

            <View style={[styles.rule, { backgroundColor: pal.ink }]} />
            <View style={styles.controls}>
              {controls.length === 0 ? (
                <Text style={[type.eyebrow, { color: pal.faint }]}>
                  NOTHING TO DO BUT WAIT
                </Text>
              ) : (
                controls.map(control => (
                  <Pressable
                    accessibilityLabel={CONTROL_WORDS[control]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    hitSlop={space.sm}
                    key={control}
                    onPress={() => onControl(control)}>
                    <Text
                      style={[
                        type.eyebrow,
                        { color: busy ? pal.faint : pal.ink },
                      ]}>
                      {CONTROL_WORDS[control].toUpperCase()}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
            <Text style={[type.eyebrow, { color: pal.faint }]}>
              {`${(pending.nodeLabels[0] ?? pending.backend.petname).toUpperCase()} · ${pending.job.model.toUpperCase()}`}
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** The verb, as a person would say it rather than as the wire spells it. */
const CONTROL_WORDS: Record<JobControl, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  retry: 'Try again',
};

function Stage({
  stage,
  state,
  progress,
}: {
  stage: GenerationStage;
  state: 'done' | 'now' | 'next';
  progress: { fraction: number; completed: number; total: number } | null;
}) {
  const pal = usePalette();
  const colour =
    state === 'now' ? pal.ink : state === 'done' ? pal.muted : pal.faint;
  return (
    <View style={styles.stage}>
      <Canvas style={styles.stageGlyph}>
        <SymbolArtworkPath
          centerX={JOB_SHEET_KNOBS.STAGE_GLYPH_PX / 2}
          centerY={JOB_SHEET_KNOBS.STAGE_ROW_HEIGHT_PX / 2}
          color={colour}
          size={JOB_SHEET_KNOBS.STAGE_GLYPH_PX}
          symbol={STAGE_SYMBOLS[stage]}
        />
      </Canvas>
      <View style={styles.stageBody}>
        <View style={styles.stageLine}>
          <Text style={[type.body, { color: colour }]}>
            {stage[0].toUpperCase()}
            {stage.slice(1)}
          </Text>
          {state === 'done' ? (
            <Text style={[type.eyebrow, { color: pal.faint }]}>DONE</Text>
          ) : null}
        </View>
        {progress === null ? null : (
          <>
            <View style={[styles.bar, { backgroundColor: pal.line }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    backgroundColor: pal.ink,
                    width: `${Math.round(progress.fraction * 100)}%`,
                  },
                ]}
              />
            </View>
            <Text style={[type.eyebrow, { color: pal.faint }]}>
              {progress.completed} / {progress.total}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopWidth: 1, maxHeight: '85%', padding: space.lg },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  body: { gap: space.sm, paddingBottom: space.lg, paddingTop: space.md },
  caption: { fontSize: 20, lineHeight: 29 },
  rule: { height: 1, marginVertical: space.sm },
  stage: { alignItems: 'flex-start', flexDirection: 'row', gap: space.md },
  stageGlyph: {
    height: JOB_SHEET_KNOBS.STAGE_ROW_HEIGHT_PX,
    width: JOB_SHEET_KNOBS.STAGE_GLYPH_PX,
  },
  stageBody: { flex: 1, gap: space.xs, paddingTop: space.xs },
  stageLine: { flexDirection: 'row', justifyContent: 'space-between' },
  bar: { height: JOB_SHEET_KNOBS.BAR_HEIGHT_PX, width: '100%' },
  barFill: { height: JOB_SHEET_KNOBS.BAR_HEIGHT_PX },
  controls: { flexDirection: 'row', gap: space.lg, minHeight: touch.min },
});
