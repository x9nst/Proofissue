import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LOCAL_PATH_PATTERN_SOURCE,
  createScrubber,
  escapeForLog,
  findLocalPath,
  scrubValue,
} from './scrub.js';

const BACKSLASH = String.fromCharCode(92);

// Samples are assembled at runtime so that no committed file contains a local-path literal.
const posixHome = ['', 'home', 'runner'].join('/');
const macHome = ['', 'Users', 'alice'].join('/');
const windowsHome = ['C:', 'Users', 'alice'].join(BACKSLASH);

describe('createScrubber', () => {
  it('replaces the work, runner-temp, workspace and home roots, longest first', () => {
    const scrub = createScrubber([
      { path: '/mnt/ci/temp', token: '<runner-temp>' },
      { path: '/mnt/ci/temp/trials/work', token: '<work>' },
      { path: '/mnt/ci/checkout', token: '<workspace>' },
      { path: `${posixHome}/runner-home`, token: '<home>' },
    ]);

    expect(
      scrub(
        'at /mnt/ci/temp/trials/work/N1/repo/a.js and /mnt/ci/temp/other, ' +
          `/mnt/ci/checkout/b.js, ${posixHome}/runner-home/.cache`,
      ),
    ).toBe('at <work>/N1/repo/a.js and <runner-temp>/other, <workspace>/b.js, <home>/.cache');
  });

  it('replaces a root only as a whole path component', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work', token: '<work>' }]);

    expect(scrub('/mnt/ci/workspace/x')).toBe('/mnt/ci/workspace/x');
    expect(scrub('a/mnt/ci/work/x')).toBe('a/mnt/ci/work/x');
    expect(scrub('/mnt/ci/work-old/x')).toBe('/mnt/ci/work-old/x');
    expect(scrub('/mnt/ci/work/x')).toBe('<work>/x');
    expect(scrub('in "/mnt/ci/work"')).toBe('in "<work>"');
    expect(scrub('see /mnt/ci/work.')).toBe('see <work>.');
    expect(scrub('/mnt/ci/work.log')).toBe('/mnt/ci/work.log');
  });

  it('ignores a trailing separator on a root', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work/', token: '<work>' }]);

    expect(scrub('/mnt/ci/work/N1')).toBe('<work>/N1');
  });

  it('falls back to <home> for unknown home and Users paths, including Windows drives', () => {
    const scrub = createScrubber([]);

    expect(scrub(`${posixHome}/project/file.js`)).toBe('<home>/project/file.js');
    expect(scrub(`${macHome}/project/file.js`)).toBe('<home>/project/file.js');
    expect(scrub(`${windowsHome}${BACKSLASH}project`)).toBe(`<home>${BACKSLASH}project`);
  });

  it('leaves relative paths and https URLs unchanged', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work', token: '<work>' }]);
    const unchanged = [
      'lib/addressparser/index.js',
      'test/spf/macro-test.js',
      'https://github.com/nodemailer/nodemailer.git',
      'https://registry.npmjs.org/chai/-/chai-4.4.1.tgz',
    ];

    for (const text of unchanged) expect(scrub(text)).toBe(text);
  });

  it('ignores filesystem-root, relative, over-long and control-character roots', () => {
    const scrub = createScrubber([
      { path: '/', token: '<root>' },
      { path: `C:${BACKSLASH}`, token: '<drive>' },
      { path: 'relative/dir', token: '<relative>' },
      { path: undefined, token: '<undefined>' },
      { path: '', token: '<empty>' },
      { path: `/mnt/${'a'.repeat(1025)}`, token: '<long>' },
      { path: `/mnt/bad${String.fromCharCode(10)}dir`, token: '<control>' },
    ]);
    const text = `/usr/bin relative/dir C:${BACKSLASH}tools /mnt/${'a'.repeat(1025)}`;

    expect(scrub(text)).toBe(text);
  });

  it('applies the fallback after the roots, so nothing the check rejects survives', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work', token: '<work>' }]);
    const output = scrub(`${posixHome}/x ${macHome}/y /mnt/ci/work/z ${windowsHome}${BACKSLASH}q`);

    expect(findLocalPath(output)).toBe(false);
  });
});

