export type RecorderErrorCode =
  | 'command_failed'
  | 'invalid_request'
  | 'invalid_utf8'
  | 'redaction_failed'
  | 'timeout'
  | 'unsafe_file'
  | 'unsafe_project';

export class RecorderError extends Error {
  readonly code: RecorderErrorCode;

  constructor(code: RecorderErrorCode, message: string) {
    super(message);
    this.name = 'RecorderError';
    this.code = code;
  }
}
