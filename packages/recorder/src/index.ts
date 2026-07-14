import type { ArtifactVersion } from '@proofissue/artifact-schema';
import type { BoundedStreamCapture } from '@proofissue/contracts';
import type { RedactionFinding } from '@proofissue/redactor';

export interface RecordRequest {
  readonly arguments: readonly string[];
  readonly program: 'node';
  readonly project_root: string;
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
  readonly timeout_seconds: number;
}

export interface RecordCapture {
  readonly artifact_version: ArtifactVersion;
  readonly exit_code: number;
  readonly redaction_findings: readonly RedactionFinding[];
  readonly stderr: BoundedStreamCapture;
  readonly stdout: BoundedStreamCapture;
}

export interface Recorder {
  capture(request: RecordRequest): Promise<RecordCapture>;
}
