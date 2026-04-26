import { AuthError, TransportError } from './errors.js';
import type { PostType, RestItem, TaxonomyTerm } from './types.js';

export type FetchImpl = typeof fetch;

export interface RestClientOptions {
  siteUrl: string;
  username: string;
  password: string;
  fetchImpl?: FetchImpl;
}

export interface ListItemsOptions {
  modifiedAfter?: string | null;
}

export interface RestClient {
  listItems(type: PostType, opts: ListItemsOptions): AsyncIterable<RestItem>;
  countItems(type: PostType, opts: ListItemsOptions): Promise<number>;
  listTaxonomy(type: 'categories' | 'tags'): AsyncIterable<TaxonomyTerm>;
  getMe(): Promise<{ id: number; slug: string }>;
  createItem(type: PostType, payload: Record<string, unknown>): Promise<RestItem>;
  updateItem(type: PostType, id: number, payload: Record<string, unknown>): Promise<RestItem>;
  deleteItem(type: PostType, id: number): Promise<void>;
}

const PER_PAGE = 100;
const DEFAULT_RETRIES = 2;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4000;
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function parseLinkNext(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (m && m[1]) return m[1];
  }
  return null;
}

function basicAuth(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

function endpointFor(type: PostType): string {
  return type === 'post' ? 'posts' : 'pages';
}

function buildUrl(siteUrl: string, path: string, params: Record<string, string> = {}): URL {
  const base = siteUrl.replace(/\/$/, '');
  const url = new URL(`${base}/wp-json/wp/v2/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '') url.searchParams.set(k, v);
  }
  return url;
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  // Exponential growth with ±25% jitter so concurrent clients don't sync up.
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = exponential * (0.5 * Math.random());
  return Math.round(exponential - exponential * 0.25 + jitter);
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const o = err as { code?: unknown; cause?: unknown };
    if (typeof o.code === 'string') return o.code;
    if (o.cause) return errorCode(o.cause);
  }
  return undefined;
}

function isTransientNetworkError(err: unknown): boolean {
  const code = errorCode(err);
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|socket hang up|network|timeout/i.test(message);
}

function describeNetworkError(url: string, err: unknown): string {
  const code = errorCode(err);
  switch (code) {
    case 'ECONNREFUSED':
      return `Connection refused to ${url} — is the site running and reachable?`;
    case 'ENOTFOUND':
      return `DNS lookup failed for ${url} — check the site URL.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Connection timed out to ${url}.`;
    case 'ECONNRESET':
      return `Connection reset while contacting ${url}.`;
    case 'EAI_AGAIN':
      return `DNS temporarily unavailable for ${url} — retry shortly.`;
    default:
      return `Network error contacting ${url}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: string | undefined;
  retry?: boolean;
}

interface AttemptResult {
  res?: Response;
  err?: unknown;
}

async function fetchAttempt(
  fetchImpl: FetchImpl,
  url: string | URL,
  init: RequestInit,
): Promise<AttemptResult> {
  try {
    return { res: await fetchImpl(url, init) };
  } catch (err) {
    return { err };
  }
}

async function request(
  fetchImpl: FetchImpl,
  url: string | URL,
  authHeader: string,
  opts: RequestOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };

  const maxRetries = (opts.retry ?? true) ? DEFAULT_RETRIES : 0;
  let attempt = 0;
  let lastErr: unknown;
  let lastRes: Response | undefined;

  while (attempt <= maxRetries) {
    const { res, err } = await fetchAttempt(fetchImpl, url, init);

    if (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientNetworkError(err)) {
        await delay(backoffDelay(attempt));
        attempt += 1;
        continue;
      }
      throw new TransportError(describeNetworkError(url.toString(), err), { cause: err });
    }

    if (!res) {
      // Defensive: fetchAttempt should have set either res or err.
      throw new TransportError(`Network error contacting ${url.toString()}: empty response`);
    }
    lastRes = res;
    // 429 — honor Retry-After when present.
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number.parseFloat(res.headers.get('retry-after') ?? '');
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : backoffDelay(attempt);
      await delay(wait);
      attempt += 1;
      continue;
    }
    // 5xx — retry with backoff.
    if (res.status >= 500 && res.status < 600 && attempt < maxRetries) {
      await delay(backoffDelay(attempt));
      attempt += 1;
      continue;
    }
    break;
  }

  const res = lastRes;
  if (!res) {
    // Shouldn't happen — we either threw or got a response above. Defensive.
    throw new TransportError(describeNetworkError(url.toString(), lastErr));
  }

  if (res.status === 401) {
    throw new AuthError(
      `Credentials rejected (HTTP 401) at ${url.toString()}. The Application Password may be wrong or revoked — \`wpsync auth set\` to update it.`,
    );
  }
  if (res.status === 403) {
    throw new AuthError(
      `Forbidden (HTTP 403) at ${url.toString()}. The user may lack \`edit_posts\` capability.`,
    );
  }
  if (res.status === 404 && /\/wp-json\/?$/.test(url.toString())) {
    throw new TransportError(
      `404 at ${url.toString()} — the site may not have the WordPress REST API enabled, or the URL is wrong.`,
      { status: 404 },
    );
  }
  if (!res.ok) {
    let bodySnippet = '';
    try {
      bodySnippet = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new TransportError(
      `HTTP ${res.status} from ${url.toString()}${bodySnippet ? `: ${bodySnippet}` : ''}`,
      { status: res.status },
    );
  }
  return res;
}

