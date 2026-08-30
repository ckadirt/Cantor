import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { space, touch, type, usePalette } from '../../theme/tokens';
import { ModelParams } from './ModelParams';
import {
  EMPTY_DRAFT,
  canSubmit,
  declaredFor,
  describeProblem,
  modelUnion,
  problemsWith,
  targetOf,
  toGenerationRequest,
  utf8Bytes,
  type ComposerDraft,
  type ComposerTarget,
} from './draft';

/** KNOBS */
const COMPOSER_KNOBS = {
  CAPTION_LINES: 3,
  LYRICS_LINES: 5,
  DURATION_STEP_SECONDS: 15, // coarse enough to tap, fine enough to matter
} as const;

type Props = {
  visible: boolean;
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
 */
function ComposerSheetImpl({
  visible,
  targets,
  submitting,
  error,
  onClose,
  onSubmit,
}: Props) {
  const pal = usePalette();
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);

  const models = useMemo(() => modelUnion(targets), [targets]);
  // Default to the only sensible choice rather than making someone pick it.
  const resolved: ComposerDraft = {
    ...draft,
    nodePublicKey:
      draft.nodePublicKey ??
      (targets.length === 1 ? targets[0].nodePublicKey : null),
    modelSelector:
      draft.modelSelector ?? (models.length === 1 ? models[0].selector : null),
  };

  const declared = declaredFor(targets, resolved);
  const problems = problemsWith(resolved, targets);
  const ready = canSubmit(resolved, targets);
  const target = targetOf(targets, resolved.nodePublicKey);
  const captionBytes = utf8Bytes(resolved.caption.trim());
  const captionLimit = target?.limits?.max_caption_bytes ?? null;

  const update = (patch: Partial<ComposerDraft>) =>
    setDraft(current => ({ ...current, ...resolved, ...patch }));

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: pal.bg, borderColor: pal.line },
          ]}>
          <View style={styles.header}>
            <Text style={[type.title, { color: pal.ink }]}>Compose</Text>
            <Pressable
              accessibilityLabel="Close composer"
              accessibilityRole="button"
              onPress={onClose}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.field}>
              <View style={styles.labelRow}>
                <Text style={[type.eyebrow, { color: pal.muted }]}>SONG</Text>
                {captionLimit !== null ? (
                  <Text
                    style={[
                      type.mono,
                      { color: captionBytes > captionLimit ? pal.ink : pal.faint },
                    ]}>
                    {captionBytes}/{captionLimit}
                  </Text>
                ) : null}
              </View>
              <TextInput
                accessibilityLabel="Describe the song"
                editable={!submitting}
                multiline
                numberOfLines={COMPOSER_KNOBS.CAPTION_LINES}
                onChangeText={caption => update({ caption })}
                placeholder="a slow piano piece, rain outside"
                placeholderTextColor={pal.faint}
                style={[
                  styles.input,
                  styles.multiline,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
                value={resolved.caption}
              />
            </View>

            <View style={styles.field}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>
                LYRICS · OPTIONAL
              </Text>
              <TextInput
                accessibilityLabel="Lyrics"
                editable={!submitting}
                multiline
                numberOfLines={COMPOSER_KNOBS.LYRICS_LINES}
                onChangeText={lyrics => update({ lyrics })}
                placeholder="leave empty for an instrumental"
                placeholderTextColor={pal.faint}
                style={[
                  styles.input,
                  styles.multiline,
                  type.body,
                  { color: pal.ink, borderColor: pal.line },
                ]}
                value={resolved.lyrics}
              />
            </View>

            <View style={styles.field}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>
                LENGTH ·{' '}
                {resolved.durationSeconds === null
                  ? "THE ENGINE'S CHOICE"
                  : `${resolved.durationSeconds}S`}
              </Text>
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
            </View>

            <View style={styles.field}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>MODEL</Text>
              <View style={styles.chips}>
                {models.length === 0 ? (
                  <Text style={[type.body, { color: pal.muted }]}>
                    No paired engine has a model installed.
                  </Text>
                ) : (
                  models.map(model => (
                    <Chip
                      key={model.selector}
                      label={model.selector}
                      selected={resolved.modelSelector === model.selector}
                      onPress={() => update({ modelSelector: model.selector })}
                      disabled={submitting}
                    />
                  ))
                )}
              </View>
            </View>

            {/*
              Whatever this model declares. A node that declares nothing renders
              nothing here, which is the M4 composer unchanged.
            */}
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

            <View style={styles.field}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>ENGINE</Text>
              <View style={styles.chips}>
                {targets.map(candidate => (
                  <Chip
                    key={candidate.nodePublicKey}
                    label={candidate.ready ? candidate.label : `${candidate.label} · offline`}
                    selected={resolved.nodePublicKey === candidate.nodePublicKey}
                    onPress={() =>
                      update({ nodePublicKey: candidate.nodePublicKey })
                    }
                    disabled={submitting}
                  />
                ))}
              </View>
            </View>

            {problems.map(problem => (
              <Text
                key={problem.kind}
                style={[type.mono, { color: pal.muted }]}>
                {describeProblem(problem)}
              </Text>
            ))}
            {error !== null ? (
              <Text style={[type.mono, { color: pal.ink }]}>{error}</Text>
            ) : null}

            <Pressable
              accessibilityLabel="Generate"
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
              style={[
                styles.submit,
                { borderColor: ready && !submitting ? pal.ink : pal.faint },
              ]}>
              <Text
                style={[
                  type.mono,
                  { color: ready && !submitting ? pal.ink : pal.faint },
                ]}>
                {submitting ? 'Sending…' : 'Generate'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Lengths inside what this engine accepts; nothing it would reject. */
function durationChoices(target: ComposerTarget | null): readonly number[] {
  const limits = target?.limits;
  if (!limits) return [];
  const choices: number[] = [];
  for (
    let seconds = Math.ceil(limits.min_song_seconds / COMPOSER_KNOBS.DURATION_STEP_SECONDS) *
      COMPOSER_KNOBS.DURATION_STEP_SECONDS;
    seconds <= limits.max_song_seconds && choices.length < 6;
    seconds += COMPOSER_KNOBS.DURATION_STEP_SECONDS * 2
  ) {
    choices.push(seconds);
  }
  return choices;
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
  scrim: { flex: 1, justifyContent: 'flex-start' },
  sheet: { borderBottomWidth: 1, maxHeight: '92%', padding: space.lg },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  body: { gap: space.lg, paddingBottom: space.lg },
  field: { gap: space.xs },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between' },
  input: { borderWidth: 1, minHeight: touch.min, paddingHorizontal: space.sm },
  multiline: { paddingVertical: space.sm, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    borderWidth: 1,
    minHeight: touch.min,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    minHeight: touch.min,
  },
});

/**
 * Memoised: the field camera re-renders its screen on every gesture frame, and
 * this component's props do not depend on the camera.
 */
export const ComposerSheet = React.memo(ComposerSheetImpl);
