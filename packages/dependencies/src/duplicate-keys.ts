/**
 * Reports whether any JSON object in `text` has the same key twice.
 *
 * `JSON.parse` keeps the last duplicate and says nothing, so two consumers that disagree
 * about which duplicate counts could be shown different lockfiles. The rest of the project
 * rejects duplicate keys instead of accepting last-value-wins behavior, and this does the
 * same for JSON.
 *
 * `text` must already be valid JSON. The scan is linear and iterative. Keys are compared
 * after decoding, so `"a"` and `"a"` are the same key.
 */
export const hasDuplicateJsonKeys = (text: string): boolean => {
  // One entry per open container: a key set for an object, null for an array.
  const containers: (Set<string> | null)[] = [];
  let expectingKey = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return false; // unterminated string: nothing valid remains
      if (expectingKey) {
        const keys = containers[containers.length - 1];
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        if (keys !== undefined && keys !== null) {
          if (keys.has(key)) return true;
          keys.add(key);
        }
        expectingKey = false;
      }
      index = end;
    } else if (character === '{') {
      containers.push(new Set());
      expectingKey = true;
    } else if (character === '[') {
      containers.push(null);
      expectingKey = false;
    } else if (character === '}' || character === ']') {
      containers.pop();
      expectingKey = false;
    } else if (character === ',') {
      const top = containers[containers.length - 1];
      expectingKey = top !== undefined && top !== null;
    }
  }
  return false;
};
