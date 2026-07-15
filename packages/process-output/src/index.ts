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
  const collector = new BoundedOutputCollector(limit);
  for (const chunk of chunks) collector.add(chunk);
  return collector.finish();
};

export class BoundedOutputCollector {
  readonly #limit: number;
  readonly #retained: Uint8Array;
  #retainedBytes = 0;
  #totalBytes = 0;

  constructor(limit: number) {
    validateLimit(limit);
    this.#limit = limit;
    this.#retained = new Uint8Array(limit);
  }

  add(chunk: Uint8Array): void {
    this.#totalBytes += chunk.byteLength;
    const retainedLength = Math.min(this.#limit - this.#retainedBytes, chunk.byteLength);
    if (retainedLength > 0) {
      this.#retained.set(chunk.subarray(0, retainedLength), this.#retainedBytes);
      this.#retainedBytes += retainedLength;
    }
  }

  finish(): BoundedStreamCapture {
    const retained = this.#retained.subarray(0, this.#retainedBytes);

    let hadDecodingReplacement = false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(retained);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      hadDecodingReplacement = true;
    }

    return {
      decoded_text: new TextDecoder('utf-8').decode(retained),
      discarded_bytes: this.#totalBytes - this.#retainedBytes,
      had_decoding_replacement: hadDecodingReplacement,
      retained_bytes: this.#retainedBytes,
      total_bytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#retainedBytes,
    };
  }
}
