import { base64 as reference } from '@scure/base';
import { decodeBase64, encodeBase64 } from '../base64';

describe('base64', () => {
  it('agrees with the reference at every length around a slice boundary', () => {
    for (const size of [0, 1, 2, 3, 4, 5, 255, 9215, 9216, 9217, 65_536]) {
      const bytes = Uint8Array.from(
        { length: size },
        (_, i) => (i * 31 + 7) % 256,
      );
      const text = encodeBase64(bytes);
      expect(text).toBe(reference.encode(bytes));
      expect(Array.from(decodeBase64(text))).toEqual(Array.from(bytes));
    }
  });

  it('refuses anything that is not canonical', () => {
    for (const text of [
      'A',
      'AAA',
      'A===',
      'AA=A',
      'AB==',
      'AAB=',
      'AA A',
      'AA-_',
      '====',
    ]) {
      expect(() => decodeBase64(text)).toThrow('not canonical');
    }
  });
});
