import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hasDuplicateJsonKeys } from './duplicate-keys.js';
import { validateNpmLockfile } from './index.js';

describe('hasDuplicateJsonKeys', () => {
  it.each([
    ['a repeated top-level key', '{"a":1,"a":2}'],
    ['a repeated nested key', '{"x":{"a":1,"a":2}}'],
    ['a repeat after other keys', '{"a":1,"b":2,"c":3,"a":4}'],
    ['a repeat inside an array of objects', '[{"a":1},{"b":1,"b":2}]'],
    ['keys equal after decoding an escape', String.raw`{"a":1,"\u0061":2}`],
    ['keys equal when the first is escaped', String.raw`{"\u0061":1,"a":2}`],
    ['keys equal when both are escaped', String.raw`{"\u0061":1,"\u0061":2}`],
    ['keys equal after decoding a quote escape', '{"a\\"b":1,"a\\"b":2}'],
    ['a repeat whose first value is an object', '{"a":{"x":1},"a":2}'],
    ['a repeat after an empty object value', '{"a":{},"a":1}'],
  ])('finds %s', (_name, text) => {
    expect(hasDuplicateJsonKeys(text)).toBe(true);
  });

  it.each([
    ['no keys', '{}'],
    ['an array', '[1,2,3]'],
    ['the same key in different objects', '{"a":{"x":1},"b":{"x":2}}'],
    ['the same key in sibling array objects', '[{"a":1},{"a":2}]'],
    ['key-like text inside a string value', '{"a":"\\"b\\":1,\\"b\\":2","b":3}'],
    ['braces and commas inside strings', '{"a{":1,"b,":2,"}":3,"]":4}'],
    ['an escaped backslash before a quote', '{"a\\\\":1,"b":2}'],
    ['a value equal to an earlier key', '{"a":"b","b":"a"}'],
    ['repeated string values in an array', '["x","x","x"]'],
    ['repeated string values in an array inside an object', '{"a":["x","x"],"b":["x","x"]}'],
    ['repeated scalars after an object in an array', '[{"a":1},"a","a",1,1]'],
  ])('allows %s', (_name, text) => {
    expect(hasDuplicateJsonKeys(text)).toBe(false);
  });

  it('agrees with an independent check on generated JSON objects', () => {
    const key = fc.constantFrom('a', 'b', 'c', 'd');
    fc.assert(
      fc.property(fc.array(fc.tuple(key, fc.nat({ max: 9 })), { maxLength: 8 }), (pairs) => {
        const text = `{${pairs.map(([k, v]) => `"${k}":${String(v)}`).join(',')}}`;
        const unique = new Set(pairs.map(([k]) => k)).size === pairs.length;

        expect(hasDuplicateJsonKeys(text)).toBe(!unique);
      }),
      { numRuns: 500 },
    );
  });

  it('is linear on a large input', () => {
    const text = `{${Array.from({ length: 50_000 }, (_, index) => `"k${String(index)}":${String(index)}`).join(',')}}`;
    const started = performance.now();

    expect(hasDuplicateJsonKeys(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.each(['{"a', '{"a":"unterminated', '{"a\\', '{"a":1,"b'])(
    'stops on malformed text instead of looping: %j',
    (text) => {
      expect(hasDuplicateJsonKeys(text)).toBe(false);
    },
  );

  it('handles very deep nesting without recursion', () => {
    expect(hasDuplicateJsonKeys(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)).toBe(false);
  });
});

describe('lockfile duplicate keys', () => {
  const resolved = 'https://registry.npmjs.org/a/-/a-1.0.0.tgz';
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const good = `{"version":"1.0.0","resolved":"${resolved}","integrity":"${integrity}"}`;

  it.each([
    [
      'a repeated package location',
      `{"lockfileVersion":3,"packages":{"node_modules/a":${good},"node_modules/a":${good}}}`,
    ],
    [
      'a repeated field inside an entry',
      `{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"1.0.0","resolved":"https://example.test/x.tgz","resolved":"${resolved}","integrity":"${integrity}"}}}`,
    ],
    ['a repeated lockfile version', `{"lockfileVersion":2,"lockfileVersion":3,"packages":{}}`],
    ['a repeated packages object', `{"lockfileVersion":3,"packages":{},"packages":{}}`],
  ])('rejects %s', (_name, text) => {
    expect(validateNpmLockfile(text)).toEqual({
      ok: false,
      errors: [{ code: 'duplicate_key', message: expect.any(String) as string }],
    });
  });

  it('accepts the same lockfile when no key repeats', () => {
    const text = `{"lockfileVersion":3,"packages":{"node_modules/a":${good}}}`;

    expect(validateNpmLockfile(text).ok).toBe(true);
  });
});
