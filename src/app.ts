// src/app.ts — the forge's HTTP server: routing, auth, and the git smart-HTTP
// surface. REST v3, GraphQL v4 and MCP live in rest.ts, graphql.ts and mcp.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER } from './store.ts';
import {
  fetchV0Response,
  fetchV2Response,
  lsRefsResponse,
  parsePushBody,
  parseV0Fetch,
  parseV2Request,
  pushReportResponse,
  applyPush,
  v0Advertisement,
  v2Advertisement,
} from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** One request id per reply: deterministic counter, never a clock or random value. */
let requestSeq = 0;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestSeq}`,
    ...headers,
  });
  res.end(text);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestSeq}`,
    ...headers,
  });
  res.end(body);
}

export function sendNoContent(res: ServerResponse): void {
  requestSeq += 1;
  res.writeHead(204, { 'x-github-request-id': `req-${requestSeq}` });
  res.end();
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

export function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

/** The bearer token this request carries, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

/**
 * Whether the request is authenticated. In a trial MAKEFUN_SHOP_TOKEN is set and
 * the token must match it exactly. Locally (no token configured) any non-empty
 * bearer token is accepted, so the forge can be exercised by hand.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (TOKEN === '') return true;
  return token === TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    });
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // The env's boot probe: 200 {"ok": true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/{service}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch) {
    await handleGit(store, req, res, gitMatch[1], gitMatch[2], gitMatch[3], query);
    return;
  }

  // Everything below is an API surface and needs the bearer token.
  if (!isAuthenticated(req)) {
    unauthorized(res);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    handleGraphql(store, req, res, body);
    return;
  }
  if (path === '/mcp' && method === 'POST') {
    const body = await readBody(req);
    handleMcp(store, req, res, body);
    return;
  }
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? null : await readBody(req);
    handleRest(store, req, res, path, method, query, body);
    return;
  }

  notFound(res);
}

async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string,
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  // A repository belongs to the token's login; any other owner is a 404.
  const repo = owner === VIEWER.login ? store.getRepo(repoName) : undefined;
  if (service === 'info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const wanted = query.get('service');
    if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'Missing service parameter' });
      return;
    }
    if (repo === undefined) {
      notFound(res);
      return;
    }
    const isV2 = wanted === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = isV2 ? v2Advertisement() : v0Advertisement(repo, wanted);
    sendBytes(res, 200, body, `application/x-${wanted}-advertisement`);
    return;
  }

  if (repo === undefined) {
    notFound(res);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const body = await readBody(req);
  try {
    if (service === 'git-upload-pack') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      if (isV2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') {
          const prefixes = args.get('ref-prefix') ?? [];
          const out = lsRefsResponse(repo, {
            prefixes,
            peel: args.has('peel'),
            symrefs: args.has('symrefs'),
            unborn: args.has('unborn'),
          });
          sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          const wants = args.get('want') ?? [];
          const haves = args.get('have') ?? [];
          const shallow = args.get('shallow') ?? [];
          const deepen = args.get('deepen')?.[0];
          const out = fetchV2Response(repo, {
            wants,
            haves,
            shallow,
            depth: deepen !== undefined ? Number.parseInt(deepen, 10) : undefined,
            depthRelative: args.has('deepen-relative'),
          });
          sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        sendJson(res, 400, { message: `unknown v2 command ${command}` });
        return;
      }
      const request = parseV0Fetch(body);
      const out = fetchV0Response(repo, request);
      sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    // git-receive-pack (v0 only).
    const { commands, pack } = parsePushBody(body);
    const outcome = applyPush(repo, commands, pack);
    const out = pushReportResponse(outcome);
    sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
  } catch (err) {
    // A malformed git request must not take the server down.
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad Request' });
  }
}
