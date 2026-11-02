/* eslint-disable no-bitwise */
/**
 * Padded base64 for bytes that cross the native boundary.
 *
 * Every chunk of a transfer passes through here several times, on the thread
 * that also draws the app. `@scure/base` converts bit by bit through arrays,
 * which Hermes, with no JIT, turns into hundreds of milliseconds per 64 KiB on a
 * phone. These loops are table lookups over typed arrays. Canonical form is
 * still enforced: an input this refuses never reaches the secure channel.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = 61;
const INVALID = 255;
/** `String.fromCharCode` takes its arguments on the stack. */
const STRING_SLICE = 0x3000;

const ENCODE = new Uint8Array(64);
const DECODE = new Uint8Array(256).fill(INVALID);
for (let index = 0; index < ALPHABET.length; index += 1) {
  ENCODE[index] = ALPHABET.charCodeAt(index);
  DECODE[ALPHABET.charCodeAt(index)] = index;
}

export function encodeBase64(bytes: Uint8Array): string {
  const length = bytes.length;
  const output = new Uint8Array(Math.ceil(length / 3) * 4);
  let read = 0;
  let write = 0;
  for (; read + 2 < length; read += 3, write += 4) {
    const word =
      (bytes[read]! << 16) | (bytes[read + 1]! << 8) | bytes[read + 2]!;
    output[write] = ENCODE[word >> 18]!;
    output[write + 1] = ENCODE[(word >> 12) & 63]!;
    output[write + 2] = ENCODE[(word >> 6) & 63]!;
    output[write + 3] = ENCODE[word & 63]!;
  }
  if (read < length) {
    const second = read + 1 < length ? bytes[read + 1]! : 0;
    const word = (bytes[read]! << 16) | (second << 8);
    output[write] = ENCODE[word >> 18]!;
    output[write + 1] = ENCODE[(word >> 12) & 63]!;
    output[write + 2] = read + 1 < length ? ENCODE[(word >> 6) & 63]! : PAD;
    output[write + 3] = PAD;
  }
  const parts: string[] = [];
  for (let start = 0; start < output.length; start += STRING_SLICE) {
    parts.push(
      String.fromCharCode.apply(
        null,
        output.subarray(start, start + STRING_SLICE) as unknown as number[],
      ),
    );
  }
  return parts.join('');
}

export function decodeBase64(text: string): Uint8Array {
  const length = text.length;
  if (length % 4 !== 0) throw new Error('Base64 is not canonical.');
  if (length === 0) return new Uint8Array(0);
  const padding =
    text.charCodeAt(length - 1) !== PAD
      ? 0
      : text.charCodeAt(length - 2) === PAD
      ? 2
      : 1;
  const output = new Uint8Array((length / 4) * 3 - padding);
  const whole = padding === 0 ? length : length - 4;
  let write = 0;
  let seen = 0;
  for (let read = 0; read < whole; read += 4, write += 3) {
    const a = DECODE[text.charCodeAt(read)]!;
    const b = DECODE[text.charCodeAt(read + 1)]!;
    const c = DECODE[text.charCodeAt(read + 2)]!;
    const d = DECODE[text.charCodeAt(read + 3)]!;
    seen |= a | b | c | d;
    output[write] = (a << 2) | (b >> 4);
    output[write + 1] = (b << 4) | (c >> 2);
    output[write + 2] = (c << 6) | d;
  }
  if (padding !== 0) {
    const a = DECODE[text.charCodeAt(whole)]!;
    const b = DECODE[text.charCodeAt(whole + 1)]!;
    const c = padding === 1 ? DECODE[text.charCodeAt(whole + 2)]! : 0;
    seen |= a | b | c;
    output[write] = (a << 2) | (b >> 4);
    if (padding === 1) output[write + 1] = (b << 4) | (c >> 2);
    // Canonical form: the bits padding stands in for are zero.
    if ((padding === 1 ? c & 3 : b & 15) !== 0) seen = INVALID;
  }
  // Valid digits are below 64, so any invalid one sets the top bits.
  if (seen >= 64) throw new Error('Base64 is not canonical.');
  return output;
}
