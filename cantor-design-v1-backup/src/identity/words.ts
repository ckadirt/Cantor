/**
 * Identity wordlist: 256 words → 8 bits per word → 16 words = 128 bits,
 * the same entropy as a 12-word BIP39 phrase. No account, no password;
 * the phrase seeds a local keypair for future sharing features.
 *
 * PROTOTYPE ONLY:
 * - Math.random() is NOT cryptographically secure. Before the phrase
 *   becomes a real identity, swap in react-native-get-random-values (or
 *   entropy from the native module) and derive the keypair (Ed25519).
 * - The words are then a secret: render the ceremony screen with
 *   FLAG_SECURE so it can't be screenshotted or recorded.
 */
const RAW = `
acid amber anchor apple arch arrow ash aspen atlas atom august aurora autumn avid axis azure
badge basil beacon bell birch bison blade blaze bloom bolt border bough box brass brook bud
cabin cactus camp canal candle canyon cape carbon cedar chalk charm chart cliff cloud clover coral
dawn deck delta dew dial diamond dome door dove draft dream drift drum dune dusk dust
eagle earth ebony echo edge elder elm ember emerald engine epoch ether evening event evergreen exile
fable falcon fauna feather fern field fig fjord flame flint flora fog forest forge fossil fox
garden gate gem geode giant ginger glacier glade glass glen globe gold gorge grain granite grove
hail harbor harvest hawk hazel heath hedge helm herb heron hill hollow honey horizon hour hush
ice idol igloo index indigo inlet ink inn iris iron island isle ivory ivy ibis icon
jade jasper jet journey juniper karst keel kelp kettle key kiln king kite knoll krill kudos
lagoon lake lantern larch lark laurel lava leaf ledge lemon lens lily lime linen lion loom
maple marble marsh mask meadow mesa mica mint mist monolith moon moss moth mount mule myrrh
nectar nest night north noble nova oak oasis ocean olive onyx opal orbit orchid otter owl
palm paper peak pearl pebble pine pipe plain plum pond poplar port prairie prism pulse pyre
quarry quartz quill rain raven reed reef ridge rift river robin rock root rose rune rye
sage salt sand shell shore silver sky slate snow spark spring star stone storm summit sun
`;

export const WORDLIST: string[] = RAW.trim().split(/\s+/);

if (WORDLIST.length !== 256) {
  throw new Error(`wordlist must have 256 words, has ${WORDLIST.length}`);
}

export function generatePhrase(): string[] {
  // TODO(identity): secure entropy + checksum word before this ships.
  return Array.from({ length: 16 }, () => WORDLIST[Math.floor(Math.random() * 256)]);
}
