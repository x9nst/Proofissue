export const ARTIFACT_VERSION = 1 as const;
export const ARTIFACT_SCHEMA_STABILITY = 'provisional' as const;

export type ArtifactVersion = typeof ARTIFACT_VERSION;

export interface ArtifactEnvironmentV1 {
  readonly runtime: 'node';
  readonly runtime_version: string;
  readonly operating_system: 'linux';
  readonly image: string;
}

export interface ArtifactCaptureV1 {
  readonly host_operating_system: 'darwin' | 'linux' | 'win32';
  readonly host_architecture: string;
  readonly node_version: string;
}

export interface ArtifactCommandV1 {
  readonly program: 'node';
  readonly arguments: readonly string[];
  readonly working_directory: '.';
}

export type ArtifactFileRoleV1 = 'reproduction' | 'subject';

export interface ArtifactFileV1 {
  readonly path: string;
  readonly role: ArtifactFileRoleV1;
  readonly encoding: 'utf8';
  readonly content: string;
  readonly sha256: string;
}

export interface ArtifactOutputExpectationV1 {
  readonly mode: 'contains';
  readonly value: string;
}

export interface ArtifactExpectationsV1 {
  readonly exit_code: number;
  readonly stdout: readonly ArtifactOutputExpectationV1[];
  readonly stderr: readonly ArtifactOutputExpectationV1[];
}

export interface ArtifactLimitsV1 {
  readonly timeout_seconds: number;
  readonly memory_mb: number;
  readonly cpus: number;
  readonly processes: number;
  readonly output_bytes_per_stream: number;
}

export type RedactionCategoryV1 =
  'api_key' | 'authorization_header' | 'password' | 'private_key' | 'sensitive_environment';

export interface ArtifactRedactionFindingV1 {
  readonly category: RedactionCategoryV1;
  readonly target: string;
  readonly replacement: string;
}

export interface ArtifactRedactionV1 {
  readonly enabled: true;
  readonly findings: readonly ArtifactRedactionFindingV1[];
}

export interface ArtifactV1 {
  readonly version: ArtifactVersion;
  readonly environment: ArtifactEnvironmentV1;
  readonly capture: ArtifactCaptureV1;
  readonly command: ArtifactCommandV1;
  readonly files: readonly ArtifactFileV1[];
  readonly expect: ArtifactExpectationsV1;
  readonly limits: ArtifactLimitsV1;
  readonly redaction: ArtifactRedactionV1;
}

export interface ValidatedArtifactReference {
  readonly version: ArtifactVersion;
  readonly digest: string;
  readonly validated: true;
}

export type ValidatedArtifactV1 = ArtifactV1 & ValidatedArtifactReference;
