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
  onPage?: (page: {
    page: number;
    items: number;
    totalPages: number | null;
    skipped?: boolean;
  }) => void;
}

export interface RestClient {
  listItems(type: PostType, opts: ListItemsOptions): AsyncIterable<RestItem>;
  countItems(type: PostType, opts: ListItemsOptions): Promise<number>;
  listTaxonomy(type: 'categories' | 'tags'): AsyncIterable<TaxonomyTerm>;
  getMe(): Promise<{ id: number; slug: string }>;
  createItem(type: PostType, payload: Record<string, unknown>): Promise<RestItem>;
  updateItem(type: PostType, id: number, payload: Record<string, unknown>): Promise<RestItem>;
  deleteItem(type: PostType, id: number): Promise<void>;
  getItem(type: PostType, id: number): Promise<RestItem>;
}

const ITEM_PER_PAGE = 1;
const TAXONOMY_PER_PAGE = 100;
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

export function rewriteAsRestRoute(url: URL): URL | null {
  const m = url.pathname.match(/^\/wp-json\/(.+)$/);
  if (!m) return null;
  const next = new URL(`${url.origin}/`);
  next.searchParams.set('rest_route', `/${m[1]}`);
  for (const [k, v] of url.searchParams.entries()) {
    if (k !== 'rest_route') next.searchParams.append(k, v);
  }
  return next;
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

function modifiedAfterRejected(err: unknown, modifiedAfter: string | null | undefined): boolean {
  if (!modifiedAfter) return false;
  if (!(err instanceof TransportError) || err.status !== 400) return false;
  return /modified_after/i.test(err.message) && /(invalid|format|date|rest_invalid_param)/i.test(err.message);
}

function malformedRestPage(err: unknown): boolean {
  if (!(err instanceof TransportError)) return false;
  if (err.status !== 404 && err.status !== 502) return false;
  return /Non-JSON|valid JSON|REST API/i.test(err.message);
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
    'User-Agent': 'wpsync/1.0 (+https://github.com/jcabot/wordpress-file-sync)',
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
  const urlStr = url.toString();
  const method = (opts.method ?? 'GET').toUpperCase();
  const looksLikeRest = /\/wp-json\//.test(urlStr) || /[?&]rest_route=/.test(urlStr);
  if (method === 'GET' && looksLikeRest) {
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    const isJsonContentType = /json/i.test(contentType);
    let isJsonBody = false;
    if (isJsonContentType) {
      try {
        JSON.parse(text);
        isJsonBody = true;
      } catch {
        isJsonBody = false;
      }
    }
    if (!isJsonContentType || !isJsonBody) {
      const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new TransportError(
        `Non-JSON response from ${urlStr} (Content-Type: ${contentType || 'missing'})${snippet ? `: ${snippet}` : ''} — WordPress may be returning a page instead of REST output (pretty permalinks disabled, a cache/CDN, or a security plugin?).`,
        { status: 404 },
      );
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  return res;
}

async function parseJson<T>(res: Response, urlForError: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.slice(0, 100).replace(/\s+/g, ' ').trim();
    throw new TransportError(
      `Non-JSON response from ${urlForError} (Content-Type claimed JSON but body was not)${snippet ? `: ${snippet}` : ''} — WordPress may be behind a cache or CDN that's returning an HTML page in place of the REST API.`,
      { status: 502 },
    );
  }
}

async function* paginatedGet<T>(
  getResponse: (url: string | URL) => Promise<Response>,
  initialUrl: URL,
  onPage?: (page: {
    page: number;
    items: number;
    totalPages: number | null;
    skipped?: boolean;
  }) => void,
): AsyncIterable<T> {
  let url: string | URL = initialUrl;
  let pageNum = 1;
  let totalPages: number | null = null;
  const baseUrl = new URL(initialUrl.toString());

  for (;;) {
    let res: Response;
    let items: T[];
    try {
      res = await getResponse(url);
      items = await parseJson<T[]>(res, url.toString());
    } catch (err) {
      if (!malformedRestPage(err) || totalPages === null) throw err;
      onPage?.({ page: pageNum, items: 0, totalPages, skipped: true });
      pageNum += 1;
      if (pageNum > totalPages) break;
      const currentUrl = typeof url === 'string' ? url : url.toString();
      const nextPageUrl: URL = new URL(currentUrl);
      nextPageUrl.searchParams.set('page', String(pageNum));
      url = nextPageUrl;
      continue;
    }

    if (totalPages === null) {
      const tp = res.headers.get('x-wp-totalpages');
      totalPages = tp ? Number.parseInt(tp, 10) : null;
    }
    onPage?.({ page: pageNum, items: items.length, totalPages });

    for (const item of items) yield item;

    const nextFromLink = parseLinkNext(res.headers.get('link'));
    if (nextFromLink) {
      url = nextFromLink;
      pageNum += 1;
      continue;
    }

    if (totalPages === null) totalPages = 1;
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

  let useRewrite = false;
  let modeLocked = false;

  function maybeRewrite(url: string | URL): string | URL {
    if (!useRewrite) return url;
    const u = url instanceof URL ? url : new URL(url);
    return rewriteAsRestRoute(u) ?? url;
  }

  async function send(url: string | URL, reqOpts: RequestOpts = {}): Promise<Response> {
    const initialUrl = maybeRewrite(url);
    try {
      const res = await request(fetchImpl, initialUrl, authHeader, reqOpts);
      modeLocked = true;
      return res;
    } catch (err) {
      if (
        !modeLocked &&
        !useRewrite &&
        err instanceof TransportError &&
        err.status === 404 &&
        url instanceof URL
      ) {
        const fallback = rewriteAsRestRoute(url);
        if (fallback) {
          useRewrite = true;
          modeLocked = true;
          try {
            return await request(fetchImpl, fallback, authHeader, reqOpts);
          } catch (err2) {
            if (err2 instanceof TransportError && err2.status === 404) {
              throw new TransportError(
                `REST API not reachable at ${opts.siteUrl} — tried both /wp-json/ and ?rest_route=/, neither returned valid JSON. Verify the site URL and that WordPress's REST API is enabled.`,
                { status: 404 },
              );
            }
            throw err2;
          }
        }
      }
      throw err;
    }
  }

  function listingParams(modifiedAfter: string | null | undefined): Record<string, string> {
    const params: Record<string, string> = {
      context: 'edit',
      per_page: String(ITEM_PER_PAGE),
      page: '1',
      orderby: 'modified',
      order: 'asc',
    };
    if (modifiedAfter) params['modified_after'] = modifiedAfter;
    return params;
  }

  interface ListingVariant {
    modifiedAfter: string | null | undefined;
  }

  function nextListingVariant(
    variant: ListingVariant,
    err: unknown,
  ): ListingVariant | null {
    if (modifiedAfterRejected(err, variant.modifiedAfter)) {
      return { ...variant, modifiedAfter: null };
    }
    return null;
  }

  return {
    listItems(type, listOpts) {
      const getItems = (variant: ListingVariant) => {
        const url = buildUrl(
          opts.siteUrl,
          endpointFor(type),
          listingParams(variant.modifiedAfter),
        );
        return paginatedGet<RestItem>((u) => send(u, { retry: true }), url, listOpts.onPage);
      };
      return (async function* () {
        let variant: ListingVariant = {
          modifiedAfter: listOpts.modifiedAfter,
        };
        const seen = new Set<string>();
        for (;;) {
          seen.add(variant.modifiedAfter ?? '');
          try {
            yield* getItems(variant);
            return;
          } catch (err) {
            const next = nextListingVariant(variant, err);
            const key = next?.modifiedAfter ?? '';
            if (!next || seen.has(key)) throw err;
            variant = next;
          }
        }
      })();
    },

    async countItems(type, listOpts) {
      const count = async (variant: ListingVariant) => {
        const params = {
          ...listingParams(variant.modifiedAfter),
          per_page: '1',
        };
        const url = buildUrl(opts.siteUrl, endpointFor(type), params);
        const res = await send(url, { retry: true });
        await res.text();
        const total = res.headers.get('x-wp-total');
        return total ? Number.parseInt(total, 10) : 0;
      };
      let variant: ListingVariant = {
        modifiedAfter: listOpts.modifiedAfter,
      };
      const seen = new Set<string>();
      for (;;) {
        seen.add(variant.modifiedAfter ?? '');
        try {
          return await count(variant);
        } catch (err) {
          const next = nextListingVariant(variant, err);
          const key = next?.modifiedAfter ?? '';
          if (!next || seen.has(key)) throw err;
          variant = next;
        }
      }
    },

    listTaxonomy(taxType) {
      const url = buildUrl(opts.siteUrl, taxType, {
        per_page: String(TAXONOMY_PER_PAGE),
        page: '1',
        orderby: 'id',
        order: 'asc',
      });
      return paginatedGet<TaxonomyTerm>((u) => send(u, { retry: true }), url);
    },

    async getMe() {
      const url = buildUrl(opts.siteUrl, 'users/me', { context: 'edit' });
      const res = await send(url, { retry: true });
      const body = await parseJson<{ id: number; slug: string }>(res, url.toString());
      return { id: body.id, slug: body.slug };
    },

    async createItem(type, payload) {
      // POST to the collection endpoint creates a new record; retrying after a 5xx
      // could create duplicates if the first request actually succeeded.
      const url = buildUrl(opts.siteUrl, endpointFor(type), { context: 'edit' });
      const res = await send(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        retry: false,
      });
      return parseJson<RestItem>(res, url.toString());
    },

    async updateItem(type, id, payload) {
      const url = buildUrl(opts.siteUrl, `${endpointFor(type)}/${id}`, { context: 'edit' });
      const res = await send(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        retry: true,
      });
      return parseJson<RestItem>(res, url.toString());
    },

    async deleteItem(type, id) {
      // PRD §4.5, §8 AC: never send `force=true` — trashes only, recoverable for 30 days.
      const url = buildUrl(opts.siteUrl, `${endpointFor(type)}/${id}`);
      const res = await send(url, {
        method: 'DELETE',
        retry: true,
      });
      await res.text();
    },

    async getItem(type, id) {
      const url = buildUrl(opts.siteUrl, `${endpointFor(type)}/${id}`, { context: 'edit' });
      const res = await send(url, { retry: true });
      return parseJson<RestItem>(res, url.toString());
    },
  };
}
