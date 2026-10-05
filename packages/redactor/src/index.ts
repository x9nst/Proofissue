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

// Linearity: every value alternative begins with a non-whitespace character, so backtracking a
// preceding `\s*` can never produce a match and the guards need no `\s*` of their own (the 0.1.0
// guard had one, which made whitespace runs quadratic). Alternations inside repetitions start with
// disjoint characters, every repetition that can end a match is the last element of its pattern,
// and the URL rule is bounded. A value never starts with a redaction marker, so redacting
// redacted text changes nothing.
const NOT_A_MARKER = String.raw`(?![\x60"']?\[REDACTED:[a-z_]+\])`;
const KEY_SEPARATOR = String.raw`["']?\s*[:=]\s*`;
const DOUBLE_QUOTED = String.raw`"(?:[^"\\\r\n]|\\.)*"?`;
const SINGLE_QUOTED = String.raw`'(?:[^'\\\r\n]|\\.)*'?`;
const BACK_QUOTED = String.raw`\x60(?:[^\x60\\\r\n]|\\.)*\x60?`;
const QUOTED_PART = String.raw`(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${BACK_QUOTED})`;
// A quoted value ends at its matching unescaped quote, plus any segments attached to it
// ("a"'b'c), or at the end of the line when it is never closed.
const QUOTED_VALUE = String.raw`${QUOTED_PART}(?:${QUOTED_PART}|[^\s"'\x60,;)\]}])*`;
// Any other value runs to the end of the line: a separator inside a secret cannot end it.
const LINE_VALUE = String.raw`[^\s"'\x60][^\r\n]*`;
// A YAML block scalar (| or >) at the end of a line also takes the indented and blank lines after it.
const BLOCK_VALUE = String.raw`[|>][-+0-9]{0,2}[ \t]*(?![^\r\n])(?:\r?\n(?:[ \t]*(?=\r?\n)|[ \t]+[^\r\n]*))*`;
const SECRET_VALUE = String.raw`${NOT_A_MARKER}(?:${BLOCK_VALUE}|${QUOTED_VALUE}|${LINE_VALUE})`;
// A command-line flag value is a shell word, and the shell joins quoted and unquoted parts
// ('':x is the word :x), so a quote does not end it: the rest of the line is removed.
const FLAG_VALUE = String.raw`${NOT_A_MARKER}[^\s][^\r\n]*`;
const AUTH_SCHEMES = String.raw`(?:bearer|basic|token|negotiate|ntlm|apikey|digest|hawk|aws4-hmac-sha256)`;
// Placed before the optional scheme, so a backtracked scheme cannot expose "Bearer [REDACTED:..]".
const HEADER_GUARD = String.raw`(?!["'\x60]?(?:${AUTH_SCHEMES}[ \t]+)?["'\x60]?\[REDACTED:[a-z_]+\])`;
const CREDENTIAL_HEADERS = String.raw`(?:set-cookie|cookie|x-api-key|x-auth-token|x-amz-security-token)`;
const PEM_LABEL = String.raw`(?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?`;

const valueRule = (
  category: RedactionCategory,
  prefix: string,
  flags: string,
  value: string = SECRET_VALUE,
): RedactionRule => ({
  category,
  pattern: new RegExp(`${prefix}${value}`, flags),
  replace: keepFirstGroup,
});

const scheme = (withScheme: boolean): string =>
  withScheme ? String.raw`(?:${AUTH_SCHEMES}[ \t]+)?` : '';

// "name": "value" (JSON or JS): the value ends at its matching unescaped quote (group 3).
const quotedHeaderRule = (name: string, withScheme: boolean): RedactionRule => ({
  category: 'authorization_header',
  pattern: new RegExp(
    String.raw`\b(${name}(["'])\s*:\s*(["'\x60])${HEADER_GUARD}${scheme(withScheme)})(?:(?!\3)[^\\\r\n]|\\.)+`,
    'giu',
  ),
  replace: keepFirstGroup,
});

// Name: value: the whole rest of the line, whatever the scheme.
const headerLineRule = (name: string, withScheme: boolean): RedactionRule => ({
  category: 'authorization_header',
  pattern: new RegExp(
    String.raw`\b(${name}["']?\s*:\s*${HEADER_GUARD}${scheme(withScheme)})[^\s][^\r\n]*`,
    'giu',
  ),
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
    // scheme://user:password@host. The password runs to the last @ within 512 characters, so a
    // password holding / @ or : is removed whole. Runs before the key=value rules so none of them
    // can take part of a password first. Raw brackets cannot appear in the user name, which keeps
    // a redaction marker from being read as user:password.
    category: 'password',
    pattern:
      /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/"'`<>[\]]{1,256}:)(?!\[REDACTED:)[^\s"'`<>]{1,512}(?=@)/giu,
    replace: keepFirstGroup,
  },
  quotedHeaderRule('authorization', true),
  headerLineRule('authorization', true),
  quotedHeaderRule(CREDENTIAL_HEADERS, false),
  headerLineRule(CREDENTIAL_HEADERS, false),
  // Command-line flags: --password VALUE, --db-password=VALUE. Before the name rules, so those
  // cannot read the quoted start of a flag value as a complete value.
  valueRule(
    'password',
    String.raw`(--(?:[A-Za-z0-9]+-){0,4}(?:password|passwd)(?:[ \t]+|=[ \t]*))`,
    'giu',
    FLAG_VALUE,
  ),
  valueRule(
    'sensitive_environment',
    String.raw`(--(?:[A-Za-z0-9]+-){0,4}(?:token|secret|api-?key|private-key)(?:[ \t]+|=[ \t]*))`,
    'giu',
    FLAG_VALUE,
  ),
  valueRule(
    'sensitive_environment',
    String.raw`((?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|CLIENT_SECRET|DATABASE_URL|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|SECRET_ACCESS_KEY)${KEY_SEPARATOR})`,
    'giu',
  ),
  // Case-sensitive on purpose: lowercase `token: 5` is ordinary program output.
  valueRule(
    'sensitive_environment',
    String.raw`((?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)${KEY_SEPARATOR})`,
    'gu',
  ),
  // No word boundary, so camelCase names (myApiKey, accessToken, clientSecret) match too.
  valueRule(
    'sensitive_environment',
    String.raw`((?:api[_-]?(?:key|token|secret)|access[_-]?(?:token|key)|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|session[_-]?token|refresh[_-]?token)${KEY_SEPARATOR})`,
    'giu',
  ),
  // camelCase names that end in a credential word (githubToken, webhookSecret). Case-sensitive.
  valueRule(
    'sensitive_environment',
    String.raw`(?<=[a-z0-9])((?:Token|Secret|Credentials?)${KEY_SEPARATOR})`,
    'gu',
  ),
  valueRule('sensitive_environment', String.raw`(?<![A-Za-z0-9])(secret${KEY_SEPARATOR})`, 'giu'),
  // npm registry credentials, for example //registry.example/:_authToken=...
  valueRule('sensitive_environment', String.raw`\b(_(?:authToken|auth|password)\s*=\s*)`, 'gu'),
  valueRule('password', String.raw`((?:password|passwd|pwd)${KEY_SEPARATOR})`, 'giu'),
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
