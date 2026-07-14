import type { AnySchema } from 'ajv';

import { ARTIFACT_PATH_PATTERN, REDACTION_REPLACEMENT_PATTERN } from './limits.js';

const closedObject = (
  properties: Readonly<Record<string, AnySchema>>,
  required: readonly string[],
): AnySchema => ({
  additionalProperties: false,
  properties,
  required,
  type: 'object',
});

const pathSchema: AnySchema = {
  maxLength: 512,
  minLength: 1,
  pattern: ARTIFACT_PATH_PATTERN,
  type: 'string',
};

const expectationSchema = closedObject(
  {
    mode: { const: 'contains' },
    value: { maxLength: 8192, minLength: 1, type: 'string' },
  },
  ['mode', 'value'],
);

const findingSchema = closedObject(
  {
    category: {
      enum: ['api_key', 'authorization_header', 'private_key', 'password', 'sensitive_environment'],
    },
    target: {
      anyOf: [{ enum: ['stdout', 'stderr'] }, pathSchema],
    },
    replacement: {
      maxLength: 128,
      pattern: REDACTION_REPLACEMENT_PATTERN,
      type: 'string',
    },
  },
  ['category', 'target', 'replacement'],
);

export const ARTIFACT_V1_SCHEMA: AnySchema = {
  $id: 'https://proofissue.dev/schema/artifact/v1',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
  properties: {
    version: { const: 1, type: 'integer' },
    environment: closedObject(
      {
        runtime: { const: 'node' },
        runtime_version: { maxLength: 16, pattern: '^[0-9]+$', type: 'string' },
        operating_system: { const: 'linux' },
        image: {
          maxLength: 255,
          pattern: '^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$',
          type: 'string',
        },
      },
      ['runtime', 'runtime_version', 'operating_system', 'image'],
    ),
    capture: closedObject(
      {
        host_operating_system: { enum: ['win32', 'darwin', 'linux'] },
        host_architecture: {
          enum: [
            'arm',
            'arm64',
            'ia32',
            'loong64',
            'mips',
            'mipsel',
            'ppc',
            'ppc64',
            'riscv64',
            's390',
            's390x',
            'x64',
          ],
          maxLength: 32,
          type: 'string',
        },
        node_version: {
          maxLength: 64,
          pattern: '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$',
          type: 'string',
        },
      },
      ['host_operating_system', 'host_architecture', 'node_version'],
    ),
    command: closedObject(
      {
        program: { const: 'node' },
        arguments: {
          items: {
            maxLength: 8192,
            minLength: 1,
            not: { pattern: '[\\u0000-\\u0008\\u000A-\\u001F\\u007F]' },
            type: 'string',
          },
          maxItems: 128,
          minItems: 1,
          type: 'array',
        },
        working_directory: { const: '.' },
      },
      ['program', 'arguments', 'working_directory'],
    ),
    files: {
      items: closedObject(
        {
          path: pathSchema,
          role: { enum: ['reproduction', 'subject'] },
          encoding: { const: 'utf8' },
          content: { type: 'string' },
          sha256: { pattern: '^[a-f0-9]{64}$', type: 'string' },
        },
        ['path', 'role', 'encoding', 'content', 'sha256'],
      ),
      maxItems: 100,
      minItems: 1,
      type: 'array',
    },
    expect: closedObject(
      {
        exit_code: { maximum: 255, minimum: 0, type: 'integer' },
        stdout: { items: expectationSchema, maxItems: 16, type: 'array' },
        stderr: { items: expectationSchema, maxItems: 16, type: 'array' },
      },
      ['exit_code', 'stdout', 'stderr'],
    ),
    limits: closedObject(
      {
        timeout_seconds: { maximum: 300, minimum: 1, type: 'integer' },
        memory_mb: { maximum: 2048, minimum: 64, type: 'integer' },
        cpus: { maximum: 2, minimum: 0.25, multipleOf: 0.25, type: 'number' },
        processes: { maximum: 256, minimum: 8, type: 'integer' },
        output_bytes_per_stream: { maximum: 1_048_576, minimum: 1024, type: 'integer' },
      },
      ['timeout_seconds', 'memory_mb', 'cpus', 'processes', 'output_bytes_per_stream'],
    ),
    redaction: closedObject(
      {
        enabled: { const: true },
        findings: { items: findingSchema, maxItems: 100, type: 'array' },
      },
      ['enabled', 'findings'],
    ),
  },
  required: [
    'version',
    'environment',
    'capture',
    'command',
    'files',
    'expect',
    'limits',
    'redaction',
  ],
  title: 'ProofIssue artifact version 1',
  type: 'object',
};
