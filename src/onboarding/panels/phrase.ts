/**
 * The user's 12-word identity.
 *
 * TODO(identity): wire real generation. Per the identity spec this should be a
 * BIP39 mnemonic generated on-device from 128 bits of local entropy
 * (@scure/bip39), with an ed25519 keypair derived from it (@noble/curves,
 * SLIP-0010) and the private key held in Android Keystore / encrypted MMKV.
 * Neither dependency is installed yet — this placeholder lets the onboarding UI
 * be built and reviewed against the real layout in the meantime.
 */
export const PLACEHOLDER_PHRASE: readonly string[] = [
  'cinder',
  'ripple',
  'marble',
  'anthem',
  'willow',
  'quartz',
  'meadow',
  'cipher',
  'lantern',
  'ferry',
  'chorus',
  'ember',
];
