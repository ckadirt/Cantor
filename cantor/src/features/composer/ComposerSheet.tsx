import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { WriteSymbol } from '../../motion';
import { STAGE_SYMBOLS } from '../../jobs/marks';
import {
  Dial,
  PanelPressable,
  Ledger,
  Row,
  LedgerGap,
  LedgerFoot,
  LEDGER_DIAL_ITEM,
  LEDGER_KNOBS,
  type DialItem,
} from '../controls';
import { space, type, usePalette } from '../../theme/tokens';
import { ModelParams } from './ModelParams';
import {
  EMPTY_DRAFT,
  canSubmit,
  declaredFor,
  declaredControlsFor,
  writeWordsFor,
  type WordsMode,
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
   * The caption: the only creative act on the screen, so the largest thing on
   * it, and one size.
   *
   * It used to drop to 17 px when the machine choices opened, on the argument
   * that it had become context. Two type sizes for one string means the words
   * under the finger change size at the moment a drawer opens somewhere else —
   * a jump inside a motion, and a reflow no animation can carry (a font size
   * animated on the UI thread never reaches React Native's layout pass). The
   * machine arrives *below* the caption instead, and the surface stays the
   * surface.
   */
  CAPTION_SIZE_PX: 25,
  CAPTION_LINE_PX: 36,
  LYRICS_LINES: 4,
  DURATION_STEP_SECONDS: 15, // coarse enough to tap, fine enough to matter
  /**
   * The sheet's own mark, drawn as the sheet arrives.
   *
   * A step under the engines sheet's 40, because ∇ is a large filled triangle
   * where ∮ is a hairline: at the same number the composer's head weighed
   * twice what the other sheet's does, and the mark was the loudest thing on a
   * surface whose loudest thing is meant to be the caption.
   */
  SYMBOL_PX: 32,
  /**
   * The declared stage row: the arc this engine will trace, drawn before you
   * commit.
   *
   * 22 px was too small for the glyphs to be themselves — ℵ₀ at that size is a
   * mark with a smudge under it — and a row of unreadable marks is noise
   * wearing the shape of information.
   */
  STAGE_GLYPH_PX: 30,
  STAGE_GLYPH_GAP_PX: space.md,
  /**
   * How long a stage glyph takes to trace itself on.
   *
   * Slower than the header's mark and staggered behind it, because four
   * glyphs arriving together read as a row appearing rather than as an arc
   * being drawn.
   */
  STAGE_WRITE_MS: 520,
  MARK_WRITE_MS: 420,
  /** `Make it`: a serif line, not a button in a box. */
  SUBMIT_SIZE_PX: 19,
  /** The quiet mono of every label in this sheet; the engines sheet's own. */
  META_PX: 12,
  /** Header and submit row height. */
  ROW_PX: 56,
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
  const controls = declaredControlsFor(targets, resolved);
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

  const update = (patch: Partial<ComposerDraft>) => {
    if (!submitting)
      setDraft(current => ({ ...current, ...resolved, ...patch }));
  };

  return (
    <>
      <View style={[styles.header, { borderColor: pal.line }]}>
        {/*
          The sheet draws its own mark as it comes down — ∇, the stage a
          generation begins at, which is what this sheet is. Written rather
          than faded, because the blind arrives by being pulled and the thing
          inside it should arrive by being drawn.
        */}
        <View
          style={styles.headingMark}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          <WriteSymbol
            symbol="nabla"
            width={COMPOSER_KNOBS.SYMBOL_PX}
            height={COMPOSER_KNOBS.SYMBOL_PX}
            duration={COMPOSER_KNOBS.MARK_WRITE_MS}
            color={pal.ink}
          />
        </View>
        <Text style={[styles.meta, { color: pal.muted }]}>COMPOSE</Text>
        <PanelPressable
          accessibilityLabel="Close composer"
          accessibilityRole="button"
          hitSlop={space.md}
          onPress={onClose}
        >
          <Text style={[styles.meta, { color: pal.muted }]}>CLOSE</Text>
        </PanelPressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {/*
          No box, no label, no counter until it matters: a sheet of paper.
        */}
        <TextInput
          accessibilityLabel="Describe the song"
          editable={!submitting}
          multiline
          onChangeText={caption => update({ caption })}
          placeholder="a slow harbour at dusk"
          placeholderTextColor={pal.faint}
          style={[
            styles.caption,
            {
              color: pal.ink,
              fontFamily: type.title.fontFamily,
              fontSize: COMPOSER_KNOBS.CAPTION_SIZE_PX,
              lineHeight: COMPOSER_KNOBS.CAPTION_LINE_PX,
            },
          ]}
          value={resolved.caption}
        />
        {captionLimit !== null && captionBytes > captionLimit ? (
          <Text style={[styles.meta, { color: pal.ink }]}>
            {captionBytes}/{captionLimit} BYTES
          </Text>
        ) : null}

        <Ledger>
          <Row
            label="Words"
            note={
              resolved.wordsMode === 'none'
                ? 'No lyrics supplied'
                : resolved.wordsMode === 'model'
                ? 'The model writes the lyrics'
                : undefined
            }
          >
            <Dial
              activeColour={pal.ink}
              activeKey={resolved.wordsMode}
              items={[
                { key: 'none', label: 'NONE', accessibilityLabel: 'No lyrics' },
                ...(writer
                  ? [
                      {
                        key: 'model',
                        label: 'MODEL’S',
                        accessibilityLabel: 'Generate lyrics automatically',
                      },
                    ]
                  : []),
                {
                  key: 'mine',
                  label: 'MINE',
                  accessibilityLabel: 'Write my lyrics',
                },
              ]}
              itemStyle={LEDGER_DIAL_ITEM}
              onSelect={key => update({ wordsMode: key as WordsMode })}
              restColour={pal.faint}
              textStyle={styles.meta}
              tickColour={pal.ink}
            />
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
          <Choice
            label="Engine"
            items={targets.map(candidate => ({
              key: candidate.nodePublicKey,
              label: (candidate.ready
                ? candidate.label
                : `${candidate.label} · offline`
              ).toUpperCase(),
              accessibilityLabel: `Run it on ${candidate.label}`,
            }))}
            activeKey={resolved.nodePublicKey}
            empty="nowhere yet — no engine is paired"
            onSelect={key =>
              // Changing the engine drops the model with it: the next
              // node's list is a different list, and carrying a selector
              // across is how `model-not-installed` used to happen.
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
            value={target?.label ?? null}
          />

          <Choice
            label="Model"
            items={models.map(model => ({
              key: model.selector,
              label: model.selector.toUpperCase(),
              accessibilityLabel: `Run it with ${model.selector}`,
            }))}
            activeKey={resolved.modelSelector}
            empty={
              target === null
                ? 'not until an engine is chosen'
                : 'nothing installed'
            }
            note={modelsNote(target, models.length)}
            onSelect={key =>
              update({
                modelSelector: key,
                parameters: {},
                wordsMode:
                  resolved.wordsMode === 'model' ? 'none' : resolved.wordsMode,
              })
            }
            value={resolved.modelSelector}
          />

          <Choice
            label="Length"
            items={[
              {
                key: AUTO_LENGTH,
                label: 'AUTO',
                accessibilityLabel: "The engine's choice of length",
              },
              ...lengths.map(seconds => ({
                key: String(seconds),
                label: `${seconds}S`,
                accessibilityLabel: `${seconds} seconds`,
              })),
            ]}
            activeKey={
              resolved.durationSeconds === null
                ? AUTO_LENGTH
                : String(resolved.durationSeconds)
            }
            empty="the engine's choice"
            onSelect={key =>
              update({
                durationSeconds: key === AUTO_LENGTH ? null : Number(key),
              })
            }
            value={
              resolved.durationSeconds === null
                ? "the engine's choice"
                : `${resolved.durationSeconds} seconds`
            }
          />

          {controls.length > 0 ? <LedgerGap /> : null}
          <ModelParams
            declared={controls}
            disabled={submitting}
            onChange={(key, value) =>
              update({ parameters: { ...resolved.parameters, [key]: value } })
            }
            values={resolved.parameters}
          />
          {stages.length > 0 ? (
            <>
              <LedgerGap />
              <Row label="It traces">
                <StageArc colour={pal.faint} stages={stages} />
              </Row>
            </>
          ) : null}
        </Ledger>
      </ScrollView>
      <LedgerFoot style={styles.foot}>
        {problems
          .filter(problem => problem.kind !== 'caption-empty')
          .map(problem => (
            <Text
              key={
                problem.kind === 'parameter'
                  ? `parameter-${problem.key}`
                  : problem.kind
              }
              style={[type.small, { color: pal.muted }]}
            >
              {describeProblem(problem)}
            </Text>
          ))}
        {error !== null ? (
          <Text
            accessibilityRole="alert"
            style={[type.small, { color: pal.ink }]}
          >
            {error}
          </Text>
        ) : null}

        <PanelPressable
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
          }}
          style={styles.submit}
        >
          <Text
            style={[
              type.title,
              {
                color: ready && !submitting ? pal.ink : pal.faint,
                fontSize: COMPOSER_KNOBS.SUBMIT_SIZE_PX,
              },
            ]}
          >
            {submitting ? 'Sending it…' : 'Make it'}
          </Text>
        </PanelPressable>
      </LedgerFoot>
    </>
  );
}

