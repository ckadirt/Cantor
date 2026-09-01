import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Canvas } from '@shopify/react-native-skia';
import { SymbolArtworkPath } from '../../motion/CanonicalSymbol';
import { STAGE_SYMBOLS } from '../../jobs/marks';
import { space, touch, type, usePalette } from '../../theme/tokens';
import { ModelParams } from './ModelParams';
import {
  EMPTY_DRAFT,
  canSubmit,
  declaredFor,
  describeProblem,
  modelsFor,
  problemsWith,
  targetOf,
  toGenerationRequest,
  utf8Bytes,
  type ComposerDraft,
  type ComposerTarget,
} from './draft';

/** KNOBS — the composer's type and rhythm, from the alpha design's frames. */
const COMPOSER_KNOBS = {
  /** The caption at rest: the only creative act on the screen, so the largest. */
  CAPTION_SIZE_PX: 25,
  CAPTION_LINE_PX: 36,
  /** The caption once the machine choices are open: still first, no longer loud. */
  CAPTION_OPEN_SIZE_PX: 17,
  CAPTION_OPEN_LINE_PX: 25,
  LYRICS_LINES: 4,
  DURATION_STEP_SECONDS: 15, // coarse enough to tap, fine enough to matter
  /** The declared stage row: the arc this engine will trace, drawn before you commit. */
  STAGE_GLYPH_PX: 19,
  STAGE_GLYPH_GAP_PX: 40,
  STAGE_ROW_HEIGHT_PX: 30,
  /** `Make it`: a serif line, not a button in a box. */
  SUBMIT_SIZE_PX: 19,
} as const;

