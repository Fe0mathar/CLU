/** Encoding and byte offsets shared by compiler reads and verified source slices. */

import { isUtf8 } from 'node:buffer';

export interface SourceTextLayout {
  readonly encoding: 'utf8' | 'utf16le' | 'utf16be';
  readonly bomBytes: number;
}

export function sourceTextLayout(bytes: Buffer): SourceTextLayout {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf16be', bomBytes: 2 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf16le', bomBytes: 2 };
  const bomBytes = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return { encoding: 'utf8', bomBytes };
}

export function decodeSourceByteRange(
  bytes: Buffer,
  layout: SourceTextLayout,
  start = layout.bomBytes,
  end = bytes.length,
): string {
  const range = bytes.subarray(Math.max(start, layout.bomBytes), end);
  if (layout.encoding === 'utf8') {
    if (!isUtf8(range)) throw new Error('Invalid UTF-8 source bytes');
    return range.toString('utf8');
  }
  if (range.length % 2 !== 0 || start % 2 !== 0) throw new Error('Unaligned UTF-16 source bytes');
  return layout.encoding === 'utf16be'
    ? Buffer.from(range).swap16().toString('utf16le')
    : range.toString('utf16le');
}
