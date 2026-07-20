import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Body, Button, Eyebrow, Screen } from '../components/ui';
import { CantorSet } from '../components/CantorSet';
import { generatePhrase } from '../identity/words';
import { useSongs } from '../state/songs';
import { color, font, radius, space, type } from '../theme/tokens';
import type { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

/**
 * The identity ceremony. Sixteen words are minted on this phone and shown
 * once as a 4×4 grid; accepting them is the whole sign-up. No account,
 * no password, nothing leaves the device.
 */
export function OnboardingScreen({ navigation }: Props) {
  const { setIdentity } = useSongs();
  const [words, setWords] = useState<string[]>(generatePhrase);

  const accept = () => {
    setIdentity(words);
    navigation.reset({ index: 0, routes: [{ name: 'Library' }] });
  };

  return (
    <Screen>
      <View style={styles.top}>
        <Text style={styles.wordmark}>Cantor</Text>
        <Body dim style={{ marginTop: space.xs }}>
          Infinite songs, made on this phone.
        </Body>
      </View>

      <CantorSet height={60} />

      <View style={styles.ceremony}>
        <Eyebrow>your sixteen words</Eyebrow>
        <Body dim style={{ marginBottom: space.md }}>
          These words are your identity — for keeping your songs yours and,
          later, for sharing them. No account, no password. They exist only
          here, so write them down somewhere safe.
        </Body>
        <View style={styles.grid}>
          {words.map((w, i) => (
            <View key={i} style={styles.cell}>
              <Text style={styles.cellIndex}>{String(i + 1).padStart(2, '0')}</Text>
              <Text style={styles.cellWord}>{w}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.actions}>
        <Button kind="ghost" label="Draw new words" onPress={() => setWords(generatePhrase())} />
        <Button label="These are my words" onPress={accept} style={{ marginTop: space.sm }} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { marginBottom: space.xl },
  wordmark: {
    ...type.wordmark,
    color: color.chalk,
  },
  ceremony: { flex: 1, marginTop: space.xl },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  cell: {
    width: '25%',
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderColor: color.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cellIndex: {
    fontFamily: font.mono,
    fontSize: 9,
    color: color.faint,
  },
  cellWord: {
    ...type.mono,
    color: color.chalk,
    marginTop: 2,
  },
  actions: { marginTop: space.lg },
});
