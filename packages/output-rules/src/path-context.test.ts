import { pathToFileURL } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_OUTPUT_PATH_CONTEXT,
  containsContextPath,
  createOutputPathContext,
  normalizeOutput,
} from './index.js';
import type { OutputPathContext } from './index.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 5;

const BACKSLASH = String.fromCharCode(92);
const DOUBLE_BACKSLASH = `${BACKSLASH}${BACKSLASH}`;

const paths = (text: string, context: OutputPathContext) =>
  normalizeOutput(text, ['paths'], context);

const posix = createOutputPathContext({
  platform: 'posix',
  project_roots: ['/srv/project'],
  temporary_roots: ['/tmp'],
});

const windows = createOutputPathContext({
  platform: 'win32',
  project_roots: ['D:\\src\\project'],
  temporary_roots: ['C:\\Windows\\temp'],
  declared_paths: ['test/reproduction.mjs', 'src/lib/math.mjs', 'package.json'],
});

const replay = createOutputPathContext({
  platform: 'posix',
  project_roots: ['/workspace'],
  temporary_roots: ['/tmp'],
});

describe('paths rule with posix roots', () => {
  it('replaces posix project and temporary roots and their file URLs', () => {
    const text = [
      'at /srv/project/test/a.mjs:3:9',
      'at file:///srv/project/test/a.mjs:3:9',
      'wrote /tmp/out.txt',
      'at file:///tmp/out.txt',
    ].join('\n');

    expect(paths(text, posix)).toEqual({
      text: [
        'at <project>/test/a.mjs:3:9',
        'at <project>/test/a.mjs:3:9',
        'wrote <tmp>/out.txt',
        'at <tmp>/out.txt',
      ].join('\n'),
      changes: [{ rule: 'paths', count: 4 }],
    });
  });

  it('replaces a root that is the whole path', () => {
    expect(paths('cwd=/srv/project', posix).text).toBe('cwd=<project>');
    expect(paths("'/srv/project'", posix).text).toBe("'<project>'");
    expect(paths('(/srv/project/a.js:1:2)', posix).text).toBe('(<project>/a.js:1:2)');
  });

  it('normalizes tail separators after a root to forward slashes', () => {
    expect(paths(`/srv/project${BACKSLASH}a${BACKSLASH}b.js:1:2`, posix).text).toBe(
      '<project>/a/b.js:1:2',
    );
    expect(paths(`/srv/project${DOUBLE_BACKSLASH}a${DOUBLE_BACKSLASH}b.js`, posix).text).toBe(
      '<project>/a/b.js',
    );
  });

  it('stops the tail at characters that cannot be part of a plain file name', () => {
    expect(paths('/srv/project/a b.js', posix).text).toBe('<project>/a b.js');
    expect(paths('/srv/project/dir/file.js:12:3)', posix).text).toBe('<project>/dir/file.js:12:3)');
    expect(paths('/srv/project/a.js,/srv/project/b.js', posix).text).toBe(
      '<project>/a.js,<project>/b.js',
    );
  });

  it('prefers the longest root so a project inside the temporary directory becomes <project>', () => {
    const nested = createOutputPathContext({
      platform: 'posix',
      project_roots: ['/tmp/work/project'],
      temporary_roots: ['/tmp'],
    });

    expect(paths('/tmp/work/project/a.js and /tmp/other/b.js and /tmp/work', nested).text).toBe(
      '<project>/a.js and <tmp>/other/b.js and <tmp>/work',
    );
  });

  it('lets the project token win when both kinds name the same directory', () => {
    const same = createOutputPathContext({
      platform: 'posix',
      project_roots: ['/srv/same'],
      temporary_roots: ['/srv/same'],
    });

    expect(paths('/srv/same/x', same).text).toBe('<project>/x');
  });

  it.each([
    ['a longer sibling', '/srv/project2/a.js'],
    ['a longer name with a dot', '/srv/project.bak/a.js'],
    ['a longer name with a dash', '/srv/project-copy/a.js'],
    ['a deeper prefix', '/data/srv/project/a.js'],
    ['a name that ends with the root', 'x/srv/project/a.js'],
    ['a prefix of the root', '/srv/projec/a.js'],
    ['the replay root', '/workspace/a.js'],
    ['a longer temporary name', '/tmpfiles/x'],
    ['the temporary root inside a word', 'data/tmp/x'],
  ])('does not replace a root inside %s', (_name, text) => {
    expect(paths(text, posix)).toEqual({ text, changes: [] });
  });

  it('does not replace a root after a closing angle bracket, so the rule chain stays idempotent', () => {
    const text = '<duration>/srv/project/a.js';

    expect(paths(text, posix)).toEqual({ text, changes: [] });
  });

  it('does nothing without roots', () => {
    const text = 'at /srv/project/a.js';

    expect(paths(text, EMPTY_OUTPUT_PATH_CONTEXT)).toEqual({ text, changes: [] });
  });
});

