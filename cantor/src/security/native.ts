import { NativeModules } from 'react-native';
import { base64 } from '@scure/base';

type NativeSecureModule = {
  begin: (
    sessionId: string,
    remotePublicKey: string,
    encodedPrologue: string,
  ) => string;
  finish: (sessionId: string, encodedMessage: string) => boolean;
  encrypt: (sessionId: string, encodedInner: string) => string;
  decrypt: (sessionId: string, encodedCiphertext: string) => string | null;
  destroy: (sessionId: string) => boolean;
};

export type SecureChannel = {
  begin: (remotePublicKey: string, prologue: Uint8Array) => string;
  finish: (encodedMessage: string) => void;
  encrypt: (inner: Uint8Array) => Uint8Array[];
  decrypt: (ciphertext: Uint8Array) => Uint8Array | null;
  destroy: () => void;
};

export type SecureChannelFactory = (sessionId: string) => SecureChannel;

export const createNativeSecureChannel: SecureChannelFactory = sessionId => {
  const native = NativeModules.CantorSecure as NativeSecureModule | undefined;
  if (native === undefined) {
    throw new Error('Secure transport is unavailable on this platform.');
  }
  let destroyed = false;
  const live = () => {
    if (destroyed) throw new Error('Secure transport is closed.');
    return native;
  };
  return {
    begin: (remotePublicKey, prologue) =>
      live().begin(sessionId, remotePublicKey, base64.encode(prologue)),
    finish: encodedMessage => {
      if (!live().finish(sessionId, encodedMessage)) {
        throw new Error('Secure handshake did not finish.');
      }
    },
    encrypt: inner => {
      const parsed: unknown = JSON.parse(
        live().encrypt(sessionId, base64.encode(inner)),
      );
      if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        !parsed.every(value => typeof value === 'string')
      ) {
        throw new Error('Native secure transport returned invalid ciphertext.');
      }
      return parsed.map(value => base64.decode(value));
    },
    decrypt: ciphertext => {
      const value = live().decrypt(sessionId, base64.encode(ciphertext));
      return value === null ? null : base64.decode(value);
    },
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        native.destroy(sessionId);
      }
    },
  };
};
