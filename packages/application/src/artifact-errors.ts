import type { ProofIssueError } from '@proofissue/contracts';
import type { ArtifactValidationError } from '@proofissue/artifact-schema';

/** Maps an artifact validation failure to the adapter-neutral error shape. */
export const toProofIssueError = (error: ArtifactValidationError): ProofIssueError => ({
  code:
    error.code === 'unsupported_artifact_version'
      ? ('unsupported_artifact_version' as const)
      : error.code === 'schema_violation'
        ? ('schema_violation' as const)
        : error.code === 'semantic_violation'
          ? ('semantic_violation' as const)
          : ('malformed_input' as const),
  message: error.message,
  ...(error.path === undefined ? {} : { details: { path: error.path } }),
});
