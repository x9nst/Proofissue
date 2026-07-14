import type {
  ArtifactFileV1,
  ArtifactOutputExpectationV1,
  ArtifactRedactionFindingV1,
  ArtifactV1,
} from './model.js';
import { validateArtifactValue } from './validate.js';

export class InvalidArtifactError extends Error {
  readonly errors: ReturnType<typeof validateArtifactValue> extends infer Result
    ? Result extends { readonly ok: false; readonly errors: infer Errors }
      ? Errors
      : never
    : never;

  constructor(errors: InvalidArtifactError['errors']) {
    super(errors[0]?.message ?? 'Artifact validation failed.');
    this.name = 'InvalidArtifactError';
    this.errors = errors;
  }
}

const quoted = (value: string): string => JSON.stringify(value);
const line = (indent: number, value: string): string => `${' '.repeat(indent)}${value}`;

const hasDisallowedLiteralCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === '\r' ||
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
    );
  });

const trailingLineFeeds = (value: string): number => {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\n'; index -= 1) count += 1;
  return count;
};

const serializeContent = (content: string, indent: number): readonly string[] => {
  if (!content.includes('\n') || hasDisallowedLiteralCharacter(content)) {
    return [line(indent, `content: ${quoted(content)}`)];
  }

  const trailing = trailingLineFeeds(content);
  const indicator = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
  const withoutTrailing = trailing === 0 ? content : content.slice(0, -trailing);
  const contentLines = withoutTrailing.split('\n');
  const output = [line(indent, `content: ${indicator}`)];
  for (const contentLine of contentLines)
    output.push(contentLine === '' ? '' : line(indent + 2, contentLine));
  for (let index = 1; index < trailing; index += 1) output.push('');
  return output;
};

const serializeExpectation = (
  expectation: ArtifactOutputExpectationV1,
  indent: number,
): readonly string[] => [
  line(indent, `- mode: ${expectation.mode}`),
  line(indent + 2, `value: ${quoted(expectation.value)}`),
];

const serializeExpectationList = (
  name: 'stderr' | 'stdout',
  expectations: readonly ArtifactOutputExpectationV1[],
): readonly string[] => {
  if (expectations.length === 0) return [line(2, `${name}: []`)];
  return [line(2, `${name}:`), ...expectations.flatMap((item) => serializeExpectation(item, 4))];
};

const serializeFile = (file: ArtifactFileV1): readonly string[] => [
  line(2, `- path: ${quoted(file.path)}`),
  line(4, `role: ${file.role}`),
  line(4, `encoding: ${file.encoding}`),
  ...serializeContent(file.content, 4),
  line(4, `sha256: ${quoted(file.sha256)}`),
];

const serializeFinding = (finding: ArtifactRedactionFindingV1): readonly string[] => [
  line(4, `- category: ${finding.category}`),
  line(6, `target: ${quoted(finding.target)}`),
  line(6, `replacement: ${quoted(finding.replacement)}`),
];

const serializeCanonicalArtifact = (artifact: ArtifactV1): string => {
  const lines = [
    'version: 1',
    'environment:',
    line(2, 'runtime: node'),
    line(2, `runtime_version: ${quoted(artifact.environment.runtime_version)}`),
    line(2, 'operating_system: linux'),
    line(2, `image: ${quoted(artifact.environment.image)}`),
    'capture:',
    line(2, `host_operating_system: ${artifact.capture.host_operating_system}`),
    line(2, `host_architecture: ${quoted(artifact.capture.host_architecture)}`),
    line(2, `node_version: ${quoted(artifact.capture.node_version)}`),
    'command:',
    line(2, 'program: node'),
    line(2, 'arguments:'),
    ...artifact.command.arguments.map((argument) => line(4, `- ${quoted(argument)}`)),
    line(2, 'working_directory: .'),
    'files:',
    ...artifact.files.flatMap(serializeFile),
    'expect:',
    line(2, `exit_code: ${String(artifact.expect.exit_code)}`),
    ...serializeExpectationList('stdout', artifact.expect.stdout),
    ...serializeExpectationList('stderr', artifact.expect.stderr),
    'limits:',
    line(2, `timeout_seconds: ${String(artifact.limits.timeout_seconds)}`),
    line(2, `memory_mb: ${String(artifact.limits.memory_mb)}`),
    line(2, `cpus: ${artifact.limits.cpus.toString()}`),
    line(2, `processes: ${String(artifact.limits.processes)}`),
    line(2, `output_bytes_per_stream: ${String(artifact.limits.output_bytes_per_stream)}`),
    'redaction:',
    line(2, 'enabled: true'),
    ...(artifact.redaction.findings.length === 0
      ? [line(2, 'findings: []')]
      : [line(2, 'findings:'), ...artifact.redaction.findings.flatMap(serializeFinding)]),
  ];
  return `${lines.join('\n')}\n`;
};

export const serializeArtifact = (artifact: ArtifactV1): string => {
  const validation = validateArtifactValue({
    version: artifact.version,
    environment: artifact.environment,
    capture: artifact.capture,
    command: artifact.command,
    files: artifact.files,
    expect: artifact.expect,
    limits: artifact.limits,
    redaction: artifact.redaction,
  });
  if (!validation.ok) throw new InvalidArtifactError(validation.errors);
  return serializeCanonicalArtifact(validation.artifact);
};
