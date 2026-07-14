import type { BoundedStreamCapture } from '@proofissue/contracts';

const validateLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('Output byte limit must be a non-negative safe integer.');
  }
};

export const decodeBoundedOutput = (
  chunks: readonly Uint8Array[],
  limit: number,
): BoundedStreamCapture => {
  validateLimit(limit);

  let totalBytes = 0;
  const retainedChunks: Uint8Array[] = [];
  let remaining = limit;

  for (const chunk of chunks) {
    totalBytes += chunk.byteLength;
    if (remaining === 0) continue;

    const retainedLength = Math.min(remaining, chunk.byteLength);
    retainedChunks.push(chunk.slice(0, retainedLength));
    remaining -= retainedLength;
  }

  const retainedBytes = Math.min(totalBytes, limit);
  const retained = new Uint8Array(retainedBytes);
  let offset = 0;
  for (const chunk of retainedChunks) {
    retained.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let hadDecodingReplacement = false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(retained);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    hadDecodingReplacement = true;
  }

  return {
    decoded_text: new TextDecoder('utf-8').decode(retained),
    discarded_bytes: totalBytes - retainedBytes,
    had_decoding_replacement: hadDecodingReplacement,
    retained_bytes: retainedBytes,
    total_bytes: totalBytes,
    truncated: totalBytes > retainedBytes,
  };
};
