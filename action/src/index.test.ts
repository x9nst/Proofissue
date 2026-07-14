import { describe, expect, it } from 'vitest';

import { createActionAdapter } from './index.js';

describe('Action application boundary', () => {
  it('exports the adapter factory', () => {
    expect(createActionAdapter).toBeTypeOf('function');
  });
});
