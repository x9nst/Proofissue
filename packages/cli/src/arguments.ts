export const takeStoreValue = (arguments_: readonly string[], index: number): string => {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error('--dependency-store requires a directory.');
  return value;
};

export interface ParsedArtifactCommand {
  readonly against_path?: string;
  readonly artifact_path: string;
  readonly dependency_store?: string;
  readonly json: boolean;
  readonly required_status?: 'not_reproduced' | 'reproduced';
}

export const parseArtifactCommand = (
  arguments_: readonly string[],
  allowRequiredStatus: boolean,
): ParsedArtifactCommand => {
  const artifactPath = arguments_[0];
  if (artifactPath === undefined || artifactPath.startsWith('--'))
    throw new Error('An artifact path is required.');
  let json = false;
  let againstPath: string | undefined;
  let dependencyStore: string | undefined;
  let requiredStatus: ParsedArtifactCommand['required_status'];
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--require-status' && allowRequiredStatus) {
      const value = arguments_[index + 1];
      if (value !== 'reproduced' && value !== 'not_reproduced')
        throw new Error('--require-status must be reproduced or not_reproduced.');
      requiredStatus = value;
      index += 1;
      continue;
    }
    if (argument === '--against' && allowRequiredStatus) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--against requires a checkout directory.');
      againstPath = value;
      index += 1;
      continue;
    }
    if (argument === '--dependency-store' && allowRequiredStatus) {
      dependencyStore = takeStoreValue(arguments_, index);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? ''}`);
  }
  return {
    artifact_path: artifactPath,
    json,
    ...(dependencyStore === undefined ? {} : { dependency_store: dependencyStore }),
    ...(againstPath === undefined ? {} : { against_path: againstPath }),
    ...(requiredStatus === undefined ? {} : { required_status: requiredStatus }),
  };
};