describe('scrubValue', () => {
  it('scrubs nested objects and arrays without changing keys', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work', token: '<work>' }]);
    const input = {
      '/mnt/ci/work': 'key stays',
      list: ['/mnt/ci/work/a', { deep: '/mnt/ci/work/b', count: 3, flag: true, none: null }],
      text: 'ok',
    };

    expect(scrubValue(input, scrub)).toEqual({
      '/mnt/ci/work': 'key stays',
      list: ['<work>/a', { deep: '<work>/b', count: 3, flag: true, none: null }],
      text: 'ok',
    });
  });

  it('does not modify its input', () => {
    const scrub = createScrubber([{ path: '/mnt/ci/work', token: '<work>' }]);
    const input = { path: '/mnt/ci/work/a' };

    scrubValue(input, scrub);

    expect(input.path).toBe('/mnt/ci/work/a');
  });
});

describe('findLocalPath', () => {
  it('flags home, Users and Windows Users paths', () => {
    expect(findLocalPath(`error in ${posixHome}/work/file.js`)).toBe(true);
    expect(findLocalPath(`error in ${macHome}/work/file.js`)).toBe(true);
    expect(findLocalPath(`error in ${windowsHome}${BACKSLASH}file.js`)).toBe(true);
  });

  it('does not flag other absolute paths or relative text', () => {
    expect(findLocalPath('/mnt/ci/work/file.js')).toBe(false);
    expect(findLocalPath('home/runner')).toBe(false);
    expect(findLocalPath('/home')).toBe(false);
  });

  it('uses the same pattern as the repository hygiene check', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../scripts/check-repository-hygiene.mjs', import.meta.url)),
      'utf8',
    );
    const start = script.indexOf('/(?:[A-Za-z]:');
    const end = script.indexOf('/u.test(content)', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(LOCAL_PATH_PATTERN_SOURCE).toBe(new RegExp(script.slice(start + 1, end), 'u').source);

    const hygiene = new RegExp(script.slice(start + 1, end), 'u');
    const samples = [
      `${posixHome}/a`,
      `${macHome}/a`,
      `${windowsHome}${BACKSLASH}a`,
      '/mnt/ci/a',
      ['x', 'home', 'y'].join('/'),
      '/Users',
      ['D:', 'Users', 'a'].join('/'),
    ];
    for (const sample of samples) expect(findLocalPath(sample)).toBe(hygiene.test(sample));
  });
});

describe('escapeForLog', () => {
  it('neutralizes workflow commands', () => {
    const escaped = escapeForLog('::set-output name=x::y ::add-mask::value ::stop-commands::t');

    expect(escaped).not.toContain('::');
    expect(escaped).toContain(`${BACKSLASH}:${BACKSLASH}:set-output`);
  });

  it('escapes control characters and bidirectional controls', () => {
    const input = [
      'a',
      String.fromCharCode(10),
      String.fromCharCode(13),
      String.fromCharCode(27),
      String.fromCharCode(0x202e),
      String.fromCharCode(0x2066),
      String.fromCharCode(127),
      String.fromCharCode(0x85),
      'b',
    ].join('');
    const escaped = escapeForLog(input);

    expect(escaped).toBe(
      ['a', '000a', '000d', '001b', '202e', '2066', '007f', '0085']
        .map((part, index) => (index === 0 ? part : `${BACKSLASH}u{${part}}`))
        .join('') + 'b',
    );
    for (const character of escaped) {
      const code = character.codePointAt(0) ?? 0;
      expect(code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f)).toBe(true);
    }
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeForLog('N1 snapshot reproduced 5/5 in 12.4 s')).toBe(
      'N1 snapshot reproduced 5/5 in 12.4 s',
    );
  });
});
