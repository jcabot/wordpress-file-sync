import { describe, it, expect, vi } from 'vitest';
import { createRestClient, parseLinkNext, rewriteAsRestRoute } from './rest-client.js';
import { AuthError, TransportError } from './errors.js';

describe('parseLinkNext', () => {
  it('extracts the rel="next" URL', () => {
    const header =
      '<https://example.com/wp-json/wp/v2/posts?page=2>; rel="next", <https://example.com/wp-json/wp/v2/posts?page=3>; rel="last"';
    expect(parseLinkNext(header)).toBe('https://example.com/wp-json/wp/v2/posts?page=2');
  });

  it('returns null when there is no next link', () => {
    expect(parseLinkNext('<x>; rel="last"')).toBeNull();
    expect(parseLinkNext('')).toBeNull();
    expect(parseLinkNext(null)).toBeNull();
  });
});

function makeJsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('rest-client', () => {
  it('sends Basic Auth and context=edit when listing items', async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse([], { 'x-wp-totalpages': '1' }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'alice',
      password: 'pw',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.listItems('post', {})) void _;
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const url = String(call?.[0]);
    expect(url).toContain('/wp-json/wp/v2/posts');
    expect(url).toContain('context=edit');
    expect(url).toContain('per_page=100');
    const reqInit = call?.[1] as RequestInit;
    expect(reqInit.headers).toMatchObject({
      Authorization: 'Basic ' + Buffer.from('alice:pw').toString('base64'),
    });
  });

  it('paginates via the Link header (rel="next")', async () => {
    const page1 = makeJsonResponse([{ id: 1 }, { id: 2 }], {
      link: '<https://example.com/wp-json/wp/v2/posts?page=2>; rel="next"',
    });
    const page2 = makeJsonResponse([{ id: 3 }], { 'x-wp-totalpages': '2' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got: number[] = [];
    for await (const item of client.listItems('post', {})) {
      got.push((item as { id: number }).id);
    }
    expect(got).toEqual([1, 2, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to X-WP-TotalPages when no Link header', async () => {
    const page1 = makeJsonResponse([{ id: 1 }, { id: 2 }], { 'x-wp-totalpages': '3' });
    const page2 = makeJsonResponse([{ id: 3 }, { id: 4 }], { 'x-wp-totalpages': '3' });
    const page3 = makeJsonResponse([{ id: 5 }], { 'x-wp-totalpages': '3' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got: number[] = [];
    for await (const item of client.listItems('post', {})) {
      got.push((item as { id: number }).id);
    }
    expect(got).toEqual([1, 2, 3, 4, 5]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const lastCall = fetchImpl.mock.calls[2];
    expect(String(lastCall?.[0])).toContain('page=3');
  });

  it('maps 401 to AuthError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('forbidden', { status: 401 }),
    );
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.listItems('post', {})) void _;
    }).rejects.toBeInstanceOf(AuthError);
  });

  it('retries 5xx with exponential backoff then surfaces TransportError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('still down', { status: 502 }))
      .mockResolvedValueOnce(new Response('also down', { status: 502 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.listItems('post', {})) void _;
    }).rejects.toBeInstanceOf(TransportError);
    // 1 initial attempt + 2 retries = 3 total
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient 5xx', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(makeJsonResponse([{ id: 1 }], { 'x-wp-totalpages': '1' }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got: number[] = [];
    for await (const item of client.listItems('post', {})) {
      got.push((item as { id: number }).id);
    }
    expect(got).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on transient network errors (ECONNRESET) then surfaces TransportError', async () => {
    const networkErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr);
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(async () => {
      for await (const _ of client.listItems('post', {})) void _;
    }).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('describes ECONNREFUSED in the error message', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), {
      code: 'ECONNREFUSED',
    });
    const fetchImpl = vi.fn().mockRejectedValue(err);
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _ of client.listItems('post', {})) void _;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as TransportError).message).toMatch(/Connection refused/);
  });

  it('honors Retry-After on 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(makeJsonResponse([{ id: 1 }], { 'x-wp-totalpages': '1' }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const got: number[] = [];
    for await (const item of client.listItems('post', {})) {
      got.push((item as { id: number }).id);
    }
    expect(got).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('AuthError on 401 includes a hint about `wpsync auth set`', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      for await (const _ of client.listItems('post', {})) void _;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect((caught as AuthError).message).toMatch(/wpsync auth set/);
  });

  it('countItems returns X-WP-Total', async () => {
    const fetchImpl = vi.fn(async () =>
      makeJsonResponse([], { 'x-wp-total': '142', 'x-wp-totalpages': '142' }),
    );
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const total = await client.countItems('post', {});
    expect(total).toBe(142);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('per_page=1');
  });

  it('passes modified_after to listing requests', async () => {
    const fetchImpl = vi.fn(async () => makeJsonResponse([]));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    for await (const _ of client.listItems('post', { modifiedAfter: '2026-01-01T00:00:00' })) void _;
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('modified_after=2026-01-01T00%3A00%3A00');
  });

  it('createItem POSTs the payload as JSON to /<type>', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 999, modified_gmt: '2026-04-26T10:00:00' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.createItem('post', { title: 'T', content: 'C' });
    expect(out.id).toBe(999);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'T', content: 'C' });
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/wp-json/wp/v2/posts');
  });

  it('updateItem POSTs to /<type>/<id>', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 42, modified_gmt: '2026-04-26T11:00:00' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.updateItem('page', 42, { title: 'New' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/wp-json/wp/v2/pages/42');
  });

  it('createItem does not retry on 5xx (non-idempotent)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.createItem('post', {})).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deleteItem DELETEs /<type>/<id> and never sends force=true', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.deleteItem('post', 99);
    const call = fetchImpl.mock.calls[0];
    const url = String(call?.[0]);
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/wp-json/wp/v2/posts/99');
    expect(url).not.toContain('force=true');
    expect(url).not.toContain('force=1');
  });

  it('deleteItem does not retry on 5xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.deleteItem('post', 1)).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('rewriteAsRestRoute', () => {
  it('rewrites /wp-json/ paths to ?rest_route= form, preserving query params', () => {
    const url = new URL('https://example.com/wp-json/wp/v2/posts?context=edit&per_page=100');
    const out = rewriteAsRestRoute(url);
    expect(out).not.toBeNull();
    expect(out?.pathname).toBe('/');
    expect(out?.searchParams.get('rest_route')).toBe('/wp/v2/posts');
    expect(out?.searchParams.get('context')).toBe('edit');
    expect(out?.searchParams.get('per_page')).toBe('100');
  });

  it('returns null for URLs that are not /wp-json/ paths', () => {
    expect(rewriteAsRestRoute(new URL('https://example.com/'))).toBeNull();
    expect(rewriteAsRestRoute(new URL('https://example.com/?rest_route=/wp/v2/posts'))).toBeNull();
  });
});

describe('rest-client permalink fallback', () => {
  it('falls back to ?rest_route= when /wp-json/ returns 404, then locks the mode', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/wp-json/')) return new Response('not found', { status: 404 });
      if (url.includes('rest_route=')) {
        return new Response(JSON.stringify({ id: 9, slug: 'alice' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 500 });
    });
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const me = await client.getMe();
    expect(me).toEqual({ id: 9, slug: 'alice' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/wp-json/');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('rest_route=');

    const fetched: { id: number }[] = [];
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/wp-json/')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-wp-totalpages': '1' },
      });
    });
    for await (const item of client.listItems('post', {})) fetched.push(item as { id: number });
    expect(fetched).toEqual([{ id: 1 }, { id: 2 }]);
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toContain('rest_route=');
      expect(String(call[0])).not.toContain('/wp-json/');
    }
  });

  it('surfaces a unified error when both /wp-json/ and ?rest_route= return 404', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }));
    const client = createRestClient({
      siteUrl: 'https://example.com',
      username: 'a',
      password: 'b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getMe()).rejects.toMatchObject({
      name: 'TransportError',
      status: 404,
      message: expect.stringContaining('tried both /wp-json/ and ?rest_route=/'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