describe('paths rule with win32 roots', () => {
  it.each([
    ['native', 'D:\\src\\project\\test\\a.mjs:3:9'],
    ['lowercase drive', 'd:\\src\\project\\test\\a.mjs:3:9'],
    ['escaped, as printed by util.inspect and TAP', 'D:\\\\src\\\\project\\\\test\\\\a.mjs:3:9'],
    ['forward slashes', 'D:/src/project/test/a.mjs:3:9'],
    ['lowercase drive with forward slashes', 'd:/src/project/test/a.mjs:3:9'],
    ['file URL', 'file:///D:/src/project/test/a.mjs:3:9'],
    ['file URL with a lowercase drive', 'file:///d:/src/project/test/a.mjs:3:9'],
  ])('replaces the %s spelling of the project root', (_name, text) => {
    expect(paths(`at ${text}`, windows)).toEqual({
      text: 'at <project>/test/a.mjs:3:9',
      changes: [{ rule: 'paths', count: 1 }],
    });
  });

  it('replaces every spelling of the temporary directory', () => {
    for (const spelling of [
      'C:\\Windows\\temp\\x.txt',
      'C:\\\\Windows\\\\temp\\\\x.txt',
      'C:/Windows/temp/x.txt',
      'file:///C:/Windows/temp/x.txt',
    ]) {
      expect(paths(spelling, windows).text).toBe('<tmp>/x.txt');
    }
  });

  it('keeps the exact spelling of the root when the root is given with forward slashes', () => {
    const forward = createOutputPathContext({
      platform: 'win32',
      project_roots: ['D:/src/project/'],
      temporary_roots: [],
    });

    expect(paths('D:\\src\\project\\a.js', forward).text).toBe('<project>/a.js');
  });

  it('encodes the root the way a file URL does', () => {
    const spaced = createOutputPathContext({
      platform: 'win32',
      project_roots: ['D:\\my files\\project'],
      temporary_roots: [],
    });
    const url = pathToFileURL('D:\\my files\\project\\a.mjs', { windows: true }).href;

    expect(url).toBe('file:///D:/my%20files/project/a.mjs');
    expect(paths(`at ${url}:1:1`, spaced).text).toBe('at <project>/a.mjs:1:1');
    expect(paths('at D:\\my files\\project\\a.mjs:1:1', spaced).text).toBe(
      'at <project>/a.mjs:1:1',
    );
  });

  it.each([
    ['a longer sibling', 'D:\\src\\project2\\a'],
    ['another drive', 'E:\\src\\project\\a'],
    ['a deeper prefix', 'D:\\data\\src\\project\\a'],
    ['a different root', 'D:\\src\\other\\a'],
  ])('does not replace a root inside %s', (_name, text) => {
    expect(paths(text, windows)).toEqual({ text, changes: [] });
  });

  it('converts declared relative paths printed with backslashes on win32', () => {
    expect(paths('test at test\\reproduction.mjs:1:1', windows)).toEqual({
      text: 'test at test/reproduction.mjs:1:1',
      changes: [{ rule: 'paths', count: 1 }],
    });
    expect(paths('{ file: "src\\\\lib\\\\math.mjs" }', windows).text).toBe(
      '{ file: "src/lib/math.mjs" }',
    );
  });

  it('only converts the declared paths, not other relative paths or longer names', () => {
    for (const text of [
      'node_modules\\left-pad\\index.js',
      'other\\test\\reproduction.mjs',
      'test\\reproduction.mjs.bak',
      'test\\reproduction.mjs2',
      'xtest\\reproduction.mjs',
    ]) {
      expect(paths(text, windows)).toEqual({ text, changes: [] });
    }
  });

  it('does not rewrite declared backslash spellings for a posix context', () => {
    const declaredOnPosix = createOutputPathContext({
      platform: 'posix',
      project_roots: [],
      temporary_roots: [],
      declared_paths: ['test/reproduction.mjs'],
    });
    const text = 'test\\reproduction.mjs';

    expect(paths(text, declaredOnPosix)).toEqual({ text, changes: [] });
  });
});

describe('ignored roots', () => {
  const forms = (context: OutputPathContext): number => context.forms.length;

  it('ignores filesystem roots, relative roots, long roots, and control characters', () => {
    expect(
      forms(
        createOutputPathContext({
          platform: 'posix',
          project_roots: [
            '/',
            '//',
            '',
            'relative/dir',
            './here',
            'C:\\src',
            `/srv/${'a'.repeat(1025)}`,
            '/srv/bad\nname',
            '/srv/bad\u007fname',
          ],
          temporary_roots: ['/tmp\u0000'],
        }),
      ),
    ).toBe(0);
    expect(
      forms(
        createOutputPathContext({
          platform: 'win32',
          project_roots: [
            'C:\\',
            'C:/',
            'C:',
            'D:src',
            '\\\\server\\share',
            '\\\\?\\D:\\src',
            '/srv/project',
            `D:\\${'a'.repeat(1025)}`,
            'D:\\bad\tname',
          ],
          temporary_roots: [],
        }),
      ),
    ).toBe(0);
  });

  it('keeps a valid root among invalid ones', () => {
    const context = createOutputPathContext({
      platform: 'posix',
      project_roots: ['/', '/srv/project'],
      temporary_roots: [],
    });

    expect(paths('/srv/project/a /x', context).text).toBe('<project>/a /x');
  });

  it('treats text that merely resembles a root as ordinary text', () => {
    const text = 'Use / and C:\\ and D: here';

    expect(paths(text, posix)).toEqual({ text, changes: [] });
    expect(paths(text, windows)).toEqual({ text, changes: [] });
  });
});

