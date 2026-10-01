import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRegistryFetcher, PackageFetchError, type PackageFetchErrorCode } from './fetcher.js';
import { REGISTRY_ORIGIN } from './lockfile.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface TestServer {
  readonly headers: IncomingHttpHeaders[];
  readonly origin: string;
  readonly paths: string[];
}

const servers: Server[] = [];

const startServer = async (handler: Handler): Promise<TestServer> => {
  const headers: IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    paths.push(request.url ?? '');
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { headers, origin: `http://127.0.0.1:${String(port)}`, paths };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    }),
  );
});

const address = (name = 'a', version = '1.0.0'): string =>
  `${REGISTRY_ORIGIN}/${name}/-/${name}-${version}.tgz`;

const readAll = async (chunks: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
};

const limits = { max_bytes: 1024 * 1024, timeout_ms: 5000 };

const failureOf = async (run: () => Promise<unknown>): Promise<PackageFetchError> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof PackageFetchError) return error;
    throw error;
  }
  throw new Error('Expected the download to fail.');
};

const expectCode = async (
  run: () => Promise<unknown>,
  code: PackageFetchErrorCode,
): Promise<void> => {
  expect((await failureOf(run)).code).toBe(code);
};

describe('createRegistryFetcher', () => {
  it('returns the exact bytes the server sent', async () => {
    const payload = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(payload);
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    const body = await readAll(await fetcher.fetch(address(), limits));

    expect(body.equals(payload)).toBe(true);
    expect(server.paths).toEqual(['/a/-/a-1.0.0.tgz']);
  });

  it('sends only fixed headers: no credentials, cookies, or compression', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('x');
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await readAll(await fetcher.fetch(address(), limits));

    const sent = server.headers[0] ?? {};
    expect(sent['accept-encoding']).toBe('identity');
    expect(sent['user-agent']).toBe('proofissue-prepare');
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
    expect(sent['proxy-authorization']).toBeUndefined();
    expect(sent['x-api-key']).toBeUndefined();
  });

  it('keeps a scoped package path intact', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('x');
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await readAll(await fetcher.fetch(`${REGISTRY_ORIGIN}/@s/p/-/p-2.0.0.tgz`, limits));

    expect(server.paths).toEqual(['/@s/p/-/p-2.0.0.tgz']);
  });

  it.each([404, 403, 429, 500, 503])(
    'reports status %i without reading the body',
    async (status) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status);
        response.end('secret-looking body that must not be surfaced');
      });
      const fetcher = createRegistryFetcher({ transport_origin: server.origin });

      const error = await failureOf(async () => await fetcher.fetch(address(), limits));

      expect(error.code).toBe('http_status');
      expect(error.status).toBe(status);
      expect(error.message).not.toContain('secret-looking');
    },
  );

  it.each([201, 202, 204, 206])(
    'refuses the success status %i that is not a full download',
    async (status) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status);
        response.end(status === 204 ? undefined : 'partial');
      });
      const fetcher = createRegistryFetcher({ transport_origin: server.origin });

      const error = await failureOf(async () => await fetcher.fetch(address(), limits));

      expect(error.code).toBe('http_status');
      expect(error.status).toBe(status);
    },
  );

  it.each([301, 302, 303, 307, 308])(
    'refuses a %i redirect and never contacts the target',
    async (status) => {
      const target = await startServer((_request, response) => {
        response.writeHead(200);
        response.end('redirected content');
      });
      const server = await startServer((_request, response) => {
        response.writeHead(status, { location: `${target.origin}/elsewhere.tgz` });
        response.end();
      });
      const fetcher = createRegistryFetcher({ transport_origin: server.origin });

      await expectCode(async () => await fetcher.fetch(address(), limits), 'redirect_refused');
      expect(target.paths).toEqual([]);
    },
  );

  it.each(['gzip', 'br', 'deflate', 'zstd'])('refuses content-encoding %s', async (encoding) => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': encoding });
      response.end('x');
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await expectCode(
      async () => await fetcher.fetch(address(), limits),
      'content_encoding_refused',
    );
  });

  it('accepts an explicit identity encoding', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'identity' });
      response.end('plain');
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    expect((await readAll(await fetcher.fetch(address(), limits))).toString()).toBe('plain');
  });

  it('refuses early when the declared length exceeds the limit', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-length': '5000' });
      response.end(Buffer.alloc(5000));
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await expectCode(
      async () => await fetcher.fetch(address(), { ...limits, max_bytes: 1000 }),
      'size_limit_exceeded',
    );
  });

  it('stops a download that exceeds the limit without declaring a length', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => {
        if (!response.write(Buffer.alloc(512))) return;
      }, 1);
      response.on('close', () => {
        clearInterval(timer);
      });
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    const chunks = await fetcher.fetch(address(), { ...limits, max_bytes: 4096 });

    await expectCode(async () => await readAll(chunks), 'size_limit_exceeded');
  });

  it('accepts a download of exactly the limit', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(4096, 7));
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    const body = await readAll(await fetcher.fetch(address(), { ...limits, max_bytes: 4096 }));

    expect(body.byteLength).toBe(4096);
  });

  it('times out when the server never answers', async () => {
    const server = await startServer(() => undefined);
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await expectCode(
      async () => await fetcher.fetch(address(), { ...limits, timeout_ms: 150 }),
      'timeout',
    );
  });

  it('times out when the body stalls after the headers', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.write('first');
    });
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    const chunks = await fetcher.fetch(address(), { ...limits, timeout_ms: 200 });

    await expectCode(async () => await readAll(chunks), 'timeout');
  });

  it('stops when the caller cancels', async () => {
    const server = await startServer(() => undefined);
    const controller = new AbortController();
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    const pending = failureOf(
      async () => await fetcher.fetch(address(), { ...limits, signal: controller.signal }),
    );
    setTimeout(() => {
      controller.abort();
    }, 50);

    expect((await pending).code).toBe('cancelled');
  });

  it('stops immediately when already cancelled', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('x');
    });
    const controller = new AbortController();
    controller.abort();
    const fetcher = createRegistryFetcher({ transport_origin: server.origin });

    await expectCode(
      async () => await fetcher.fetch(address(), { ...limits, signal: controller.signal }),
      'cancelled',
    );
  });

  it('reports a refused connection as a network error', async () => {
    const server = await startServer(() => undefined);
    const closedOrigin = server.origin;
    await new Promise<void>((resolve) => {
      servers.splice(0).forEach((item) => {
        item.closeAllConnections();
        item.close(() => {
          resolve();
        });
      });
    });
    const fetcher = createRegistryFetcher({ transport_origin: closedOrigin });

    await expectCode(async () => await fetcher.fetch(address(), limits), 'network_error');
  });
});

