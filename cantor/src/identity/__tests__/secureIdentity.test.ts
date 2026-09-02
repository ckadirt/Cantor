import * as Keychain from 'react-native-keychain';
import {
  createAndStoreIdentity,
  loadStoredIdentity,
  loadStoredPhrase,
  restoreIdentity,
} from '../secureIdentity';
import { deriveIdentity } from '../derive';
import { mintPhrase } from '../mnemonic';

const get = Keychain.getGenericPassword as jest.Mock;
const set = Keychain.setGenericPassword as jest.Mock;

/** A keychain that actually remembers, keyed by service like the real one. */
function keychain() {
  const store = new Map<string, { username: string; password: string }>();
  set.mockImplementation(async (username: string, password: string, options) => {
    store.set(options.service, { username, password });
    return { service: options.service, storage: 'mock' };
  });
  get.mockImplementation(async options => store.get(options.service) ?? false);
  return store;
}

beforeEach(() => {
  get.mockReset();
  set.mockReset();
});

const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(
    ' ',
  );

describe('what the phone keeps of an identity', () => {
  it('keeps the words beside the key, in their own entry', () => {
    const store = keychain();

    return createAndStoreIdentity(PHRASE).then(async identity => {
      expect(store.has('com.cantor.app.identity.v1')).toBe(true);
      expect(store.has('com.cantor.app.identity.phrase.v1')).toBe(true);
      // The existing entry is untouched in name and content: an app updated
      // into this code keeps the identity it already had.
      expect(store.get('com.cantor.app.identity.v1')?.username).toBe(
        'cantor-ed25519',
      );
      expect((await loadStoredIdentity())?.publicKey).toBe(identity.publicKey);
      expect(await loadStoredPhrase()).toEqual(PHRASE);
    });
  });

  it('says nothing rather than guessing when only the key was kept', async () => {
    const store = keychain();
    await createAndStoreIdentity(PHRASE);
    // An install from before the phrase was stored: the key is there, the
    // words never were.
    store.delete('com.cantor.app.identity.phrase.v1');

    expect(await loadStoredPhrase()).toBeNull();
    expect(await loadStoredIdentity()).not.toBeNull();
  });

  it('recovers the same public key from the written-down words', async () => {
    keychain();
    const original = await createAndStoreIdentity(PHRASE);

    // A reinstall: nothing is in the keychain any more.
    keychain();
    expect(await loadStoredIdentity()).toBeNull();

    const restored = await restoreIdentity(PHRASE);
    expect(restored.publicKey).toBe(original.publicKey);
    expect((await loadStoredIdentity())?.publicKey).toBe(original.publicKey);
    // Which is the whole point: every node knows this phone by that key.
    expect(restored.publicKey).toBe(deriveIdentity(PHRASE.join(' ')).publicKey);
  });

  it('refuses words that fail their own checksum', async () => {
    keychain();
    const mistyped = [...PHRASE];
    mistyped[11] = 'zebra';

    await expect(restoreIdentity(mistyped)).rejects.toThrow(
      /not a valid identity phrase/,
    );
    await expect(createAndStoreIdentity(mistyped)).rejects.toThrow(
      /not a valid identity phrase/,
    );
    expect(await loadStoredIdentity()).toBeNull();
  });

  it('round-trips a freshly minted phrase', async () => {
    keychain();
    const minted = mintPhrase();

    await createAndStoreIdentity(minted);

    expect(await loadStoredPhrase()).toEqual(minted);
  });

  it('keeps the identity even if the words cannot be stored', async () => {
    const store = keychain();
    set.mockImplementation(async (username: string, password: string, options) => {
      if (options.service === 'com.cantor.app.identity.phrase.v1') return false;
      store.set(options.service, { username, password });
      return { service: options.service, storage: 'mock' };
    });

    // Losing the words costs the words, not the identity.
    await expect(createAndStoreIdentity(PHRASE)).resolves.toBeTruthy();
    expect(await loadStoredIdentity()).not.toBeNull();
    expect(await loadStoredPhrase()).toBeNull();
  });
});
