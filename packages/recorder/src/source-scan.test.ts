import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_SPECIFIERS, scanRelativeSpecifiers } from './source-scan.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 10;

const specifiersOf = (source: string): readonly string[] =>
  scanRelativeSpecifiers(source).specifiers;

describe('scanRelativeSpecifiers', () => {
  it('finds static, dynamic, require, and re-export specifiers in source order', () => {
    const source = [
      "import fs from 'node:fs';",
      "import { a } from './a.mjs';",
      'import b, * as c from "../b/index.js";',
      "import './side-effect.mjs';",
      "export * from './re-export.mjs';",
      "export { d } from './d.mjs';",
      "const e = await import('./dynamic.mjs');",
      "const f = require('./f.cjs');",
      "const g = import('./with-options.json', { with: { type: 'json' } });",
      "import lodash from 'lodash';",
      "const h = require('./a.mjs');",
    ].join('\n');
    expect(specifiersOf(source)).toEqual([
      './a.mjs',
      '../b/index.js',
      './side-effect.mjs',
      './re-export.mjs',
      './d.mjs',
      './dynamic.mjs',
      './f.cjs',
      './with-options.json',
    ]);
  });

  it('ignores specifiers in comments, strings, and template literals', () => {
    const source = [
      "// import './line-comment.mjs';",
      "/* import './block.mjs'; require('./block2.cjs') */",
      'const text = "import \'./in-string.mjs\'";',
      "const other = 'require(\\'./escaped.cjs\\')';",
      "const template = `import './in-template.mjs' ${require('./inside-expression.cjs')} import './after.mjs'`;",
      "const re = /import .'.\\/in-regex.mjs/;",
      "const member = Array.from('./member.mjs');",
      "import './real.mjs';",
    ].join('\n');
    expect(specifiersOf(source)).toEqual(['./inside-expression.cjs', './real.mjs']);
  });

  it('ignores non-literal dynamic imports', () => {
    const source = [
      'import(name);',
      "import('./' + name);",
      "require('./' + name);",
      'require(`./${name}.js`);',
      "import('./a' + '.mjs');",
      "import('./literal.mjs');",
    ].join('\n');
    expect(specifiersOf(source)).toEqual(['./literal.mjs']);
  });

  it('reports only specifiers that begin with ./ or ../', () => {
    const source = [
      "import './ok.mjs';",
      "import '../ok2.mjs';",
      "import '/absolute.mjs';",
      "import 'package';",
      "import '.hidden';",
      "import '..';",
      "import '.';",
    ].join('\n');
    expect(specifiersOf(source)).toEqual(['./ok.mjs', '../ok2.mjs']);
  });

  it('bounds the number of specifiers and drops duplicates', () => {
    const many = Array.from(
      { length: MAX_SPECIFIERS + 50 },
      (_, i) => `import './m${String(i)}.mjs';`,
    );
    expect(specifiersOf(many.join('\n'))).toHaveLength(MAX_SPECIFIERS);
    expect(specifiersOf("import './a.mjs';\nimport './a.mjs';")).toEqual(['./a.mjs']);
  });

  it('survives unterminated strings, comments, templates, and regular expressions', () => {
    for (const source of [
      "import './a.mjs",
      '/* never closed import "./x.mjs"',
      '`template ${ never closed',
      'const x = /unterminated regex',
      "require('./a.mjs'",
      '}}}}`}',
    ]) {
      expect(() => scanRelativeSpecifiers(source)).not.toThrow();
    }
    expect(specifiersOf("import './a.mjs\nimport './b.mjs';")).toEqual(['./b.mjs']);
  });

  const arbitrarySource = fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.string({ unit: 'grapheme', maxLength: 200 }),
    fc
      .array(
        fc.constantFrom(
          "'",
          '"',
          '`',
          '${',
          '}',
          '{',
          '/',
          '//',
          '/*',
          '*/',
          '\\',
          '\n',
          '(',
          ')',
          'import ',
          'require(',
          'from ',
          "'./a.mjs'",
          '../b',
          ' ',
          'x',
          '[',
          ']',
        ),
        { maxLength: 200 },
      )
      .map((parts) => parts.join('')),
  );

  it(
    'never throws and stays linear on arbitrary input',
    () => {
      fc.assert(
        fc.property(arbitrarySource, (source) => {
          const scan = scanRelativeSpecifiers(source);
          // A fixed multiple of the length, plus a constant: no input makes the scanner rescan.
          expect(scan.steps).toBeLessThanOrEqual(8 * source.length + 16);
          expect(scan.specifiers.length).toBeLessThanOrEqual(MAX_SPECIFIERS);
          for (const specifier of scan.specifiers) {
            expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true);
          }
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it('stays linear on hostile inputs of a million characters', () => {
    const size = 1_000_000;
    const hostile: readonly string[] = [
      '(/'.repeat(size / 2),
      '/['.repeat(size / 2),
      '`${'.repeat(size / 3),
      '/*'.repeat(size / 2),
      "'\\".repeat(size / 2),
      'import('.repeat(size / 7),
      `${'x'.repeat(size - 2)}//`,
    ];
    for (const source of hostile) {
      const scan = scanRelativeSpecifiers(source);
      expect(scan.steps).toBeLessThanOrEqual(8 * source.length + 16);
    }
  });
});
