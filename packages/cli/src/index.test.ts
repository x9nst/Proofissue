import { describe, expect, it } from 'vitest';

import { createCliAdapter } from './index.js';

describe('CLI application boundary', () => {
  it('exports the adapter factory', () => {
    expect(createCliAdapter).toBeTypeOf('function');
  });
});