/** The key `auto` occupies on the length dial; no engine can collide with it. */
const AUTO_LENGTH = 'auto';

/**
 * One step of the cascade: what it decides, and how it is decided.
 *
 * A dial when there is something to pick, a stated value when there is one
 * option, and the reason when there are none. The interface never draws a
 * control for a choice that does not exist — that is the same rule dependency
 * order exists for, applied to a single step instead of to the chain.
 */
function Choice({
  activeKey,
  empty,
  items,
  label,
  note,
  onSelect,
  value,
}: {
  activeKey: string | null;
  /** What to say when the step has no options at all. */
  empty: string;
  items: readonly DialItem[];
  label: string;
  note?: string;
  onSelect: (key: string) => void;
  /** The chosen reading, in the sheet's own words, when there is nothing to pick. */
  value: string | null;
}) {
  const pal = usePalette();
  return (
    <Row label={label} note={note}>
      {items.length > 1 ? (
        <Dial
          activeColour={pal.ink}
          activeKey={activeKey ?? ''}
          items={items}
          itemStyle={LEDGER_DIAL_ITEM}
          onSelect={onSelect}
          restColour={pal.faint}
          // The lengths an engine accepts and the choices a model declares are
          // the node's to decide, so the row may be longer than the sheet.
          scroll
          textStyle={styles.meta}
          tickColour={pal.ink}
        />
      ) : (
        // The same seat a dial would have taken. Every step of the cascade is
        // a label over one row of that height, whether the row is a control or
        // a statement, so a step that resolved itself does not sit tighter to
        // its label than the step below it that did not.
        <View style={styles.stated}>
          <Text style={[type.body, { color: pal.ink }]}>
            {items.length === 1 ? value ?? items[0].label : empty}
          </Text>
        </View>
      )}
    </Row>
  );
}

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
      accessibilityLabel={`This engine runs ${
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
  /** The engines sheet's head, because it is the same head. */
  header: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'space-between',
    minHeight: COMPOSER_KNOBS.ROW_PX,
    paddingBottom: space.sm,
  },
  headingMark: { marginRight: space.sm },
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
  body: { gap: space.md, paddingBottom: space.lg, paddingTop: space.md },
  caption: { padding: 0, textAlignVertical: 'top' },
  lyrics: { padding: 0, textAlignVertical: 'top' },
  foot: { gap: space.sm },
  stated: { justifyContent: 'center', minHeight: LEDGER_KNOBS.LINE_PX },
  stages: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: COMPOSER_KNOBS.STAGE_GLYPH_GAP_PX,
    marginTop: space.sm,
  },
  submit: { justifyContent: 'center', minHeight: COMPOSER_KNOBS.ROW_PX },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const ComposerSheet = React.memo(ComposerSheetImpl);
