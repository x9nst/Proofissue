import { describe, expect, it } from 'vitest';

import { BoundedOutputCollector, decodeBoundedOutput } from './index.js';

const encoder = new TextEncoder();

describe('decodeBoundedOutput', () => {
  it('joins process-read chunks before decoding multibyte text', () => {
    const bytes = encoder.encode('A🙂B');
    const result = decodeBoundedOutput([bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)], 64);

    expect(result.decoded_text).toBe('A🙂B');
    expect(result.had_decoding_replacement).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('replaces invalid UTF-8 and records decoding metadata', () => {
    const result = decodeBoundedOutput([Uint8Array.from([0x61, 0xff, 0x62])], 64);

    expect(result.decoded_text).toBe('a�b');
    expect(result.had_decoding_replacement).toBe(true);
  });

  it('applies the limit to raw bytes and marks a split code point', () => {
    const bytes = encoder.encode('🙂tail');
    const result = decodeBoundedOutput([bytes], 3);

    expect(result).toMatchObject({
      decoded_text: '�',
      discarded_bytes: bytes.byteLength - 3,
      had_decoding_replacement: true,
      retained_bytes: 3,
      total_bytes: bytes.byteLength,
      truncated: true,
    });
  });

  it('omits a leading UTF-8 byte-order mark', () => {
    const result = decodeBoundedOutput([Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])], 64);

    expect(result.decoded_text).toBe('a');
  });

  it('produces identical results for different read chunking', () => {
    const bytes = encoder.encode('same output');

    expect(decodeBoundedOutput([bytes], 64)).toEqual(
      decodeBoundedOutput([bytes.slice(0, 1), bytes.slice(1, 5), bytes.slice(5)], 64),
    );
  });

  it('counts discarded bytes while retaining only the configured prefix', () => {
    const result = decodeBoundedOutput([encoder.encode('1234'), encoder.encode('5678')], 5);

    expect(result).toMatchObject({
      decoded_text: '12345',
      discarded_bytes: 3,
      retained_bytes: 5,
      total_bytes: 8,
      truncated: true,
    });
  });
});

describe('BoundedOutputCollector', () => {
  it('retains bounded bytes while continuing to count drained output', () => {
    const collector = new BoundedOutputCollector(4);
    collector.add(Buffer.from('ab'));
    collector.add(Buffer.from('cdef'));

    expect(collector.finish()).toEqual({
      decoded_text: 'abcd',
      discarded_bytes: 2,
      had_decoding_replacement: false,
      retained_bytes: 4,
      total_bytes: 6,
      truncated: true,
    });
  });
});
