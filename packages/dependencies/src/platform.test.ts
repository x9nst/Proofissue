import { describe, expect, it } from 'vitest';

import { appliesToPlatform, REPLAY_PLATFORM } from './platform.js';

describe('appliesToPlatform', () => {
  it('targets Linux on x86-64 with glibc', () => {
    expect(REPLAY_PLATFORM).toEqual({ cpu: 'x64', libc: 'glibc', os: 'linux' });
  });

  it.each([
    ['no restrictions', {}],
    ['empty lists', { os: [], cpu: [], libc: [] }],
    ['a lone any', { os: ['any'], cpu: ['any'], libc: ['any'] }],
    ['the exact platform', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }],
    ['a list containing the platform', { os: ['darwin', 'linux'], cpu: ['arm64', 'x64'] }],
    ['an exclusion of another platform', { os: ['!win32'], cpu: ['!arm64'] }],
    ['several exclusions that miss it', { os: ['!win32', '!darwin'] }],
    ['only the libc restricted to glibc', { libc: ['glibc'] }],
  ])('accepts %s', (_name, restrictions) => {
    expect(appliesToPlatform(restrictions)).toBe(true);
  });

  it.each([
    ['another operating system', { os: ['darwin'] }],
    ['several other operating systems', { os: ['darwin', 'win32'] }],
    ['an exclusion of linux', { os: ['!linux'] }],
    ['another cpu', { cpu: ['arm64'] }],
    ['an exclusion of x64', { cpu: ['!x64'] }],
    ['musl only', { libc: ['musl'] }],
    ['an exclusion of glibc', { libc: ['!glibc'] }],
    ['the right os but the wrong cpu', { os: ['linux'], cpu: ['arm'] }],
    ['the right cpu but the wrong os', { os: ['win32'], cpu: ['x64'] }],
    ['an exclusion that beats a matching inclusion', { os: ['linux', '!linux'] }],
  ])('rejects %s', (_name, restrictions) => {
    expect(appliesToPlatform(restrictions)).toBe(false);
  });

  it('can target another platform', () => {
    const darwin = { cpu: 'arm64', libc: 'glibc', os: 'darwin' };

    expect(appliesToPlatform({ os: ['darwin'], cpu: ['arm64'] }, darwin)).toBe(true);
    expect(appliesToPlatform({ os: ['linux'] }, darwin)).toBe(false);
  });

  it('selects only the Linux x64 glibc binary from a typical set of platform packages', () => {
    const packages = [
      { name: '@esbuild/linux-x64', os: ['linux'], cpu: ['x64'] },
      { name: '@esbuild/linux-arm64', os: ['linux'], cpu: ['arm64'] },
      { name: '@esbuild/darwin-x64', os: ['darwin'], cpu: ['x64'] },
      { name: '@esbuild/win32-x64', os: ['win32'], cpu: ['x64'] },
      { name: '@rollup/rollup-linux-x64-gnu', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
      { name: '@rollup/rollup-linux-x64-musl', os: ['linux'], cpu: ['x64'], libc: ['musl'] },
      { name: 'fsevents', os: ['darwin'] },
      { name: 'plain-js-package' },
    ];

    expect(packages.filter((item) => appliesToPlatform(item)).map((item) => item.name)).toEqual([
      '@esbuild/linux-x64',
      '@rollup/rollup-linux-x64-gnu',
      'plain-js-package',
    ]);
  });
});
