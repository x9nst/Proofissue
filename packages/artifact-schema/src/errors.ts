export type ArtifactValidationErrorCode =
  | 'input_too_large'
  | 'malformed_yaml'
  | 'restricted_yaml'
  | 'schema_violation'
  | 'semantic_violation'
  | 'unsupported_artifact_version'
  | 'unsafe_input_file'
  | 'atomic_write_failed';

export interface ArtifactValidationError {
  readonly code: ArtifactValidationErrorCode;
  readonly message: string;
  readonly path?: string;
}

const isUnsafeControl = (character: string): boolean => {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 8 ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159)
  );
};

export const safeText = (value: string, maximum = 1024): string =>
  Array.from(value)
    .map((character) => (isUnsafeControl(character) ? '\uFFFD' : character))
    .slice(0, maximum)
    .join('');

export const boundedErrors = (
  errors: readonly ArtifactValidationError[],
): readonly ArtifactValidationError[] => {
  const bounded: ArtifactValidationError[] = [];
  let messageCharacters = 0;

  for (const error of errors) {
    if (bounded.length >= 50 || messageCharacters >= 32 * 1024) break;
    const remaining = 32 * 1024 - messageCharacters;
    const message = safeText(error.message, Math.min(1024, remaining));
    const path = error.path === undefined ? undefined : safeText(error.path, 512);
    bounded.push(
      path === undefined ? { code: error.code, message } : { code: error.code, message, path },
    );
    messageCharacters += message.length;
  }

  return bounded;
};
