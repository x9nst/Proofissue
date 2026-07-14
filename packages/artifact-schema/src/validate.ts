import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node, Pair, ParsedNode } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';

import { boundedErrors, type ArtifactValidationError } from './errors.js';
import { sha256 } from './hash.js';
import { ARTIFACT_LIMITS, ARTIFACT_PATH_PATTERN } from './limits.js';
import type { ArtifactV1, ValidatedArtifactV1 } from './model.js';
import { ARTIFACT_V1_SCHEMA } from './schema.js';

export interface ArtifactValidationSuccess {
  readonly ok: true;
  readonly artifact: ValidatedArtifactV1;
}

export interface ArtifactValidationFailure {
  readonly ok: false;
  readonly errors: readonly ArtifactValidationError[];
}

export type ArtifactValidationResult = ArtifactValidationFailure | ArtifactValidationSuccess;

const ajv = new Ajv2020({ allErrors: false, strict: true });
const validateSchema = ajv.compile(ARTIFACT_V1_SCHEMA);
const utf8 = new TextEncoder();
const pathPattern = new RegExp(ARTIFACT_PATH_PATTERN, 'u');

interface YamlCounters {
  nodes: number;
}

class RestrictedYamlError extends Error {
  readonly path?: string;

  constructor(message: string, path?: string) {
    super(message);
    this.name = 'RestrictedYamlError';
    if (path !== undefined) this.path = path;
  }
}

const scalarPathPart = (node: Node | null | undefined): string => {
  if (node !== null && node !== undefined && isScalar(node) && typeof node.value === 'string') {
    return node.value.slice(0, 128);
  }
  return '?';
};

const inspectYamlNode = (
  node: Node | null,
  depth: number,
  path: string,
  counters: YamlCounters,
): void => {
  if (node === null) return;
  counters.nodes += 1;
  if (counters.nodes > ARTIFACT_LIMITS.yaml_nodes) {
    throw new RestrictedYamlError(
      `YAML exceeds the ${String(ARTIFACT_LIMITS.yaml_nodes)} node limit.`,
    );
  }
  if (depth > ARTIFACT_LIMITS.yaml_depth) {
    throw new RestrictedYamlError(
      `YAML exceeds the ${String(ARTIFACT_LIMITS.yaml_depth)} level depth limit.`,
      path,
    );
  }
  if (isAlias(node)) {
    throw new RestrictedYamlError('YAML aliases are not allowed.', path);
  }
  if (node.anchor !== undefined) {
    throw new RestrictedYamlError('YAML anchors are not allowed.', path);
  }
  if (node.tag !== undefined) {
    throw new RestrictedYamlError('Explicit YAML tags are not allowed.', path);
  }
  if (isScalar(node)) {
    const scalarText = typeof node.value === 'string' ? node.value : node.source;
    if (
      scalarText !== undefined &&
      utf8.encode(scalarText).byteLength > ARTIFACT_LIMITS.scalar_bytes
    ) {
      throw new RestrictedYamlError(
        `A YAML scalar exceeds the ${String(ARTIFACT_LIMITS.scalar_bytes)} byte limit.`,
        path,
      );
    }
    return;
  }
  if (isSeq(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      const item = node.items[index];
      if (item !== null && item !== undefined && !isNode(item)) {
        throw new RestrictedYamlError(
          'Only JSON-compatible YAML values are allowed.',
          `${path}/${String(index)}`,
        );
      }
      inspectYamlNode(item ?? null, depth + 1, `${path}/${String(index)}`, counters);
    }
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items as Pair<ParsedNode, ParsedNode | null>[]) {
      counters.nodes += 1;
      if (counters.nodes > ARTIFACT_LIMITS.yaml_nodes) {
        throw new RestrictedYamlError(
          `YAML exceeds the ${String(ARTIFACT_LIMITS.yaml_nodes)} node limit.`,
        );
      }
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        throw new RestrictedYamlError('YAML mapping keys must be strings.', path);
      }
      const part = scalarPathPart(pair.key);
      const childPath = `${path}/${part}`;
      if (pair.key.value === '<<') {
        throw new RestrictedYamlError('YAML merge keys are not allowed.', childPath);
      }
      inspectYamlNode(pair.key, depth + 1, childPath, counters);
      inspectYamlNode(pair.value, depth + 1, childPath, counters);
    }
    return;
  }
  throw new RestrictedYamlError('Only JSON-compatible YAML values are allowed.', path);
};

