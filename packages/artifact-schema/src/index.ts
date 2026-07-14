export const ARTIFACT_VERSION = 1 as const;
export const ARTIFACT_SCHEMA_STABILITY = 'provisional' as const;

export type ArtifactVersion = typeof ARTIFACT_VERSION;

declare const validatedArtifactBrand: unique symbol;

export interface ValidatedArtifactReference {
  readonly version: ArtifactVersion;
  readonly digest: string;
  readonly [validatedArtifactBrand]: true;
}
