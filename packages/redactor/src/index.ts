export type RedactionCategory =
  'api_key' | 'authorization_header' | 'password' | 'private_key' | 'sensitive_environment';

export interface RedactionFinding {
  readonly category: RedactionCategory;
  readonly replacement: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly RedactionFinding[];
}

export interface Redactor {
  redact(text: string): RedactionResult;
}
