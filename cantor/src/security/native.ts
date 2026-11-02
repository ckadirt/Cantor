import { DeviceEventEmitter, NativeModules } from 'react-native';
import { base64 } from '@scure/base';

/** Everything a download needs that JS holds; the bytes never come here. */
export type NativeDownload = {
  songId: string;
  transferId: string;
  nodeKey: string;
  digest: string;
  offset: number;
  byteLength: number;
  chunkBytes: number;
  protocolVersion: number;
};

/** A file to send from `offset`, with the upload the node opened for it. */
export type NativeUpload = {
  uploadId: string;
  path: string;
  offset: number;
  byteLength: number;
  chunkBytes: number;
  protocolVersion: number;
  /** The node reads raw slices (`NodeFeatures.binary_uploads`). */
  binary: boolean;
};

type NativeSecureModule = {
  begin: (
    sessionId: string,
    remotePublicKey: string,
    encodedPrologue: string,
  ) => string;
  finish: (sessionId: string, encodedMessage: string) => boolean;
  destroy: (sessionId: string) => boolean;
  connect: (linkId: number, url: string) => void;
  sendText: (linkId: number, text: string) => void;
  disconnect: (linkId: number, code: number, reason: string) => void;
  attach: (linkId: number, sessionId: string) => boolean;
  send: (linkId: number, sessionId: string, json: string) => void;
  download: (
    linkId: number,
    options: NativeDownload & { transfer: number },
  ) => Promise<null>;
  upload: (
    linkId: number,
    options: NativeUpload & { transfer: number },
  ) => Promise<null>;
};

type LinkEvent = {
  link: number;
  kind: string;
  data?: string;
  code?: number;
  transfer?: number;
  bytes?: number;
};

export type SecureChannel = {
  begin: (remotePublicKey: string, prologue: Uint8Array) => string;
  finish: (encodedMessage: string) => void;
  /** Bind to the socket that carries it; its frames stop reaching JS. */
  attach: (linkId: number | null) => void;
  send: (json: string) => void;
  download: (
    options: NativeDownload,
    onProgress: (bytes: number) => void,
  ) => Promise<void>;
  upload: (
    options: NativeUpload,
    onProgress: (bytes: number) => void,
  ) => Promise<void>;
  destroy: () => void;
};

export type SecureChannelFactory = (sessionId: string) => SecureChannel;

const EVENT_NAME = 'CantorRelay';

function secureModule(): NativeSecureModule | undefined {
  return NativeModules.CantorSecure as NativeSecureModule | undefined;
}

/** Whether sockets can live natively; false under Jest and on other platforms. */
export function hasNativeLink(): boolean {
  return secureModule()?.connect !== undefined;
}

let nextLinkId = 0;
let nextTransfer = 0;
const progressListeners = new Map<number, (bytes: number) => void>();

/** The relay socket, kept in native so a transfer's bytes never come to JS. */
export class NativeLink {
  readonly id: number;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private readonly native: NativeSecureModule;
  private readonly subscription: { remove: () => void };

  constructor(url: string) {
    const native = secureModule();
    if (native === undefined) {
      throw new Error('Secure transport is unavailable on this platform.');
    }
    this.native = native;
    nextLinkId += 1;
    this.id = nextLinkId;
    this.subscription = DeviceEventEmitter.addListener(
      EVENT_NAME,
      (event: LinkEvent) => {
        if (event.link === this.id) this.handle(event);
      },
    );
    native.connect(this.id, url);
  }

  private handle(event: LinkEvent): void {
    switch (event.kind) {
      case 'open':
        this.readyState = 1;
        this.onopen?.();
        return;
      case 'text':
        this.onmessage?.({ data: event.data });
        return;
      case 'secure':
        this.onmessage?.({ data: { secure: event.data } });
        return;
      case 'secureFailure':
        this.onmessage?.({ data: { secureFailure: event.data } });
        return;
      case 'progress':
        if (event.transfer !== undefined && event.bytes !== undefined) {
          progressListeners.get(event.transfer)?.(event.bytes);
        }
        return;
      case 'closed':
        this.readyState = 3;
        this.subscription.remove();
        this.onclose?.({ code: event.code ?? 1006, reason: event.data ?? '' });
    }
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.native.sendText(this.id, data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 2;
    this.native.disconnect(this.id, code, reason);
    this.readyState = 3;
    this.subscription.remove();
    this.onclose?.({ code, reason });
  }
}

async function transfer(
  onProgress: (bytes: number) => void,
  run: (key: number) => Promise<null>,
): Promise<void> {
  nextTransfer += 1;
  const key = nextTransfer;
  progressListeners.set(key, onProgress);
  try {
    await run(key);
  } finally {
    progressListeners.delete(key);
  }
}

export const createNativeSecureChannel: SecureChannelFactory = sessionId => {
  const native = secureModule();
  if (native === undefined) {
    throw new Error('Secure transport is unavailable on this platform.');
  }
  let destroyed = false;
  let linkId: number | null = null;
  const live = () => {
    if (destroyed) throw new Error('Secure transport is closed.');
    return native;
  };
  const link = () => {
    if (linkId === null) throw new Error('Secure transport has no socket.');
    return linkId;
  };
  return {
    begin: (remotePublicKey, prologue) =>
      live().begin(sessionId, remotePublicKey, base64.encode(prologue)),
    finish: encodedMessage => {
      if (!live().finish(sessionId, encodedMessage)) {
        throw new Error('Secure handshake did not finish.');
      }
    },
    attach: id => {
      linkId = id;
      if (!live().attach(link(), sessionId)) {
        throw new Error('Secure transport did not attach.');
      }
    },
    send: json => live().send(link(), sessionId, json),
    download: (options, onProgress) =>
      transfer(onProgress, key =>
        live().download(link(), { ...options, transfer: key }),
      ),
    upload: (options, onProgress) =>
      transfer(onProgress, key =>
        live().upload(link(), { ...options, transfer: key }),
      ),
    destroy: () => {
      if (!destroyed) {
        destroyed = true;
        native.destroy(sessionId);
      }
    },
  };
};
