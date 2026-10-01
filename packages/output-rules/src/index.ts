export type { NormalizationChange, OutputNormalizationRule } from '@proofissue/contracts';
export {
  DEFAULT_OUTPUT_NORMALIZATION,
  NORMALIZATION_TOKENS,
  OUTPUT_NORMALIZATION_RULES,
  isCanonicalNormalizationRuleList,
  normalizeOutput,
} from './normalize.js';
export type { NormalizedOutput } from './normalize.js';
export {
  EMPTY_OUTPUT_PATH_CONTEXT,
  containsContextPath,
  createOutputPathContext,
} from './path-context.js';
export type {
  OutputPathContext,
  OutputPathContextInput,
  OutputPathForm,
  OutputPathPlatform,
  OutputPathToken,
} from './path-context.js';
