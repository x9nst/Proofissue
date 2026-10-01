import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LOCKFILE_LIMITS,
  REGISTRY_ORIGIN,
  validateNpmLockfile,
  type LockfileErrorCode,
} from './index.js';

// A well-formed SHA-512 integrity string: 64 bytes is 88 base64 characters ending in `==`.
const integrity = (fill = 'A'): string => `sha512-${fill.repeat(86)}==`;

const tarball = (name: string, version: string): string => {
  const base = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
  return `${REGISTRY_ORIGIN}/${name}/-/${base}-${version}.tgz`;
};

type Entry = Record<string, unknown>;

const without = (source: Entry, key: string): Entry =>
  Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));

const entry = (name: string, version = '1.0.0', extra: Entry = {}): Entry => ({
  version,
  resolved: tarball(name, version),
  integrity: integrity(),
  ...extra,
});

const lockfile = (packages: Record<string, Entry>, overrides: Entry = {}): string =>
  JSON.stringify({
    name: 'synthetic',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'synthetic', version: '1.0.0' }, ...packages },
    ...overrides,
  });

const errorCodes = (text: string): readonly LockfileErrorCode[] => {
  const result = validateNpmLockfile(text);
  return result.ok ? [] : result.errors.map((error) => error.code);
};

describe('accepted lockfiles', () => {
  it('accepts a lockfile that lists only the project', () => {
    expect(validateNpmLockfile(lockfile({}))).toEqual({ ok: true, packages: [], warnings: [] });
  });

  it('returns each package with its name, version, address, and integrity', () => {
    const result = validateNpmLockfile(lockfile({ 'node_modules/left-pad': entry('left-pad') }));

    expect(result).toEqual({
      ok: true,
      packages: [
        {
          has_install_script: false,
          integrity: integrity(),
          name: 'left-pad',
          package_path: 'node_modules/left-pad',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
          version: '1.0.0',
        },
      ],
      warnings: [],
    });
  });

  it('accepts scoped packages, prereleases, legacy upper-case names, and nested installs', () => {
    const result = validateNpmLockfile(
      lockfile({
        'node_modules/@scope/pkg': entry('@scope/pkg', '2.3.4-beta.1'),
        'node_modules/JSONStream': entry('JSONStream', '1.3.5'),
        'node_modules/a': entry('a'),
        'node_modules/a/node_modules/b': entry('b', '0.1.0'),
        'node_modules/a/node_modules/@s/c': entry('@s/c', '3.0.0'),
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.packages).toHaveLength(5);
  });

  it('uses the aliased name for the tarball address, not the install name', () => {
    const result = validateNpmLockfile(
      lockfile({ 'node_modules/alias': entry('real-name', '1.2.3', { name: 'real-name' }) }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.packages[0]?.name).toBe('real-name');
  });

  it('warns that install scripts are not run, without rejecting', () => {
    const result = validateNpmLockfile(
      lockfile({ 'node_modules/native': entry('native', '1.0.0', { hasInstallScript: true }) }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packages[0]?.has_install_script).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'install_script_not_run',
          message: expect.any(String) as string,
          package_path: 'node_modules/native',
        },
      ]);
    }
  });

  it('returns the same packages in the same order however the keys are ordered', () => {
    const first = validateNpmLockfile(
      lockfile({ 'node_modules/b': entry('b'), 'node_modules/a': entry('a') }),
    );
    const second = validateNpmLockfile(
      lockfile({ 'node_modules/a': entry('a'), 'node_modules/b': entry('b') }),
    );

    expect(first).toEqual(second);
    if (first.ok) {
      expect(first.packages.map((item) => item.package_path)).toEqual([
        'node_modules/a',
        'node_modules/b',
      ]);
    }
  });

  it('ignores fields it does not need', () => {
    const result = validateNpmLockfile(
      lockfile({
        'node_modules/x': entry('x', '1.0.0', {
          dev: true,
          license: 'MIT',
          dependencies: { y: '^1.0.0' },
          engines: { node: '>=18' },
        }),
      }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('structure and version', () => {
  it.each([
    ['text that is not JSON', 'not json', 'malformed_json'],
    ['an empty string', '', 'malformed_json'],
    ['a JSON array', '[]', 'invalid_structure'],
    ['a JSON string', '"x"', 'invalid_structure'],
    ['JSON null', 'null', 'invalid_structure'],
    [
      'lockfile version 1',
      JSON.stringify({ lockfileVersion: 1, packages: {} }),
      'unsupported_lockfile_version',
    ],
    [
      'lockfile version 2',
      JSON.stringify({ lockfileVersion: 2, packages: {} }),
      'unsupported_lockfile_version',
    ],
    [
      'lockfile version 4',
      JSON.stringify({ lockfileVersion: 4, packages: {} }),
      'unsupported_lockfile_version',
    ],
    [
      'a string lockfile version',
      JSON.stringify({ lockfileVersion: '3', packages: {} }),
      'unsupported_lockfile_version',
    ],
    ['a missing packages object', JSON.stringify({ lockfileVersion: 3 }), 'invalid_structure'],
    ['a packages array', JSON.stringify({ lockfileVersion: 3, packages: [] }), 'invalid_structure'],
    [
      'a packages string',
      JSON.stringify({ lockfileVersion: 3, packages: 'x' }),
      'invalid_structure',
    ],
  ] as const)('rejects %s', (_name, text, code) => {
    expect(errorCodes(text)).toEqual([code]);
  });

  it('rejects input over the size limit before parsing it', () => {
    expect(errorCodes(`{"pad":"${'x'.repeat(LOCKFILE_LIMITS.bytes)}"}`)).toEqual(['too_large']);
  });

  it('rejects a lockfile with more packages than the limit', () => {
    const packages: Record<string, Entry> = {};
    for (let index = 0; index <= LOCKFILE_LIMITS.packages; index += 1) {
      packages[`node_modules/p${String(index)}`] = entry(`p${String(index)}`);
    }

    expect(errorCodes(lockfile(packages))).toEqual(['too_many_packages']);
  });

  it('rejects a package entry that is not an object', () => {
    expect(errorCodes(lockfile({ 'node_modules/a': 'x' as unknown as Entry }))).toEqual([
      'invalid_structure',
    ]);
    expect(errorCodes(lockfile({ 'node_modules/a': null as unknown as Entry }))).toEqual([
      'invalid_structure',
    ]);
  });
});

describe('package locations', () => {
  it.each([
    '../escape',
    'node_modules/../escape',
    'node_modules/a/../b',
    'node_modules/..',
    'node_modules/.',
    'node_modules/a/.',
    'node_modules\\a',
    'node_modules/a\\b',
    '/node_modules/a',
    'C:/node_modules/a',
    'node_modules/',
    'node_modules//a',
    'node_modules/a/',
    'node_modules/a//node_modules/b',
    'src/a',
    'a',
    'node_modules/.bin',
    'node_modules/.hidden',
    'node_modules/_private',
    'node_modules/a b',
    'node_modules/a\u0000b',
    'node_modules/a\nb',
    'node_modules/@scope',
    'node_modules/@/name',
    'node_modules/@scope/',
    'node_modules/@scope/a/b',
    'node_modules/a/node_modules',
    'node_modules/a/node_modules/',
    '__proto__',
    'constructor',
    'node_modules/__proto__x/../../..',
    `node_modules/${'a'.repeat(215)}`,
  ])('rejects the location %j', (key) => {
    const text = lockfile({ [key]: entry('a') });

    expect(errorCodes(text)).toEqual(['unsafe_package_path']);
  });

  it('rejects an own __proto__ key without polluting anything', () => {
    const text = `{"lockfileVersion":3,"packages":{"__proto__":{"version":"1.0.0"}}}`;

    expect(errorCodes(text)).toEqual(['unsafe_package_path']);
    expect(({} as Record<string, unknown>).version).toBeUndefined();
  });

  it('does not echo an unbounded location back in the error', () => {
    const result = validateNpmLockfile(lockfile({ [`../${'x'.repeat(5000)}`]: entry('a') }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.package_path?.length).toBeLessThanOrEqual(200);
  });

  it('rejects an alias that is not a valid package name', () => {
    expect(
      errorCodes(lockfile({ 'node_modules/a': entry('a', '1.0.0', { name: '../../x' }) })),
    ).toEqual(['invalid_structure']);
    expect(errorCodes(lockfile({ 'node_modules/a': entry('a', '1.0.0', { name: 5 }) }))).toEqual([
      'invalid_structure',
    ]);
  });
});

describe('sources', () => {
  const withResolved = (resolved: unknown): string =>
    lockfile({ 'node_modules/a': { ...entry('a'), resolved } });

  it.each([
    ['http instead of https', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['another host', 'https://registry.example.test/a/-/a-1.0.0.tgz'],
    ['a look-alike host', 'https://registry.npmjs.org.evil.test/a/-/a-1.0.0.tgz'],
    ['a look-alike prefix', 'https://registry.npmjs.orgx/a/-/a-1.0.0.tgz'],
    ['credentials in the address', 'https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['an explicit port', 'https://registry.npmjs.org:443/a/-/a-1.0.0.tgz'],
    ['an upper-case scheme', 'HTTPS://registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['an upper-case host', 'https://REGISTRY.NPMJS.ORG/a/-/a-1.0.0.tgz'],
    ['a git address', 'git+ssh://git@github.com/user/repo.git#abc123'],
    ['a git https address', 'git+https://github.com/user/repo.git'],
    ['a GitHub shorthand', 'github:user/repo'],
    ['a local file', 'file:../local-package'],
    ['a tarball URL on another site', 'https://example.test/a-1.0.0.tgz'],
    ['a protocol-relative address', '//registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['an empty string', ''],
    ['a number', 5],
    ['an object', { url: 'x' }],
  ])('rejects %s', (_name, resolved) => {
    expect(errorCodes(withResolved(resolved))).toEqual(['unsupported_source']);
  });

  it.each([
    ['a query string', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz?redirect=evil'],
    ['a fragment', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz#evil'],
    ['a trailing slash', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz/'],
    ['a path traversal', 'https://registry.npmjs.org/a/-/../../other/-/a-1.0.0.tgz'],
    ['a different package', 'https://registry.npmjs.org/other/-/other-1.0.0.tgz'],
    ['a different version', 'https://registry.npmjs.org/a/-/a-9.9.9.tgz'],
    ['a different file name', 'https://registry.npmjs.org/a/-/b-1.0.0.tgz'],
    ['a missing tarball segment', 'https://registry.npmjs.org/a/a-1.0.0.tgz'],
    ['an encoded slash', 'https://registry.npmjs.org/a%2f/-/a-1.0.0.tgz'],
  ])('rejects registry addresses with %s as inconsistent', (_name, resolved) => {
    expect(errorCodes(withResolved(resolved))).toEqual(['inconsistent_entry']);
  });

  it('rejects an entry with no address', () => {
    expect(errorCodes(lockfile({ 'node_modules/a': without(entry('a'), 'resolved') }))).toEqual([
      'unsupported_source',
    ]);
  });

  it('rejects a scoped package pointed at an unscoped address', () => {
    const text = lockfile({
      'node_modules/@s/p': { ...entry('@s/p'), resolved: tarball('p', '1.0.0') },
    });

    expect(errorCodes(text)).toEqual(['inconsistent_entry']);
  });

  it.each(['link', 'inBundle'])('rejects an entry marked %s', (flag) => {
    expect(
      errorCodes(lockfile({ 'node_modules/a': entry('a', '1.0.0', { [flag]: true }) })),
    ).toEqual(['unsupported_entry']);
  });

  it.each([
    ['build metadata', '1.0.0+build.5'],
    ['a range', '^1.0.0'],
    ['a tag', 'latest'],
    ['a leading zero', '01.0.0'],
    ['a missing patch', '1.0'],
    ['a path-like value', '1.0.0/../x'],
    ['an empty string', ''],
  ])('rejects a version with %s', (_name, version) => {
    const text = lockfile({
      'node_modules/a': { ...entry('a'), version, resolved: tarball('a', version) },
    });

    expect(errorCodes(text)).toEqual(['invalid_structure']);
  });

  it('rejects a version that is not a string', () => {
    expect(errorCodes(lockfile({ 'node_modules/a': { ...entry('a'), version: 1 } }))).toEqual([
      'invalid_structure',
    ]);
  });
});

describe('integrity', () => {
  const withIntegrity = (value: unknown): string =>
    lockfile({ 'node_modules/a': { ...entry('a'), integrity: value } });

  it('rejects an entry with no integrity hash', () => {
    expect(errorCodes(lockfile({ 'node_modules/a': without(entry('a'), 'integrity') }))).toEqual([
      'missing_integrity',
    ]);
  });

  it.each([
    ['a number', 5],
    ['null', null],
  ])('rejects %s as missing integrity', (_name, value) => {
    expect(errorCodes(withIntegrity(value))).toEqual(['missing_integrity']);
  });

  it.each([
    ['a SHA-1 hash', `sha1-${'A'.repeat(27)}=`],
    ['a SHA-256 hash', `sha256-${'A'.repeat(43)}=`],
    ['a SHA-384 hash', `sha384-${'A'.repeat(64)}`],
    ['a SHA-512 hash that is too short', `sha512-${'A'.repeat(85)}==`],
    ['a SHA-512 hash that is too long', `sha512-${'A'.repeat(87)}==`],
    ['a SHA-512 hash without padding', `sha512-${'A'.repeat(88)}`],
    ['a SHA-512 hash with characters outside base64', `sha512-${'!'.repeat(86)}==`],
    ['a url-safe base64 hash', `sha512-${'-'.repeat(86)}==`],
    ['two hashes', `${integrity()} ${integrity('B')}`],
    ['a weak hash alongside a strong one', `sha1-${'A'.repeat(27)}= ${integrity()}`],
    ['trailing whitespace', `${integrity()} `],
    ['an upper-case algorithm', `SHA512-${'A'.repeat(86)}==`],
    ['an empty string', ''],
  ])('rejects %s', (_name, value) => {
    expect(errorCodes(withIntegrity(value))).toEqual(['weak_integrity']);
  });
});

describe('error reporting', () => {
  it('reports every problem in one pass, up to a bound', () => {
    const packages: Record<string, Entry> = {};
    for (let index = 0; index < 120; index += 1) {
      packages[`node_modules/p${String(index)}`] = { version: '1.0.0' };
    }
    const result = validateNpmLockfile(lockfile(packages));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBe(50);
      expect(result.errors.every((error) => error.code === 'unsupported_source')).toBe(true);
    }
  });

  it('never returns a package list when any entry is rejected', () => {
    const result = validateNpmLockfile(
      lockfile({
        'node_modules/good': entry('good'),
        'node_modules/bad': { ...entry('bad'), resolved: 'https://example.test/bad.tgz' },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('packages');
  });
});

describe('properties', () => {
  const nameSegment = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/u);
  const packageName = fc.oneof(
    nameSegment,
    fc.tuple(nameSegment, nameSegment).map(([scope, name]) => `@${scope}/${name}`),
  );
  const version = fc
    .tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
    .map(([major, minor, patch]) => `${String(major)}.${String(minor)}.${String(patch)}`);

  it('accepts every well-formed lockfile and returns exactly its packages in sorted order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(packageName, version), {
          selector: ([name]) => name,
          maxLength: 40,
        }),
        (items) => {
          const packages: Record<string, Entry> = {};
          for (const [name, itemVersion] of items) {
            packages[`node_modules/${name}`] = entry(name, itemVersion);
          }
          const result = validateNpmLockfile(lockfile(packages));

          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.packages.map((item) => item.package_path)).toEqual(
              Object.keys(packages).sort(),
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never throws and always returns a result for arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.json(), (text) => {
        const result = validateNpmLockfile(text);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('never throws for arbitrary strings, and returns the same result twice', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(validateNpmLockfile(text)).toEqual(validateNpmLockfile(text));
      }),
      { numRuns: 500 },
    );
  });

  it('rejects any package whose address is not the expected registry address', () => {
    fc.assert(
      fc.property(
        packageName,
        version,
        fc.string({ maxLength: 40 }),
        (name, itemVersion, suffix) => {
          fc.pre(suffix !== '');
          const text = lockfile({
            [`node_modules/${name}`]: {
              ...entry(name, itemVersion),
              resolved: `${tarball(name, itemVersion)}${suffix}`,
            },
          });

          expect(validateNpmLockfile(text).ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects any package location that is not a chain of node_modules steps', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (key) => {
        fc.pre(!key.startsWith('node_modules/'));
        fc.pre(key !== '');
        expect(errorCodes(lockfile({ [key]: entry('a') }))).toEqual(['unsafe_package_path']);
      }),
      { numRuns: 300 },
    );
  });
});

describe('performance on adversarial input', () => {
  it.each([
    [
      'many entries',
      () =>
        lockfile(
          Object.fromEntries(
            Array.from({ length: 1900 }, (_, index) => [
              `node_modules/p${String(index)}`,
              entry(`p${String(index)}`),
            ]),
          ),
        ),
    ],
    ['one very long key', () => lockfile({ [`node_modules/${'a'.repeat(900_000)}`]: entry('a') })],
    [
      'deeply nested install paths',
      () => lockfile({ [`node_modules/a${'/node_modules/a'.repeat(30_000)}`]: entry('a') }),
    ],
    [
      'many repeated separators',
      () => lockfile({ [`node_modules/${'/'.repeat(500_000)}`]: entry('a') }),
    ],
    [
      'deeply nested JSON',
      () => `{"lockfileVersion":3,"packages":${'['.repeat(5_000)}${']'.repeat(5_000)}}`,
    ],
  ])('finishes within the budget for %s', (_name, build) => {
    const started = performance.now();
    validateNpmLockfile(build());

    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('platform restrictions', () => {
  const withEntry = (extra: Entry): ReturnType<typeof validateNpmLockfile> =>
    validateNpmLockfile(lockfile({ 'node_modules/a': entry('a', '1.0.0', extra) }));

  it('passes os, cpu, and libc through unchanged', () => {
    const result = withEntry({ os: ['linux'], cpu: ['x64', '!ia32'], libc: ['glibc'] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packages[0]).toMatchObject({
        cpu: ['x64', '!ia32'],
        libc: ['glibc'],
        os: ['linux'],
      });
    }
  });

  it('leaves the fields out entirely when the entry has none', () => {
    const result = withEntry({});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packages[0]).not.toHaveProperty('os');
      expect(result.packages[0]).not.toHaveProperty('cpu');
      expect(result.packages[0]).not.toHaveProperty('libc');
    }
  });

  it.each([
    ['a string instead of a list', { os: 'linux' }],
    ['an object', { os: { linux: true } }],
    ['a number', { cpu: 5 }],
    ['null', { libc: null }],
    ['a non-string item', { os: ['linux', 5] }],
    ['an item with a slash', { os: ['linux/../x'] }],
    ['an item with whitespace', { os: ['lin ux'] }],
    ['an upper-case item', { cpu: ['X64'] }],
    ['an empty item', { cpu: [''] }],
    ['an over-long item', { os: ['a'.repeat(33)] }],
    ['too many items', { os: Array.from({ length: 33 }, () => 'linux') }],
    ['a nested list', { os: [['linux']] }],
  ])('rejects %s', (_name, extra) => {
    expect(errorCodes(lockfile({ 'node_modules/a': entry('a', '1.0.0', extra) }))).toEqual([
      'invalid_structure',
    ]);
  });
});