const parseRestrictedYaml = (
  source: string,
): ArtifactValidationFailure | { readonly value: unknown } => {
  const document = parseDocument(source, {
    logLevel: 'silent',
    prettyErrors: false,
    schema: 'core',
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    return {
      ok: false,
      errors: boundedErrors(
        document.errors.map((error) => ({
          code: 'malformed_yaml' as const,
          message:
            error.code === 'MULTIPLE_DOCS'
              ? 'Exactly one YAML document is allowed.'
              : `Malformed YAML document (${error.code}).`,
        })),
      ),
    };
  }
  if (document.warnings.length > 0) {
    return {
      ok: false,
      errors: boundedErrors(
        document.warnings.map((warning) => ({
          code: 'restricted_yaml' as const,
          message: `YAML feature is not allowed (${warning.code}).`,
        })),
      ),
    };
  }
  if (document.contents === null) {
    return { ok: false, errors: [{ code: 'malformed_yaml', message: 'The artifact is empty.' }] };
  }

  try {
    inspectYamlNode(document.contents, 1, '', { nodes: 0 });
    return { value: document.toJS({ mapAsMap: false, maxAliasCount: 0 }) as unknown };
  } catch (error: unknown) {
    if (error instanceof RestrictedYamlError) {
      const item: ArtifactValidationError =
        error.path === undefined
          ? { code: 'restricted_yaml', message: error.message }
          : { code: 'restricted_yaml', message: error.message, path: error.path };
      return { ok: false, errors: [item] };
    }
    return {
      ok: false,
      errors: [
        { code: 'malformed_yaml', message: 'The YAML document could not be converted safely.' },
      ],
    };
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateVersion = (value: unknown): ArtifactValidationFailure | undefined => {
  if (isRecord(value) && 'version' in value && value.version !== 1) {
    return {
      ok: false,
      errors: [
        { code: 'unsupported_artifact_version', message: 'Only artifact version 1 is supported.' },
      ],
    };
  }
  return undefined;
};

const schemaErrors = (): ArtifactValidationFailure => ({
  ok: false,
  errors: boundedErrors(
    (validateSchema.errors ?? []).map((error) => ({
      code: 'schema_violation' as const,
      message:
        error.message === undefined
          ? 'The value does not match the version 1 schema.'
          : error.message,
      path: error.instancePath === '' ? '/' : error.instancePath,
    })),
  ),
});

export const isArtifactPath = (value: string): boolean => {
  if (!pathPattern.test(value) || value.startsWith('/') || value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
};

export const resolveArtifactPath = (root: string, artifactPath: string): string => {
  if (!isArtifactPath(artifactPath)) throw new Error('Invalid artifact path.');
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${artifactPath.replaceAll('/', separator)}`;
};

const semanticErrors = (artifact: ArtifactV1): readonly ArtifactValidationError[] => {
  const errors: ArtifactValidationError[] = [];
  const paths = new Set<string>();
  let totalContentBytes = 0;
  let reproductionFiles = 0;
  let subjectFiles = 0;

  for (const file of artifact.files) {
    const path = `/files/${file.path}`;
    if (!isArtifactPath(file.path)) {
      errors.push({
        code: 'semantic_violation',
        message: 'File path is not a safe normalized relative path.',
        path,
      });
    }
    const collisionKey = file.path.toLowerCase();
    if (paths.has(collisionKey)) {
      errors.push({
        code: 'semantic_violation',
        message: 'File paths must be unique without ASCII case collisions.',
        path,
      });
    }
    paths.add(collisionKey);
    const contentBytes = utf8.encode(file.content).byteLength;
    totalContentBytes += contentBytes;
    if (contentBytes > ARTIFACT_LIMITS.scalar_bytes) {
      errors.push({
        code: 'semantic_violation',
        message: 'File content exceeds the 1 MiB per-file limit.',
        path,
      });
    }
    if (sha256(file.content) !== file.sha256) {
      errors.push({
        code: 'semantic_violation',
        message: 'File content does not match its SHA-256 digest.',
        path,
      });
    }
    if (file.role === 'reproduction') reproductionFiles += 1;
    if (file.role === 'subject') subjectFiles += 1;
  }

  if (totalContentBytes > ARTIFACT_LIMITS.total_file_content_bytes) {
    errors.push({
      code: 'semantic_violation',
      message: 'Total file content exceeds the 4 MiB artifact limit.',
      path: '/files',
    });
  }
  if (reproductionFiles === 0 || subjectFiles === 0) {
    errors.push({
      code: 'semantic_violation',
      message: 'Version 1 requires at least one reproduction file and one subject file.',
      path: '/files',
    });
  }
  if (
    artifact.expect.stdout.length + artifact.expect.stderr.length >
    ARTIFACT_LIMITS.output_expectations
  ) {
    errors.push({
      code: 'semantic_violation',
      message:
        'Standard-output and standard-error expectations may contain at most 16 entries in total.',
      path: '/expect',
    });
  }
  if (
    artifact.expect.exit_code !== 0 &&
    artifact.expect.stdout.length === 0 &&
    artifact.expect.stderr.length === 0
  ) {
    errors.push({
      code: 'semantic_violation',
      message: 'A failing expectation must include output evidence.',
      path: '/expect',
    });
  }

  for (const [stream, expectations] of [
    ['stdout', artifact.expect.stdout],
    ['stderr', artifact.expect.stderr],
  ] as const) {
    for (let index = 0; index < expectations.length; index += 1) {
      const expectation = expectations[index];
      if (expectation === undefined) continue;
      if (utf8.encode(expectation.value).byteLength > 8192) {
        errors.push({
          code: 'semantic_violation',
          message: 'Output expectation exceeds 8 KiB.',
          path: `/expect/${stream}/${String(index)}`,
        });
      }
      if (expectation.value.includes('[REDACTED:')) {
        errors.push({
          code: 'semantic_violation',
          message: 'Redaction replacements cannot be used as matching evidence.',
          path: `/expect/${stream}/${String(index)}`,
        });
      }
    }
  }

  for (let index = 0; index < artifact.command.arguments.length; index += 1) {
    const argument = artifact.command.arguments[index];
    if (argument !== undefined && utf8.encode(argument).byteLength > 8192) {
      errors.push({
        code: 'semantic_violation',
        message: 'Command argument exceeds 8 KiB.',
        path: `/command/arguments/${String(index)}`,
      });
    }
  }

  const selectedPaths = new Set(artifact.files.map((file) => file.path));
  for (let index = 0; index < artifact.redaction.findings.length; index += 1) {
    const finding = artifact.redaction.findings[index];
    if (finding === undefined) continue;
    if (
      finding.target !== 'stdout' &&
      finding.target !== 'stderr' &&
      !selectedPaths.has(finding.target)
    ) {
      errors.push({
        code: 'semantic_violation',
        message: 'Redaction finding target must name a selected file or output stream.',
        path: `/redaction/findings/${String(index)}/target`,
      });
    }
    if (finding.replacement !== `[REDACTED:${finding.category}]`) {
      errors.push({
        code: 'semantic_violation',
        message: 'Redaction replacement must match its category.',
        path: `/redaction/findings/${String(index)}/replacement`,
      });
    }
  }
  return boundedErrors(errors);
};

const canonicalize = (artifact: ArtifactV1, digest: string): ValidatedArtifactV1 => ({
  version: 1,
  environment: { ...artifact.environment },
  capture: { ...artifact.capture },
  command: { ...artifact.command, arguments: [...artifact.command.arguments] },
  files: [...artifact.files]
    .map((file) => ({ ...file }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
  expect: {
    exit_code: artifact.expect.exit_code,
    stdout: artifact.expect.stdout.map((item) => ({ ...item })),
    stderr: artifact.expect.stderr.map((item) => ({ ...item })),
  },
  limits: { ...artifact.limits },
  redaction: {
    enabled: true,
    findings: [...artifact.redaction.findings]
      .map((finding) => ({ ...finding }))
      .sort((left, right) => {
        if (left.target !== right.target) return left.target < right.target ? -1 : 1;
        if (left.category === right.category) return 0;
        return left.category < right.category ? -1 : 1;
      }),
  },
  digest,
  validated: true,
});

export const validateArtifactValue = (
  value: unknown,
  digest = sha256(JSON.stringify(value)),
): ArtifactValidationResult => {
  const versionFailure = validateVersion(value);
  if (versionFailure !== undefined) return versionFailure;
  if (!validateSchema(value)) return schemaErrors();

  const artifact = value as ArtifactV1;
  const errors = semanticErrors(artifact);
  return errors.length === 0
    ? { ok: true, artifact: canonicalize(artifact, digest) }
    : { ok: false, errors };
};

export const parseAndValidateArtifact = (input: string | Uint8Array): ArtifactValidationResult => {
  const bytes = typeof input === 'string' ? utf8.encode(input) : input;
  if (bytes.byteLength > ARTIFACT_LIMITS.input_bytes) {
    return {
      ok: false,
      errors: [
        {
          code: 'input_too_large',
          message: `Artifact exceeds the ${String(ARTIFACT_LIMITS.input_bytes)} byte input limit.`,
        },
      ],
    };
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      errors: [{ code: 'malformed_yaml', message: 'Artifact is not valid UTF-8.' }],
    };
  }

  const parsed = parseRestrictedYaml(source);
  if ('ok' in parsed) return parsed;
  return validateArtifactValue(parsed.value, sha256(bytes));
};
