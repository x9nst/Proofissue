/**
 * Small type guards for reading untrusted JSON. CLI output and downloaded trial results are
 * both treated as untrusted: nothing is trusted until it has been narrowed here.
 */

export type JsonRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const stringField = (
  record: JsonRecord,
  key: string,
  maxLength = 4096,
): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
};

export const patternField = (
  record: JsonRecord,
  key: string,
  pattern: RegExp,
  maxLength = 256,
): string | undefined => {
  const value = stringField(record, key, maxLength);
  return value !== undefined && pattern.test(value) ? value : undefined;
};

export const numberField = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** A safe integer from 0 up to `max`. Byte counts, durations, and exit codes use this. */
export const countField = (
  record: JsonRecord,
  key: string,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : undefined;
};

export const booleanField = (record: JsonRecord, key: string): boolean | undefined => {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
};

export const recordField = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

/** Returns the items of an array field, or an empty list when the field is absent or not an array. */
export const arrayField = (
  record: JsonRecord,
  key: string,
  maxItems = 1000,
): readonly unknown[] => {
  const value = record[key];
  return Array.isArray(value) ? (value as unknown[]).slice(0, maxItems) : [];
};

/** Keeps only the string items of an array field, each at most `maxLength` characters. */
export const stringItems = (
  record: JsonRecord,
  key: string,
  maxLength = 128,
  maxItems = 1000,
): readonly string[] =>
  arrayField(record, key, maxItems).filter(
    (item): item is string => typeof item === 'string' && item.length <= maxLength,
  );

export const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);
