/**
 * The only code in ProofIssue that talks to the network on behalf of an artifact.
 *
 * It downloads one package tarball from the public npm registry and nothing else. The
 * address is re-checked here even though lockfile validation already pins it, because this
 * is the last line before a request leaves the machine. It sends no credentials, follows
 * no redirects, accepts no content encoding, and bounds both the size and the time of every
 * download. It never extracts or executes anything.
 */
import { REGISTRY_ORIGIN } from './lockfile.js';

export type PackageFetchErrorCode =
  | 'cancelled'
  | 'content_encoding_refused'
  | 'http_status'
  | 'network_error'
  | 'redirect_refused'
  | 'size_limit_exceeded'
  | 'timeout'
  | 'url_refused';

export class PackageFetchError extends Error {
  readonly code: PackageFetchErrorCode;
  readonly status?: number;

  constructor(code: PackageFetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'PackageFetchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface FetchOptions {
  /** The download fails as soon as it exceeds this many bytes. */
  readonly max_bytes: number;
  readonly signal?: AbortSignal;
  /** The whole download, headers and body, fails after this long. */
  readonly timeout_ms: number;
}

export interface PackageFetcher {
  /**
   * Resolves once the response headers are accepted, with the body as chunks. Errors from
   * the body, including size and time limits, are thrown while iterating.
   */
  fetch(url: string, options: FetchOptions): Promise<AsyncIterable<Uint8Array>>;
}

export interface RegistryFetcherConfig {
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Send requests here instead of the registry. A test seam for a local server: addresses
   * are still required to be registry addresses, and only the origin of the request is
   * replaced. Nothing in the product sets it.
   */
  readonly transport_origin?: string;
}

const assertRegistryAddress = (value: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PackageFetchError('url_refused', 'The package address is not a valid URL.');
  }
  if (
    // The prefix already fixes the scheme, host, and port and rules out credentials.
    !value.startsWith(`${REGISTRY_ORIGIN}/`) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value.includes('\\')
  ) {
    throw new PackageFetchError(
      'url_refused',
      'Only tarball addresses on the public npm registry are fetched.',
    );
  }
};

const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/octet-stream',
  // Hashes are over the exact tarball bytes, so the server must not transform them.
  'accept-encoding': 'identity',
  'user-agent': 'proofissue-prepare',
});

export const createRegistryFetcher = (config: RegistryFetcherConfig = {}): PackageFetcher => {
  const doFetch = config.fetch ?? globalThis.fetch;
  const transportOrigin = config.transport_origin ?? REGISTRY_ORIGIN;

  return {
    fetch: async (url, options) => {
      assertRegistryAddress(url);
      const target = `${transportOrigin}${url.slice(REGISTRY_ORIGIN.length)}`;
      const timeout = AbortSignal.timeout(options.timeout_ms);
      const signal =
        options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

      const classify = (): PackageFetchError =>
        timeout.aborted
          ? new PackageFetchError('timeout', 'The download took too long.')
          : options.signal?.aborted === true
            ? new PackageFetchError('cancelled', 'The download was cancelled.')
            : new PackageFetchError('network_error', 'The package could not be downloaded.');

      let response: Response;
      try {
        response = await doFetch(target, {
          cache: 'no-store',
          credentials: 'omit',
          headers: REQUEST_HEADERS,
          method: 'GET',
          redirect: 'manual',
          signal,
        });
      } catch {
        throw classify();
      }

      const refuse = async (error: PackageFetchError): Promise<never> => {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      };

      if (response.status >= 300 && response.status < 400) {
        return await refuse(
          new PackageFetchError('redirect_refused', 'The registry redirected the download.'),
        );
      }
      if (response.status !== 200) {
        return await refuse(
          new PackageFetchError(
            'http_status',
            `The registry answered with status ${String(response.status)}.`,
            response.status,
          ),
        );
      }
      const encoding = response.headers.get('content-encoding');
      if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
        return await refuse(
          new PackageFetchError(
            'content_encoding_refused',
            'The registry sent an encoded tarball, which cannot match its integrity hash.',
          ),
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > options.max_bytes) {
        return await refuse(
          new PackageFetchError('size_limit_exceeded', 'The package is larger than the limit.'),
        );
      }
      const stream = response.body;
      if (stream === null) {
        throw new PackageFetchError('network_error', 'The registry sent no tarball.');
      }

      async function* chunks(source: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
        const reader = source.getReader();
        let total = 0;
        try {
          for (;;) {
            let result: Awaited<ReturnType<typeof reader.read>>;
            try {
              result = await reader.read();
            } catch {
              throw classify();
            }
            if (result.done) return;
            total += result.value.byteLength;
            if (total > options.max_bytes) {
              throw new PackageFetchError(
                'size_limit_exceeded',
                'The package is larger than the limit.',
              );
            }
            yield result.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      return chunks(stream);
    },
  };
};
