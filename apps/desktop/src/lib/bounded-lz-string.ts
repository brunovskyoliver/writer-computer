/**
 * LZString 1.5.0 base64 decompression, adapted to check allocation budgets before
 * constructing strings and to reject truncated input instead of returning null.
 * https://github.com/pieroxy/lz-string/blob/1.5.0/libs/lz-string.js
 *
 * MIT License
 * Copyright (c) 2013 pieroxy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface LzStringLimits {
  outputCharacters: number;
  dictionaryCharacters: number;
  dictionaryEntries: number;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `accept` runs before a decoded chunk is retained, for streaming JSON limits. */
export function decompressBoundedBase64(
  input: string,
  limits: LzStringLimits,
  accept?: (chunk: string) => void,
): string {
  // LZString pads with up to three '=' characters (unlike ordinary base64).
  if (!input || !/^[A-Za-z0-9+/]+={0,3}$/.test(input) || input.length % 4 !== 0) {
    throw new Error("Invalid compressed drawing base64.");
  }
  const end = input.indexOf("=") < 0 ? input.length : input.indexOf("=");
  let bitIndex = 0;
  const readBits = (count: number): number => {
    if (bitIndex + count > end * 6) throw new Error("Truncated compressed drawing.");
    let value = 0;
    for (let bit = 0; bit < count; bit++, bitIndex++) {
      const symbol = alphabet.indexOf(input[Math.floor(bitIndex / 6)]);
      value += ((symbol >> (5 - (bitIndex % 6))) & 1) * 2 ** bit;
    }
    return value;
  };
  const finish = () => {
    // The encoder flushes at most one final six-bit symbol, containing only zero
    // padding. Refuse appended payloads rather than silently decoding a prefix.
    if (end * 6 - bitIndex > 6) throw new Error("Trailing compressed drawing data.");
    while (bitIndex < end * 6) {
      if (readBits(1) !== 0) throw new Error("Invalid compressed drawing padding.");
    }
  };
  const dictionary: string[] = ["", "", ""];
  let dictionaryCharacters = 0;
  const reserveEntry = (length: number) => {
    if (
      dictionary.length >= limits.dictionaryEntries ||
      dictionaryCharacters + length > limits.dictionaryCharacters
    ) {
      throw new Error("Compressed drawing exceeds the dictionary limit.");
    }
    dictionaryCharacters += length;
  };
  let outputCharacters = 0;
  const result: string[] = [];
  const reserveOutput = (length: number) => {
    if (outputCharacters + length > limits.outputCharacters) {
      throw new Error("Drawing exceeds the decoded size limit.");
    }
    outputCharacters += length;
  };
  const append = (chunk: string) => {
    accept?.(chunk);
    result.push(chunk);
  };
  const first = readBits(2);
  if (first === 2) {
    finish();
    return "";
  }
  if (first > 1) throw new Error("Invalid compressed drawing code.");
  reserveEntry(1);
  reserveOutput(1);
  let previous = String.fromCharCode(readBits(first === 0 ? 8 : 16));
  dictionary.push(previous);
  append(previous);
  let enlargeIn = 4;
  let numberOfBits = 3;
  while (true) {
    let code = readBits(numberOfBits);
    if (code === 2) {
      finish();
      return result.join("");
    }
    if (code === 0 || code === 1) {
      reserveEntry(1);
      dictionary.push(String.fromCharCode(readBits(code === 0 ? 8 : 16)));
      code = dictionary.length - 1;
      enlargeIn--;
    }
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numberOfBits;
      numberOfBits++;
    }
    const known = dictionary[code];
    if (!known && code !== dictionary.length) throw new Error("Invalid compressed drawing code.");
    const length = known ? known.length : previous.length + 1;
    reserveOutput(length);
    reserveEntry(previous.length + 1);
    const entry = known || previous + previous.charAt(0);
    append(entry);
    dictionary.push(previous + entry.charAt(0));
    previous = entry;
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numberOfBits;
      numberOfBits++;
    }
  }
}
