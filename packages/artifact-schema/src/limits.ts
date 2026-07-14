export const ARTIFACT_LIMITS = Object.freeze({
  input_bytes: 5 * 1024 * 1024,
  yaml_documents: 1,
  yaml_depth: 32,
  yaml_nodes: 10_000,
  scalar_bytes: 1024 * 1024,
  validation_errors: 50,
  error_message_characters: 1024,
  aggregate_error_message_characters: 32 * 1024,
  retained_error_paths: 100,
  retained_error_path_characters: 512,
  files: 100,
  total_file_content_bytes: 4 * 1024 * 1024,
  findings: 100,
  output_expectations: 16,
} as const);

export const REDACTION_REPLACEMENT_PATTERN =
  '^\\[REDACTED:(api_key|authorization_header|password|private_key|sensitive_environment)\\]$';

export const ARTIFACT_PATH_PATTERN = '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$';