describe('createRegistryFetcher address checks', () => {
  it.each([
    ['plain http', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['another host', 'https://registry.example.test/a/-/a-1.0.0.tgz'],
    ['a look-alike host', 'https://registry.npmjs.org.evil.test/a/-/a-1.0.0.tgz'],
    ['credentials', 'https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['a port', 'https://registry.npmjs.org:8443/a/-/a-1.0.0.tgz'],
    ['a query', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz?x=1'],
    ['a fragment', 'https://registry.npmjs.org/a/-/a-1.0.0.tgz#x'],
    ['a backslash', 'https://registry.npmjs.org/a\\b/-/a-1.0.0.tgz'],
    ['a file address', 'file:///etc/passwd'],
    ['a git address', 'git+ssh://git@github.com/a/b.git'],
    ['no scheme', 'registry.npmjs.org/a/-/a-1.0.0.tgz'],
    ['an empty string', ''],
    ['the bare origin', REGISTRY_ORIGIN],
  ])('refuses %s without sending any request', async (_name, url) => {
    const fakeFetch = vi.fn<typeof globalThis.fetch>();
    const fetcher = createRegistryFetcher({ fetch: fakeFetch });

    await expectCode(async () => await fetcher.fetch(url, limits), 'url_refused');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('asks for the registry address by default', async () => {
    const fakeFetch = vi.fn<typeof globalThis.fetch>(
      async () => await Promise.resolve(new Response('x', { status: 200 })),
    );
    const fetcher = createRegistryFetcher({ fetch: fakeFetch });

    await readAll(await fetcher.fetch(address(), limits));

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch.mock.calls[0]?.[0]).toBe(address());
    expect(fakeFetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      method: 'GET',
      redirect: 'manual',
    });
  });
});
