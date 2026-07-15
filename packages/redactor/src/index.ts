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

export class RedactionLimitError extends Error {
  constructor() {
    super('Content contains more redaction findings than an artifact can safely describe.');
    this.name = 'RedactionLimitError';
  }
}

const MAX_FINDINGS = 100;

const replacementFor = (category: RedactionCategory): string => `[REDACTED:${category}]`;

interface RedactionRule {
  readonly category: RedactionCategory;
  readonly pattern: RegExp;
  readonly replace: (
    match: string,
    groups: readonly (string | undefined)[],
    marker: string,
  ) => string;
}

const keepFirstGroup = (
  _match: string,
  groups: readonly (string | undefined)[],
  marker: string,
): string => `${groups[0] ?? ''}${marker}`;

const replaceEntireMatch = (
  _match: string,
  _groups: readonly (string | undefined)[],
  marker: string,
) => marker;

const RULES: readonly RedactionRule[] = [
  {
    category: 'private_key',
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
    replace: replaceEntireMatch,
  },
  {
    category: 'authorization_header',
    pattern: /\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"'`,;]+/giu,
    replace: keepFirstGroup,
  },
  {
    category: 'sensitive_environment',
    pattern:
      /\b((?:AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|SECRET_ACCESS_KEY)\s*[:=]\s*)[^\s"'`,;]+/giu,
    replace: keepFirstGroup,
  },
  {
    category: 'password',
    pattern: /\b((?:password|passwd|pwd)\s*[:=]\s*)[^\s"'`,;]+/giu,
    replace: keepFirstGroup,
  },
  {
    category: 'api_key',
    pattern:
      /\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b/gu,
    replace: replaceEntireMatch,
  },
];

export const redactText = (text: string): RedactionResult => {
  const findings: RedactionFinding[] = [];
  let redacted = text;

  for (const rule of RULES) {
    redacted = redacted.replace(rule.pattern, (...values: unknown[]) => {
      if (findings.length >= MAX_FINDINGS) throw new RedactionLimitError();
      const match = String(values[0]);
      const groups = values
        .slice(1, -2)
        .map((value) => (typeof value === 'string' ? value : undefined));
      const replacement = replacementFor(rule.category);
      findings.push({ category: rule.category, replacement });
      return rule.replace(match, groups, replacement);
    });
  }

  return { text: redacted, findings };
};

export const createRedactor = (): Redactor => ({ redact: redactText });
