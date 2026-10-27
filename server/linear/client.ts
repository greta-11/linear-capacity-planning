// Minimal Linear GraphQL client: auth, retries on rate limits, readable errors.

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

export type LinearErrorCode = 'auth' | 'rate-limit' | 'network' | 'graphql';

export class LinearError extends Error {
  constructor(
    message: string,
    public code: LinearErrorCode,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string; type?: string; userPresentableMessage?: string } }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(LINEAR_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new LinearError(`Could not reach Linear (${(err as Error).message}).`, 'network');
    }

    if (res.status === 401 || res.status === 403) {
      throw new LinearError('Linear rejected the API key. Check LINEAR_API_KEY in .env (Settings → Security & access → Personal API keys).', 'auth');
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await res.json()) as GraphQLResponse<T>;
    } catch {
      throw new LinearError(`Linear returned HTTP ${res.status} with a non-JSON body.`, 'network');
    }

    const rateLimited = res.status === 429 || body.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
    if (rateLimited) {
      if (attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      throw new LinearError('Linear rate limit reached. Wait a few minutes and sync again.', 'rate-limit');
    }

    if (body.errors?.length) {
      const authFailed = body.errors.some((e) => e.extensions?.code === 'AUTHENTICATION_ERROR' || /authentication/i.test(e.message));
      const message = body.errors.map((e) => e.extensions?.userPresentableMessage ?? e.message).join('; ');
      throw new LinearError(authFailed ? `Linear rejected the API key: ${message}` : `Linear API error: ${message}`, authFailed ? 'auth' : 'graphql');
    }
    if (!res.ok || !body.data) throw new LinearError(`Linear returned HTTP ${res.status}.`, 'network');
    return body.data;
  }
}

interface Page<N> {
  nodes: N[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Follows a connection's cursor until exhausted. `select` picks the connection out of the response. */
export async function paginate<T, N>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  select: (data: T) => Page<N>,
  maxPages = 200,
): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: T = await gql<T>(apiKey, query, { ...variables, after });
    const conn = select(data);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}
