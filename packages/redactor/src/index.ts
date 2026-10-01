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

// Every pattern below is linear: repetition is either bounded or runs over a character
// class that cannot also match the delimiter that ends it, and there are no nested
// quantifiers over overlapping classes. A value is never matched when it already is a
// redaction marker, so redacting redacted text changes nothing.
// The guard skips leading whitespace so it still holds when a preceding `\s*` backtracks.
const NOT_A_MARKER = String.raw`(?!\s*["']?\[REDACTED:[a-z_]+\])`;
const KEY_SEPARATOR = String.raw`["']?\s*[:=]\s*`;
// A quoted value runs to its closing quote, or to the end of the line when the quote is
// never closed (for example output cut off at a byte limit), so a truncated secret fails
// closed instead of leaking.
const SECRET_VALUE = String.raw`${NOT_A_MARKER}(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"'\x60,;]+)`;
const HEADER_VALUE = String.raw`${NOT_A_MARKER}[^\r\n"\x60]+`;
// Multi-parameter credentials (Digest) contain quotes, so they run to the end of the line.
const HEADER_LINE = String.raw`${NOT_A_MARKER}[^\r\n]+`;
const WORDS = String.raw`(?:[A-Za-z0-9]+[_.-])`;

const PEM_LABEL = String.raw`(?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?`;

const valueRule = (category: RedactionCategory, prefix: string, flags: string): RedactionRule => ({
  category,
  pattern: new RegExp(`${prefix}${SECRET_VALUE}`, flags),
  replace: keepFirstGroup,
});

const RULES: readonly RedactionRule[] = [
  {
    // Includes encrypted keys and PGP blocks. A block with no END line (for example output
    // truncated mid-key) is redacted to the end of the text.
    category: 'private_key',
    pattern: new RegExp(
      String.raw`-----BEGIN ${PEM_LABEL}-----[\s\S]*?(?:-----END ${PEM_LABEL}-----|$)`,
      'gu',
    ),
    replace: replaceEntireMatch,
  },
  {
    category: 'authorization_header',
    pattern: new RegExp(
      String.raw`\b(authorization["']?\s*:\s*["']?(?:bearer|basic|token|negotiate|ntlm|apikey)\s+)${NOT_A_MARKER}[^\s"'\x60,;]+`,
      'giu',
    ),
    replace: keepFirstGroup,
  },
  {
    // Schemes whose credentials span several parameters.
    category: 'authorization_header',
    pattern: new RegExp(
      String.raw`\b(authorization["']?\s*:\s*["']?(?:digest|hawk|aws4-hmac-sha256)\s+)${HEADER_LINE}`,
      'giu',
    ),
    replace: keepFirstGroup,
  },
  {
    // Headers that carry credentials or session identifiers whole.
    category: 'authorization_header',
    pattern: new RegExp(
      String.raw`\b((?:set-cookie|cookie|x-api-key|x-auth-token|x-amz-security-token)["']?\s*:\s*["']?)${HEADER_VALUE}`,
      'giu',
    ),
    replace: keepFirstGroup,
  },
  valueRule(
    'sensitive_environment',
    String.raw`\b((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|SECRET_ACCESS_KEY)${KEY_SEPARATOR})`,
    'giu',
  ),
  // Environment-variable style names that end in a credential word (MY_SERVICE_TOKEN).
  // Case-sensitive on purpose: lowercase `token: 5` is ordinary program output.
  valueRule(
    'sensitive_environment',
    String.raw`\b((?:[A-Z][A-Z0-9]*_){0,8}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)${KEY_SEPARATOR})`,
    'gu',
  ),
  valueRule(
    'sensitive_environment',
    String.raw`\b(${WORDS}{0,3}(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|session[_-]?token)${KEY_SEPARATOR})`,
    'giu',
  ),
  // npm registry credentials, for example //registry.example/:_authToken=...
  valueRule('sensitive_environment', String.raw`\b(_(?:authToken|auth|password)\s*=\s*)`, 'gu'),
  valueRule(
    'password',
    String.raw`\b(${WORDS}{0,5}(?:password|passwd|pwd)${KEY_SEPARATOR})`,
    'giu',
  ),
  {
    // scheme://user:password@host — only the password is removed.
    category: 'password',
    pattern: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'`<>]+:)(?!\[REDACTED:)[^\s@/"'`<>]+(?=@)/giu,
    replace: keepFirstGroup,
  },
  {
    category: 'api_key',
    pattern: new RegExp(
      [
        String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
        String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
        String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
        String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}`,
        String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
        String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
        String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
        String.raw`\bAIza[A-Za-z0-9_-]{35}`,
        String.raw`\bnpm_[A-Za-z0-9]{36}`,
        String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
      ].join('|'),
      'gu',
    ),
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
