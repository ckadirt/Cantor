import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { AppIdentity } from '../identity/derive';
import { phraseIsValid } from '../identity/mnemonic';
import { restoreIdentity } from '../identity/secureIdentity';
import { space, touch, type, usePalette } from '../theme/tokens';

/** KNOBS */
const RESTORE_KNOBS = {
  WORDS: 12,
  INPUT_LINES: 4,
} as const;

type Props = {
  visible: boolean;
  onClose: () => void;
  onRestored: (identity: AppIdentity) => void;
};

/**
 * Twelve words back into an identity.
 *
 * This is the only moment a phrase is worth anything: a reinstall knows nothing
 * about the phone it replaces, and every node knows that phone only by the
 * public key its words derive. Nothing else can recover a pairing — not the
 * relay, not the node, not a backup of the app's own storage.
 *
 * It lives in onboarding rather than in settings because first launch after a
 * reinstall is the only time it is needed, and it is checksummed as typed: BIP39
 * carries its own check digit, so a mistyped word is refused here rather than
 * deriving a stranger's identity that no node has ever heard of.
 */
export function RestoreSheet({ visible, onClose, onRestored }: Props) {
  const pal = usePalette();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const words = useMemo(
    () => text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
    [text],
  );
  const complete = words.length === RESTORE_KNOBS.WORDS;
  const valid = complete && phraseIsValid(words);

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: pal.bg, borderColor: pal.line }]}>
          <View style={styles.header}>
            <Text style={[type.eyebrow, { color: pal.muted }]}>RESTORE</Text>
            <Pressable
              accessibilityLabel="Close restore"
              accessibilityRole="button"
              hitSlop={space.md}
              onPress={onClose}>
              <Text style={[type.eyebrow, { color: pal.muted }]}>CLOSE</Text>
            </Pressable>
          </View>

          <Text style={[type.title, styles.title, { color: pal.ink }]}>
            The twelve words
          </Text>
          <Text style={[type.body, { color: pal.muted }]}>
            Type them in order. This phone becomes the one they were written
            down for, and every node it was paired with knows it again.
          </Text>

          <TextInput
            accessibilityLabel="The twelve words"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            multiline
            numberOfLines={RESTORE_KNOBS.INPUT_LINES}
            onChangeText={value => {
              setProblem(null);
              setText(value);
            }}
            placeholder="legal winner thank year wave sausage…"
            placeholderTextColor={pal.faint}
            style={[
              styles.input,
              type.body,
              { borderColor: pal.line, color: pal.ink },
            ]}
            value={text}
          />

          {/* Checksummed as typed: the count first, then whether they cohere. */}
          <Text style={[type.eyebrow, { color: valid ? pal.ink : pal.faint }]}>
            {countLine(words.length, complete, valid)}
          </Text>
          {problem === null ? null : (
            <Text style={[type.mono, { color: pal.ink }]}>{problem}</Text>
          )}

          <Pressable
            accessibilityLabel="Restore this identity"
            accessibilityRole="button"
            accessibilityState={{ disabled: !valid || busy }}
            disabled={!valid || busy}
            onPress={() => {
              setBusy(true);
              setProblem(null);
              restoreIdentity(words)
                .then(onRestored)
                .catch(error =>
                  setProblem(
                    error instanceof Error ? error.message : String(error),
                  ),
                )
                .finally(() => setBusy(false));
            }}
            style={styles.submit}>
            <Text
              style={[
                type.title,
                styles.submitWord,
                { color: valid && !busy ? pal.ink : pal.faint },
              ]}>
              {busy ? 'Restoring…' : 'This is my phone'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** What the words are so far, and whether they add up. */
function countLine(
  count: number,
  complete: boolean,
  valid: boolean,
): string {
  if (count === 0) return `${RESTORE_KNOBS.WORDS} WORDS`;
  if (!complete) return `${count} OF ${RESTORE_KNOBS.WORDS}`;
  return valid ? 'THESE WORDS ADD UP' : 'THESE WORDS DO NOT ADD UP';
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopWidth: 1, gap: space.md, padding: space.lg },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  title: { fontSize: 24 },
  input: {
    borderWidth: 1,
    minHeight: touch.min * 2,
    padding: space.sm,
    textAlignVertical: 'top',
  },
  submit: { justifyContent: 'center', minHeight: touch.min },
  submitWord: { fontSize: 19 },
});
