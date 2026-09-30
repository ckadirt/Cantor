import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { TransformText, WriteSymbol } from '../../motion';
import { STAGE_SYMBOLS } from '../../jobs/marks';
import {
  Choice,
  Coda,
  CodaWhy,
  Dial,
  FolioHead,
  FOLIO_ACT_STYLE,
  FOLIO_KNOBS,
  FOLIO_META_STYLE,
  FOLIO_TITLE_STYLE,
  Measure,
  PanelPressable,
  Rest,
  Row,
  Ruler,
  Stave,
  StationMark,
  Underway,
  useReach,
  LEDGER_DIAL_ITEM,
  LEDGER_KNOBS,
} from '../controls';
import { space, touch, type, usePalette } from '../../theme/tokens';
import { lyricsContractFor } from '../../core/protocol/lyrics';
import { ModelParams } from './ModelParams';
import {
  EMPTY_DRAFT,
  canSubmit,
  declaredFor,
  writeWordsFor,
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
export const COMPOSER_KNOBS = {
  /**
   * The caption is the Folio head's title (`FOLIO_TITLE_STYLE`, 26/32): one
   * size, never smaller when the machine choices open — two type sizes for one
   * string means the words under the finger change size mid-motion.
   */
  LYRICS_LINES: 4,
  DURATION_STEP_SECONDS: 15, // coarse enough to tap, fine enough to matter
  /** Small reference glyphs: the arc is a quiet annotation beside its label. */
  STAGE_GLYPH_PX: 16,
  STAGE_GLYPH_GAP_PX: space.sm,
  /**
   * How long a stage glyph takes to trace itself on.
   *
   * Slower than the header's mark and staggered behind it, because four
   * glyphs arriving together read as a row appearing rather than as an arc
   * being drawn.
   */
  STAGE_WRITE_MS: 520,
  /** How long `Make it` takes to become `Sending it`, and back. */
  ACT_MS: 520,
  /** The seat that morphing word takes: the act's own 28 px line. */
  ACT_SLOT_PX: 28,
  /** A node's station beside its name in the node row. */
  NODE_MARK_PX: 18,
  MARK_WRITE_MS: 420,
  /** The quiet mono of every label in this sheet; the engines sheet's own. */
  META_PX: 12,
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
 * the machine choices remain visible on the Ledger spine. The order underneath is dependency order — song, then where it
 * runs, then what runs it, then how long, then whatever that model declares —
 * so a combination the node cannot run is never offered in the first place.
 *
 * **Everything chosen here is chosen on a dial.** The same control the field's
 * axis, order and resolution use: a row of words with a tick that slides to
 * the one that is picked. It replaced a row of bordered boxes, which was the
 * one place in the app that answered "pick one of these" with a form — and
 * which is why this sheet used to read as something dropped into the drawing
 * rather than part of it. A step with a single option is not a dial at all,
 * because there is nothing to choose: it is stated, in the sheet's own serif.
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

  // Default to the only sensible choice rather than making someone pick it.
  const nodePublicKey =
    draft.nodePublicKey ??
    (targets.length === 1 ? targets[0].nodePublicKey : null);
  const target = targetOf(targets, nodePublicKey);
  // Dependency order in one line: the models on offer are the ones *this* node
  // has. A union across nodes would offer a pairing that cannot exist and then
  // report it as the person's mistake.
  const models = useMemo(() => modelsFor(target), [target]);
  const selection: ComposerDraft = {
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

  const resolved: ComposerDraft =
    selection.wordsMode === 'model' && !writeWordsFor(targets, selection)
      ? { ...selection, wordsMode: 'none' }
      : selection;
  const declared = declaredFor(targets, resolved);
  const controls = declared;
  const writer = writeWordsFor(targets, resolved);
  const problems = problemsWith(resolved, targets);
  const ready = canSubmit(resolved, targets);
  const captionBytes = utf8Bytes(resolved.caption.trim());
  const captionLimit = target?.limits?.max_caption_bytes ?? null;
  const selected = models.find(
    model => model.selector === resolved.modelSelector,
  );
  const stages = selected?.stages ?? [];
  const lengths = durationChoices(target);

  /** An empty caption is the page's own state, not a reason to write down. */
  const shown = problems.filter(problem => problem.kind !== 'caption-empty');

  /**
   * The last send failed: the rule went still and the word says so, until the
   * next touch of anything in the draft.
   */
  const [failed, setFailed] = useState(false);
  const wasSubmitting = useRef(submitting);
  useEffect(() => {
    if (wasSubmitting.current && !submitting && error !== null) setFailed(true);
    wasSubmitting.current = submitting;
  }, [error, submitting]);

  const update = (patch: Partial<ComposerDraft>) => {
    if (submitting) return;
    setFailed(false);
    setDraft(current => ({ ...current, ...resolved, ...patch }));
  };

  const overCaption = captionLimit !== null && captionBytes > captionLimit;
  const summary = [
    target?.label,
    resolved.modelSelector,
    resolved.durationSeconds === null ? 'AUTO' : `${resolved.durationSeconds}S`,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ')
    .toUpperCase();

  return (
    <>
      <FolioHead
        clef={
          // The sheet draws its own mark as it comes down — ∇, the stage a
          // generation begins at, which is what this sheet is. Written rather
          // than faded, because the blind arrives by being pulled and the
          // thing inside it should arrive by being drawn.
          <WriteSymbol
            symbol="nabla"
            width={FOLIO_KNOBS.CLEF_PX}
            height={FOLIO_KNOBS.CLEF_PX}
            duration={COMPOSER_KNOBS.MARK_WRITE_MS}
            color={pal.ink}
          />
        }
        eyebrow="COMPOSE · DRAFT"
        nav={{
          label: 'CLOSE',
          accessibilityLabel: 'Close composer',
          onPress: onClose,
        }}
        // The caption is the head's title: the only creative act on the
        // screen, set as the name of the thing being made. No box, no label,
        // no counter until it matters: a sheet of paper.
        title={
          <TextInput
            accessibilityLabel="Describe the song"
            editable={!submitting}
            multiline
            onChangeText={caption => update({ caption })}
            placeholder="a slow harbour at dusk"
            placeholderTextColor={pal.faint}
            style={[styles.caption, FOLIO_TITLE_STYLE, { color: pal.ink }]}
            value={resolved.caption}
          />
        }
        meta={
          <Text
            style={[
              FOLIO_META_STYLE,
              styles.metaLine,
              { color: overCaption ? pal.ink : pal.faint },
            ]}
          >
            {overCaption
              ? `${captionBytes}/${captionLimit} BYTES`
              : summary || 'NOWHERE YET'}
          </Text>
        }
      />

      <Stave keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
        <Measure>
          <Row
            label="Words"
            control
            note={
              resolved.wordsMode === 'none'
                ? lyricsContractFor(selected).instrumentalLyrics
                  ? 'This will be instrumental'
                  : 'No lyrics supplied'
                : resolved.wordsMode === 'model'
                ? 'The model writes the lyrics'
                : undefined
            }
          >
            <PanelPressable
              accessibilityLabel={
                resolved.wordsMode === 'mine' ? 'No lyrics' : 'Write my lyrics'
              }
              accessibilityRole="button"
              disabled={submitting}
              onPress={() =>
                update({
                  wordsMode: resolved.wordsMode === 'mine' ? 'none' : 'mine',
                })
              }
              style={LEDGER_DIAL_ITEM}
            >
              <Text style={[type.body, { color: pal.ink }]}>
                {resolved.wordsMode === 'mine'
                  ? 'My words'
                  : resolved.wordsMode === 'model'
                  ? 'Automatic'
                  : 'None'}
              </Text>
            </PanelPressable>
            {resolved.wordsMode === 'mine' ? (
              <TextInput
                accessibilityLabel="Lyrics"
                editable={!submitting}
                multiline
                numberOfLines={COMPOSER_KNOBS.LYRICS_LINES}
                onChangeText={lyrics => update({ lyrics })}
                placeholder="Write the words"
                placeholderTextColor={pal.faint}
                style={[styles.lyrics, type.body, { color: pal.ink }]}
                value={resolved.lyrics}
              />
            ) : null}
          </Row>
          <Row label="Node" control>
            <Choice
              activeKey={resolved.nodePublicKey}
              disabled={submitting}
              empty="nowhere yet — no node is paired"
              items={targets.map(candidate => ({
                key: candidate.nodePublicKey,
                label: candidate.label,
                accessibilityLabel: `Run it on ${candidate.label}`,
                state: candidate.ready ? 'ready' : 'offline',
                quiet: !candidate.ready,
                mark: (
                  <StationMark
                    models={candidate.models.length}
                    nodePublicKey={candidate.nodePublicKey}
                    size={COMPOSER_KNOBS.NODE_MARK_PX}
                    state={candidate.ready ? 'ready' : 'offline'}
                  />
                ),
              }))}
              onSelect={key =>
                // Changing the node drops the model with it: the next node's
                // list is a different list, and carrying a selector across is
                // how `model-not-installed` used to happen.
                !submitting &&
                setDraft(current => ({
                  ...current,
                  ...resolved,
                  nodePublicKey: key,
                  modelSelector: null,
                  parameters: {},
                  wordsMode:
                    current.wordsMode === 'model' ? 'none' : current.wordsMode,
                }))
              }
            />
          </Row>

          <Row
            label="Model"
            control
            note={
              models.length > 1 ? undefined : modelsNote(target, models.length)
            }
          >
            <Choice
              activeKey={resolved.modelSelector}
              disabled={submitting}
              empty={
                target === null
                  ? 'not until a node is chosen'
                  : 'nothing installed'
              }
              items={models.map(model => ({
                key: model.selector,
                label: model.selector,
                accessibilityLabel: `Run it with ${model.selector}`,
                state: model.stages?.length
                  ? `${model.stages.length} stages`
                  : undefined,
              }))}
              onSelect={key =>
                update({
                  modelSelector: key,
                  parameters: {},
                  wordsMode:
                    resolved.wordsMode === 'model'
                      ? 'none'
                      : resolved.wordsMode,
                })
              }
            />
          </Row>

          <Row label="Length" control>
            {/* The value in words above the line it is chosen along. */}
            <View style={styles.rulerValue}>
              <Text style={[type.body, { color: pal.ink }]}>
                {resolved.durationSeconds === null
                  ? "the model's choice"
                  : `${resolved.durationSeconds} seconds`}
              </Text>
            </View>
            {lengths.length > 0 ? (
              <Ruler
                auto
                activeKey={
                  resolved.durationSeconds === null
                    ? AUTO_LENGTH
                    : String(resolved.durationSeconds)
                }
                disabled={submitting}
                onSelect={key =>
                  update({
                    durationSeconds: key === AUTO_LENGTH ? null : Number(key),
                  })
                }
                stops={[
                  {
                    key: AUTO_LENGTH,
                    accessibilityLabel: "Length: the model's choice",
                  },
                  ...lengths.map(seconds => ({
                    key: String(seconds),
                    accessibilityLabel: `Length: ${seconds} seconds`,
                  })),
                ]}
              />
            ) : null}
          </Row>
        </Measure>
        {writer || controls.length > 0 ? (
          <>
            <Rest />
            <Measure>
              {writer ? (
                <Row label="Write words" control>
                  <Dial
                    compact
                    activeColour={pal.ink}
                    activeKey={resolved.wordsMode === 'model' ? 'on' : 'off'}
                    items={[
                      {
                        key: 'off',
                        label: 'OFF',
                        accessibilityLabel: 'Write words: off',
                      },
                      {
                        key: 'on',
                        label: 'ON',
                        accessibilityLabel: 'Generate lyrics automatically',
                      },
                    ]}
                    itemStyle={LEDGER_DIAL_ITEM}
                    onSelect={key =>
                      update({
                        wordsMode:
                          key === 'on'
                            ? 'model'
                            : resolved.lyrics.trim()
                            ? 'mine'
                            : 'none',
                      })
                    }
                    restColour={pal.faint}
                    textStyle={styles.dialWord}
                    tickColour={pal.ink}
                  />
                </Row>
              ) : null}
              <ModelParams
                declared={controls}
                disabled={submitting}
                onChange={(key, value) =>
                  update({
                    parameters: { ...resolved.parameters, [key]: value },
                  })
                }
                values={resolved.parameters}
              />
            </Measure>
          </>
        ) : null}
        {stages.length > 0 ? (
          <>
            <Rest />
            <Measure>
              <Row label="It traces">
                <StageArc colour={pal.faint} stages={stages} />
              </Row>
            </Measure>
          </>
        ) : null}
      </Stave>
      <Coda
        why={
          shown.length === 0 && error === null ? null : (
            <>
              {shown.map(problem => (
                <CodaWhy
                  key={
                    problem.kind === 'parameter'
                      ? `parameter-${problem.key}`
                      : problem.kind
                  }
                >
                  {describeProblem(problem)}
                </CodaWhy>
              ))}
              {error !== null ? (
                <Text
                  accessibilityRole="alert"
                  style={[type.small, { color: pal.ink }]}
                >
                  {error}
                </Text>
              ) : null}
            </>
          )
        }
      >
        <MakeIt
          failed={failed}
          onPress={() => {
            // One guard, here: a second tap while a submission is in flight
            // would create a second job for one intent.
            if (!ready || submitting) return;
            setFailed(false);
            onSubmit(
              resolved.nodePublicKey as string,
              resolved.modelSelector as string,
              toGenerationRequest(resolved, declared, selected),
            );
            setDraft(EMPTY_DRAFT);
          }}
          ready={ready}
          submitting={submitting}
        />
      </Coda>
    </>
  );
}

/**
 * `Make it`: the page's one act. While it sends, the working rule grows under
 * it and the word morphs to its present tense; if the send fails, the rule
 * goes still and faint and the word says so (`folio.html#working`).
 */
function MakeIt({
  failed,
  onPress,
  ready,
  submitting,
}: {
  failed: boolean;
  onPress: () => void;
  ready: boolean;
  submitting: boolean;
}) {
  // Out of reach only when there is nothing to send; sending is busy, not
  // unavailable, so the word keeps its ink and grows the rule.
  const { colour } = useReach(!ready && !submitting);
  const label = submitting ? 'Sending it' : failed ? 'Not sent' : 'Make it';
  return (
    <PanelPressable
      accessibilityLabel="Make it"
      accessibilityRole="button"
      accessibilityState={{ disabled: !ready, busy: submitting }}
      disabled={!ready && !submitting}
      onPress={submitting ? undefined : onPress}
      style={styles.submit}
    >
      <View>
        <TransformText
          charStyle={FOLIO_ACT_STYLE}
          color={colour}
          duration={COMPOSER_KNOBS.ACT_MS}
          style={styles.actSlot}
          text={label}
        />
        <Underway
          charStyle={FOLIO_ACT_STYLE}
          failed={failed}
          label={label}
          working={submitting}
        />
      </View>
    </PanelPressable>
  );
}

/** The key `auto` occupies on the length dial; no engine can collide with it. */
const AUTO_LENGTH = 'auto';

/**
 * The arc this engine will trace, drawn from what the model declared.
 *
 * Built from the mask rather than authored as four acts, so a shorter pipeline
 * shows fewer stages instead of greyed-out ones, and a node that declares
 * nothing shows none at all. Each glyph writes itself on, one after the next,
 * because the row is an arc being drawn and not a row of icons appearing — the
 * same gesture the mark at the head of the sheet arrives by.
 */
function StageArc({
  colour,
  stages,
}: {
  colour: string;
  stages: readonly (keyof typeof STAGE_SYMBOLS)[];
}) {
  if (stages.length === 0) return null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`This model runs ${
        stages.length
      } stages: ${stages.join(', ')}`}
      style={styles.stages}
    >
      {stages.map((stage, index) => (
        <WriteSymbol
          key={`${stage}-${index}`}
          symbol={STAGE_SYMBOLS[stage]}
          width={COMPOSER_KNOBS.STAGE_GLYPH_PX}
          height={COMPOSER_KNOBS.STAGE_GLYPH_PX}
          duration={COMPOSER_KNOBS.STAGE_WRITE_MS}
          color={colour}
        />
      ))}
    </View>
  );
}

/** What this node has, said as a count rather than as a warning. */
function modelsNote(target: ComposerTarget | null, count: number): string {
  // Dependency order, said out loud: with several engines paired nothing is
  // chosen yet, and "this node has no model installed" would be an accusation
  // about a node that has not been named.
  if (target === null) return 'Choose where it runs first.';
  const label = target.label;
  if (count === 0) return `${label} has no model installed.`;
  if (count === 1) return `The only model ${label} has.`;
  return `The ${count} models ${label} has.`;
}

/** Lengths inside what this engine accepts; nothing it would reject. */
function durationChoices(target: ComposerTarget | null): readonly number[] {
  const limits = target?.limits;
  if (!limits) return [];
  const choices: number[] = [];
  for (
    let seconds =
      Math.ceil(
        limits.min_song_seconds / COMPOSER_KNOBS.DURATION_STEP_SECONDS,
      ) * COMPOSER_KNOBS.DURATION_STEP_SECONDS;
    seconds <= limits.max_song_seconds && choices.length < 6;
    seconds += COMPOSER_KNOBS.DURATION_STEP_SECONDS * 2
  ) {
    choices.push(seconds);
  }
  return choices;
}

const styles = StyleSheet.create({
  dialWord: { ...type.eyebrow, fontSize: 12, letterSpacing: 0 },
  /**
   * Every label in this sheet, and every word on its dials.
   *
   * The eyebrow one step softer — 12 px at 0.7 tracking rather than 11 at 2.0
   * — which is the type the engines sheet is set in. At the tighter tracking a
   * label reads as a label; at 2.0 a line like `ONE ENGINE, ONE MODEL · TAP TO
   * CHANGE` reads as a wide grey band across the sheet, which is most of what
   * made this surface hard to read.
   */
  meta: {
    ...type.eyebrow,
    fontSize: COMPOSER_KNOBS.META_PX,
    letterSpacing: 0.7,
    lineHeight: 19,
  },
  caption: {
    padding: 0,
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
  metaLine: { lineHeight: FOLIO_KNOBS.EYEBROW_LINE_PX },
  lyrics: { padding: 0, textAlignVertical: 'top' },
  /** The ruler's value, on the label's line, with the line under it. */
  rulerValue: { justifyContent: 'center', paddingTop: 13 },
  stages: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: COMPOSER_KNOBS.STAGE_GLYPH_GAP_PX,
    minHeight: LEDGER_KNOBS.LINE_PX,
  },
  submit: { justifyContent: 'center', minHeight: touch.min },
  actSlot: { height: COMPOSER_KNOBS.ACT_SLOT_PX },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const ComposerSheet = React.memo(ComposerSheetImpl);