type Props = {
  targets: readonly ComposerTarget[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (
    nodePublicKey: string,
    modelSelector: string,
    generation: ReturnType<typeof toGenerationRequest>,
  ) => void;
};

/**
 * The composer, which descends from the top at any level.
 *
 * It holds only what a person is typing. Whether that draft can be sent is
 * decided by `draft.ts` against what each node actually advertises, so this
 * component never encodes a limit or an engine name of its own.
 *
 * **The caption is the surface.** Display serif at notebook size with no box
 * around it, because writing the song is the only creative act on the screen;
 * every machine choice collapses into one quiet line beneath it and opens only
 * when asked. The order underneath is dependency order — song, then where it
 * runs, then what runs it, then how long, then whatever that model declares —
 * so a combination the node cannot run is never offered in the first place.
 */
function ComposerSheetImpl({
  targets,
  submitting,
  error,
  onClose,
  onSubmit,
}: Props) {
  const pal = usePalette();
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [open, setOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);

  // Default to the only sensible choice rather than making someone pick it.
  const nodePublicKey =
    draft.nodePublicKey ??
    (targets.length === 1 ? targets[0].nodePublicKey : null);
  const target = targetOf(targets, nodePublicKey);
  // Dependency order in one line: the models on offer are the ones *this* node
  // has. A union across nodes would offer a pairing that cannot exist and then
  // report it as the person's mistake.
  const models = useMemo(() => modelsFor(target), [target]);
  const resolved: ComposerDraft = {
    ...draft,
    nodePublicKey,
    modelSelector:
      draft.modelSelector !== null &&
      models.some(model => model.selector === draft.modelSelector)
        ? draft.modelSelector
        : models.length >= 1
          ? models[0].selector
          : null,
  };

  const declared = declaredFor(targets, resolved);
  const problems = problemsWith(resolved, targets);
  const ready = canSubmit(resolved, targets);
  const captionBytes = utf8Bytes(resolved.caption.trim());
  const captionLimit = target?.limits?.max_caption_bytes ?? null;
  const selected = models.find(
    model => model.selector === resolved.modelSelector,
  );
  const stages = selected?.stages ?? [];

  const update = (patch: Partial<ComposerDraft>) =>
    setDraft(current => ({ ...current, ...resolved, ...patch }));

  return (
    <>
      <View style={styles.header}>
        <Text style={[type.eyebrow, { color: pal.faint }]}>COMPOSE</Text>
        <Pressable
          accessibilityLabel="Close composer"
          accessibilityRole="button"
          hitSlop={space.md}
          onPress={onClose}>
          <Text style={[type.eyebrow, { color: pal.faint }]}>CLOSE</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled">
        {/*
          No box, no label, no counter until it matters: a sheet of paper. The
          size drops when the machine choices open, because then it is context
          rather than the thing being done.
        */}
        <TextInput
          accessibilityLabel="Describe the song"
          editable={!submitting}
          multiline
          onChangeText={caption => update({ caption })}
          placeholder="a slow harbour at dusk, brass held under tape hiss"
          placeholderTextColor={pal.faint}
          style={[
            styles.caption,
            {
              color: open ? pal.muted : pal.ink,
              fontFamily: type.title.fontFamily,
              fontSize: open
                ? COMPOSER_KNOBS.CAPTION_OPEN_SIZE_PX
                : COMPOSER_KNOBS.CAPTION_SIZE_PX,
              lineHeight: open
                ? COMPOSER_KNOBS.CAPTION_OPEN_LINE_PX
                : COMPOSER_KNOBS.CAPTION_LINE_PX,
            },
          ]}
          value={resolved.caption}
        />
        {captionLimit !== null && captionBytes > captionLimit ? (
          <Text style={[type.mono, { color: pal.ink }]}>
            {captionBytes}/{captionLimit}
          </Text>
        ) : null}

        {/* Lyrics are a quiet line, not an empty box demanding to be filled. */}
        {lyricsOpen ? (
          <TextInput
            accessibilityLabel="Lyrics"
            editable={!submitting}
            multiline
            numberOfLines={COMPOSER_KNOBS.LYRICS_LINES}
            onChangeText={lyrics => update({ lyrics })}
            placeholder="leave empty for an instrumental"
            placeholderTextColor={pal.faint}
            style={[styles.lyrics, type.body, { color: pal.ink }]}
            value={resolved.lyrics}
          />
        ) : (
          <Pressable
            accessibilityLabel="Add lyrics"
            accessibilityRole="button"
            hitSlop={space.sm}
            onPress={() => setLyricsOpen(true)}>
            <Text style={[type.eyebrow, { color: pal.faint }]}>ADD LYRICS</Text>
          </Pressable>
        )}

        <View style={[styles.hairline, { backgroundColor: pal.line }]} />

        {open ? (
          <>
            <Step
              index="2"
              label="WHERE IT RUNS"
              value={target?.label ?? 'nowhere yet'}
            />
            <View style={styles.chips}>
              {targets.map(candidate => (
                <Chip
                  key={candidate.nodePublicKey}
                  label={
                    candidate.ready
                      ? candidate.label
                      : `${candidate.label} · offline`
                  }
                  selected={resolved.nodePublicKey === candidate.nodePublicKey}
                  onPress={() =>
                    // Changing the engine drops the model with it: the next
                    // node's list is a different list, and carrying a selector
                    // across is how `model-not-installed` used to happen.
                    setDraft(current => ({
                      ...current,
                      ...resolved,
                      nodePublicKey: candidate.nodePublicKey,
                      modelSelector: null,
                      parameters: {},
                    }))
                  }
                  disabled={submitting}
                />
              ))}
            </View>

            <Step
              index="3"
              label="WHAT RUNS IT"
              value={resolved.modelSelector ?? 'nothing installed'}
            />
            <Text style={[type.eyebrow, styles.note, { color: pal.faint }]}>
              {modelsNote(target, models.length)}
            </Text>
            <View style={styles.chips}>
              {models.map(model => (
                <Chip
                  key={model.selector}
                  label={model.selector}
                  selected={resolved.modelSelector === model.selector}
                  onPress={() =>
                    update({ modelSelector: model.selector, parameters: {} })
                  }
                  disabled={submitting}
                />
              ))}
            </View>

            <Step
              index="4"
              label="HOW LONG"
              value={
                resolved.durationSeconds === null
                  ? "the engine's choice"
                  : `${resolved.durationSeconds} seconds`
              }
            />
            <View style={styles.chips}>
              <Chip
                label="auto"
                selected={resolved.durationSeconds === null}
                onPress={() => update({ durationSeconds: null })}
                disabled={submitting}
              />
              {durationChoices(target).map(seconds => (
                <Chip
                  key={seconds}
                  label={`${seconds}s`}
                  selected={resolved.durationSeconds === seconds}
                  onPress={() => update({ durationSeconds: seconds })}
                  disabled={submitting}
                />
              ))}
            </View>

            <View style={[styles.rule, { backgroundColor: pal.ink }]} />
            {declared.length === 0 ? (
              <>
                <Text style={[type.eyebrow, { color: pal.muted }]}>
                  {(resolved.modelSelector ?? 'this model').toUpperCase()}{' '}
                  DECLARES NOTHING
                </Text>
                <Text style={[type.body, { color: pal.muted }]}>
                  So nothing is drawn here. No greyed-out controls — the app
                  never claims an engine has a knob it did not advertise.
                </Text>
              </>
            ) : (
              <>
                <Text style={[type.eyebrow, { color: pal.muted }]}>
                  DECLARED BY {(resolved.modelSelector ?? '').toUpperCase()}
                </Text>
                <ModelParams
                  declared={declared}
                  disabled={submitting}
                  onChange={(key, value) =>
                    update({
                      parameters: { ...resolved.parameters, [key]: value },
                    })
                  }
                  values={resolved.parameters}
                />
              </>
            )}
          </>
        ) : (
          // Closed, the whole machine is one line. With one node and one model
          // — the alpha case — it resolves itself and never needs opening.
          <Pressable
            accessibilityLabel="Change engine, model and length"
            accessibilityRole="button"
            onPress={() => setOpen(true)}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>
              {machineLine(target, resolved)}
            </Text>
            <Text style={[type.eyebrow, styles.note, { color: pal.faint }]}>
              {changeNote(targets.length, models.length)}
            </Text>
          </Pressable>
        )}

        {/*
          The arc this engine will trace, drawn from what the model declared
          rather than authored as four acts: a shorter pipeline shows fewer
          stages instead of greyed-out ones, and a node that declares nothing
          shows none at all.
        */}
        {stages.length === 0 ? null : (
          <Canvas
            style={[
              styles.stages,
              {
                width:
                  stages.length * COMPOSER_KNOBS.STAGE_GLYPH_GAP_PX,
              },
            ]}>
            {stages.map((stage, index) => (
              <SymbolArtworkPath
                key={`${stage}-${index}`}
                centerX={
                  index * COMPOSER_KNOBS.STAGE_GLYPH_GAP_PX +
                  COMPOSER_KNOBS.STAGE_GLYPH_PX / 2
                }
                centerY={COMPOSER_KNOBS.STAGE_ROW_HEIGHT_PX / 2}
                color={pal.faint}
                size={COMPOSER_KNOBS.STAGE_GLYPH_PX}
                symbol={STAGE_SYMBOLS[stage]}
              />
            ))}
          </Canvas>
        )}

        {problems
          .filter(problem => problem.kind !== 'caption-empty')
          .map(problem => (
            <Text key={problem.kind} style={[type.mono, { color: pal.muted }]}>
              {describeProblem(problem)}
            </Text>
          ))}
        {error !== null ? (
          <Text style={[type.mono, { color: pal.ink }]}>{error}</Text>
        ) : null}

        <View style={[styles.rule, { backgroundColor: pal.ink }]} />
        <Pressable
          accessibilityLabel="Make it"
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready || submitting }}
          disabled={!ready || submitting}
          onPress={() => {
            // One guard, here: a second tap while a submission is in flight
            // would create a second job for one intent.
            if (!ready || submitting) return;
            onSubmit(
              resolved.nodePublicKey as string,
              resolved.modelSelector as string,
              toGenerationRequest(resolved, declared),
            );
            setDraft(EMPTY_DRAFT);
            setLyricsOpen(false);
          }}
          style={styles.submit}>
          <Text
            style={[
              type.title,
              {
                color: ready && !submitting ? pal.ink : pal.faint,
                fontSize: COMPOSER_KNOBS.SUBMIT_SIZE_PX,
              },
            ]}>
            {submitting ? 'Sending it…' : 'Make it'}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

/** `AGENTBOX · ACESTEP:1.5-FAST · AUTO` — every machine choice in one line. */
function machineLine(
  target: ComposerTarget | null,
  draft: ComposerDraft,
): string {
  const where = target?.label ?? 'no engine';
  const what = draft.modelSelector ?? 'no model';
  const long =
    draft.durationSeconds === null ? 'auto' : `${draft.durationSeconds}s`;
  return `${where} · ${what} · ${long}`.toUpperCase();
}

/** Why that line needs no attention, or that it does. */
function changeNote(targetCount: number, modelCount: number): string {
  if (targetCount === 0) return 'NO ENGINE PAIRED · TAP TO SEE';
  if (targetCount === 1 && modelCount <= 1) {
    return 'ONE ENGINE, ONE MODEL · TAP TO CHANGE';
  }
  return 'TAP TO CHANGE';
}

/** What this node has, said as a count rather than as a warning. */
function modelsNote(target: ComposerTarget | null, count: number): string {
  const label = (target?.label ?? 'THIS NODE').toUpperCase();
  if (count === 0) return `${label} HAS NO MODEL INSTALLED`;
  if (count === 1) return `THE ONLY MODEL ${label} HAS`;
  return `THE ${count} MODELS ${label} HAS`;
}

/** Lengths inside what this engine accepts; nothing it would reject. */
function durationChoices(target: ComposerTarget | null): readonly number[] {
  const limits = target?.limits;
  if (!limits) return [];
  const choices: number[] = [];
  for (
    let seconds = Math.ceil(
      limits.min_song_seconds / COMPOSER_KNOBS.DURATION_STEP_SECONDS,
    ) * COMPOSER_KNOBS.DURATION_STEP_SECONDS;
    seconds <= limits.max_song_seconds && choices.length < 6;
    seconds += COMPOSER_KNOBS.DURATION_STEP_SECONDS * 2
  ) {
    choices.push(seconds);
  }
  return choices;
}

/** One numbered step of the cascade: what it decides, and what it decided. */
function Step({
  index,
  label,
  value,
}: {
  index: string;
  label: string;
  value: string;
}) {
  const pal = usePalette();
  return (
    <View style={styles.step}>
      <Text style={[type.mono, styles.stepIndex, { color: pal.faint }]}>
        {index}
      </Text>
      <Text style={[type.eyebrow, styles.stepLabel, { color: pal.muted }]}>
        {label}
      </Text>
      <Text style={[type.body, styles.stepValue, { color: pal.ink }]}>
        {value}
      </Text>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  disabled,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  const pal = usePalette();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: selected ? pal.ink : pal.line },
        selected ? { borderWidth: 2 } : null,
      ]}>
      <Text style={[type.mono, { color: selected ? pal.ink : pal.muted }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  body: { gap: space.md, paddingBottom: space.xxl, paddingTop: space.md },
  caption: { padding: 0, textAlignVertical: 'top' },
  lyrics: { padding: 0, textAlignVertical: 'top' },
  hairline: { height: 1, marginVertical: space.sm },
  rule: { height: 1, marginTop: space.md },
  note: { marginTop: space.xs },
  step: { alignItems: 'baseline', flexDirection: 'row', gap: space.sm },
  stepIndex: { width: space.md },
  stepLabel: { flexShrink: 0 },
  stepValue: { flexShrink: 1, marginLeft: 'auto' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    borderWidth: 1,
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  stages: { height: COMPOSER_KNOBS.STAGE_ROW_HEIGHT_PX },
  submit: { justifyContent: 'center', minHeight: touch.min },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const ComposerSheet = React.memo(ComposerSheetImpl);
