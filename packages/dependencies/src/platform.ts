import type { PlatformRestrictions } from './lockfile.js';

/** The platform packages are installed for: the approved replay image. */
export interface TargetPlatform {
  readonly cpu: string;
  readonly libc: string;
  readonly os: string;
}

/** Linux on x86-64 with glibc, which is the approved Node.js Debian image. */
export const REPLAY_PLATFORM: TargetPlatform = Object.freeze({
  cpu: 'x64',
  libc: 'glibc',
  os: 'linux',
});

// npm's notation: a list of bare values allows only those, a value starting with "!"
// excludes that value, and a lone "any" or an empty list allows everything.
const allows = (list: readonly string[] | undefined, value: string): boolean => {
  if (list === undefined || list.length === 0) return true;
  if (list.length === 1 && list[0] === 'any') return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((item) => !item.startsWith('!'));
  return allowed.length === 0 || allowed.includes(value);
};

/**
 * Whether a package's `os`, `cpu`, and `libc` restrictions permit the target platform.
 * Used to avoid downloading, for example, a binary for every operating system.
 */
export const appliesToPlatform = (
  restrictions: PlatformRestrictions,
  platform: TargetPlatform = REPLAY_PLATFORM,
): boolean =>
  allows(restrictions.os, platform.os) &&
  allows(restrictions.cpu, platform.cpu) &&
  allows(restrictions.libc, platform.libc);