describe('containsContextPath', () => {
  it('finds every form of a root', () => {
    for (const text of [
      'D:\\src\\project\\a.js',
      'D:\\\\src\\\\project\\\\a.js',
      'D:/src/project/a.js',
      'file:///D:/src/project/a.js',
      'at (d:\\src\\project)',
    ]) {
      expect(containsContextPath(text, windows)).toBe(true);
    }
    for (const text of ['/srv/project/a.js', 'file:///srv/project/a.js', 'cwd=/tmp']) {
      expect(containsContextPath(text, posix)).toBe(true);
    }
  });

  it('does not report names that only resemble a root, tokens, or an empty context', () => {
    expect(containsContextPath('/srv/project2/a.js', posix)).toBe(false);
    expect(containsContextPath('<project>/a.js and <tmp>', posix)).toBe(false);
    expect(containsContextPath('/srv/project', EMPTY_OUTPUT_PATH_CONTEXT)).toBe(false);
    expect(containsContextPath('', posix)).toBe(false);
  });

  it('can be called repeatedly with the same answer', () => {
    const text = 'at /srv/project/a.js';

    expect([1, 2, 3].map(() => containsContextPath(text, posix))).toEqual([true, true, true]);
  });
});

// A project-relative path as a program prints it: segments of plain file-name characters.
const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}(?:\.[a-z]{1,3})?$/u);
const tail = fc.array(segment, { minLength: 1, maxLength: 4 });

describe('record and replay agree', () => {
  const recordings: readonly {
    readonly context: OutputPathContext;
    readonly root: string;
    readonly spellings: readonly ((parts: readonly string[]) => string)[];
  }[] = [
    {
      root: 'D:\\src\\project',
      context: createOutputPathContext({
        platform: 'win32',
        project_roots: ['D:\\src\\project'],
        temporary_roots: [],
      }),
      spellings: [
        (parts) => `D:\\src\\project\\${parts.join('\\')}`,
        (parts) => `D:\\\\src\\\\project\\\\${parts.join('\\\\')}`,
        (parts) => `D:/src/project/${parts.join('/')}`,
        (parts) => `file:///D:/src/project/${parts.join('/')}`,
        (parts) => `d:\\src\\project\\${parts.join('\\')}`,
      ],
    },
    {
      root: '/opt/dev/project',
      context: createOutputPathContext({
        platform: 'posix',
        project_roots: ['/opt/dev/project'],
        temporary_roots: [],
      }),
      spellings: [
        (parts) => `/opt/dev/project/${parts.join('/')}`,
        (parts) => `file:///opt/dev/project/${parts.join('/')}`,
      ],
    },
  ];
  const wrappers: readonly ((location: string) => string)[] = [
    (location) => `at ${location}:3:9`,
    (location) => `(${location}:3:9)`,
    (location) => `'${location}:3:9'`,
    (location) => `"${location}"`,
    (location) => location,
  ];

  it(
    'record and replay spellings of the same project location normalize identically',
    () => {
      fc.assert(
        fc.property(
          tail,
          fc.integer({ min: 0, max: wrappers.length - 1 }),
          fc.integer({ min: 0, max: recordings.length - 1 }),
          fc.nat({ max: 10 }),
          (parts, wrapperIndex, recordingIndex, spellingSeed) => {
            const recording = recordings[recordingIndex];
            const wrapper = wrappers[wrapperIndex];
            if (recording === undefined || wrapper === undefined) throw new Error('bad index');
            const spelling = recording.spellings[spellingSeed % recording.spellings.length];
            if (spelling === undefined) throw new Error('bad index');
            const recorded = paths(wrapper(spelling(parts)), recording.context).text;
            const replayed = paths(wrapper(`/workspace/${parts.join('/')}`), replay).text;
            const replayedUrl = paths(wrapper(`file:///workspace/${parts.join('/')}`), replay).text;

            expect(recorded).toBe(replayed);
            expect(recorded).toBe(replayedUrl);
            expect(recorded).toContain(`<project>/${parts.join('/')}`);
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'a declared relative path normalizes the same with backslashes and forward slashes',
    () => {
      fc.assert(
        fc.property(
          tail.filter((parts) => parts.length >= 2),
          (parts) => {
            const declared = parts.join('/');
            const context = createOutputPathContext({
              platform: 'win32',
              project_roots: [],
              temporary_roots: [],
              declared_paths: [declared],
            });
            for (const spelling of [parts.join('\\'), parts.join('\\\\'), declared]) {
              expect(paths(`at ${spelling}:1:1`, context).text).toBe(`at ${declared}:1:1`);
            }
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