async function* paginatedGet<T>(
  fetchImpl: FetchImpl,
  authHeader: string,
  initialUrl: URL,
): AsyncIterable<T> {
  let url: string | URL = initialUrl;
  let pageNum = 1;
  let totalPages: number | null = null;
  const baseUrl = new URL(initialUrl.toString());

  for (;;) {
    const res = await request(fetchImpl, url, authHeader, { retry: true });
    const items = (await res.json()) as T[];
    for (const item of items) yield item;

    const nextFromLink = parseLinkNext(res.headers.get('link'));
    if (nextFromLink) {
      url = nextFromLink;
      pageNum += 1;
      continue;
    }

    if (totalPages === null) {
      const tp = res.headers.get('x-wp-totalpages');
      totalPages = tp ? Number.parseInt(tp, 10) : 1;
    }
    pageNum += 1;
    if (pageNum > totalPages) break;
    const nextUrl = new URL(baseUrl.toString());
    nextUrl.searchParams.set('page', String(pageNum));
    url = nextUrl;
  }
}

export function createRestClient(opts: RestClientOptions): RestClient {
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const authHeader = basicAuth(opts.username, opts.password);

  function listingParams(modifiedAfter: string | null | undefined): Record<string, string> {
    const params: Record<string, string> = {
      context: 'edit',
      per_page: String(PER_PAGE),
      page: '1',
      orderby: 'modified',
      order: 'asc',
      status: 'any',
    };
    if (modifiedAfter) params['modified_after'] = modifiedAfter;
    return params;
  }

  return {
    listItems(type, listOpts) {
      const url = buildUrl(opts.siteUrl, endpointFor(type), listingParams(listOpts.modifiedAfter));
      return paginatedGet<RestItem>(fetchImpl, authHeader, url);
    },

    async countItems(type, listOpts) {
      const params = { ...listingParams(listOpts.modifiedAfter), per_page: '1' };
      const url = buildUrl(opts.siteUrl, endpointFor(type), params);
      const res = await request(fetchImpl, url, authHeader, { retry: true });
      await res.text();
      const total = res.headers.get('x-wp-total');
      return total ? Number.parseInt(total, 10) : 0;
    },

    listTaxonomy(taxType) {
      const url = buildUrl(opts.siteUrl, taxType, {
        per_page: String(PER_PAGE),
        page: '1',
        orderby: 'id',
        order: 'asc',
      });
      return paginatedGet<TaxonomyTerm>(fetchImpl, authHeader, url);
    },

    async getMe() {
      const url = buildUrl(opts.siteUrl, 'users/me', { context: 'edit' });
      const res = await request(fetchImpl, url, authHeader, { retry: true });
      const body = (await res.json()) as { id: number; slug: string };
      return { id: body.id, slug: body.slug };
    },

    async createItem(type, payload) {
      const url = buildUrl(opts.siteUrl, endpointFor(type), { context: 'edit' });
      const res = await request(fetchImpl, url, authHeader, {
        method: 'POST',
        body: JSON.stringify(payload),
        retry: false,
      });
      return (await res.json()) as RestItem;
    },

    async updateItem(type, id, payload) {
      const url = buildUrl(opts.siteUrl, `${endpointFor(type)}/${id}`, { context: 'edit' });
      const res = await request(fetchImpl, url, authHeader, {
        method: 'POST',
        body: JSON.stringify(payload),
        retry: false,
      });
      return (await res.json()) as RestItem;
    },

    async deleteItem(type, id) {
      // PRD §4.5, §8 AC: never send `force=true` — trashes only, recoverable for 30 days.
      const url = buildUrl(opts.siteUrl, `${endpointFor(type)}/${id}`);
      const res = await request(fetchImpl, url, authHeader, {
        method: 'DELETE',
        retry: false,
      });
      await res.text();
    },
  };
}
