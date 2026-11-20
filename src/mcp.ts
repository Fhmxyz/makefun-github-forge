// MCP at /mcp — JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
// Speaks the modern 2026-07-28 revision (`server/discover`, no handshake, no
// session) and the legacy handshake (`initialize` + `notifications/initialized`)
// for older clients. Tools act on the same Store as REST and GraphQL.
//
// Tools (github-mcp-server's names; a `full_name` "owner/repo" argument is
// accepted wherever owner+repo are):
//   create_repo {name, description?, private?}
//   get_repo {owner, repo}
//   create_issue {owner, repo, title, body?}
//   list_issues {owner, repo, state?}
//   create_pull_request {owner, repo, title, head, base, body?}
//   merge_pull_request {owner, repo, pull_number}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';
import { sendJson } from './app.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const PREFERRED_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
      full_name: { type: 'string', description: 'The repository full name "owner/repo" (alternative to owner and repo).' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolList(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Split owner/repo out of the arguments (owner+repo, or a full_name). */
function repoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner !== null && repo !== null) return { owner, repo };
  const fullName = asString(args.full_name);
  if (fullName !== null) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  return null;
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Execute one tool call against the store. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) {
    // Unknown tools are reported by the caller as a JSON-RPC error; this is unreachable.
    return toolError(`unknown tool ${name}`);
  }
  // Required arguments that accept a full_name instead of owner+repo.
  const missing: string[] = [];
  for (const required of def.required) {
    if (required === 'owner' || required === 'repo') {
      if (repoOf(args) === null) missing.push(required);
      continue;
    }
    if (args[required] === undefined || args[required] === null || args[required] === '') missing.push(required);
  }
  if (missing.length > 0) {
    return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }

  if (name === 'create_repo') {
    const repoName = asString(args.name);
    if (repoName === null || repoName === '') return toolError('create_repo needs a non-empty name');
    const existing = store.getRepo(repoName);
    if (existing !== undefined) return toolResult(repoJson(store, existing));
    const repo = store.createRepo(repoName, asString(args.description) ?? '', asBoolean(args.private));
    return toolResult(repoJson(store, repo));
  }

  const target = repoOf(args);
  if (target === null) return toolError('could not determine the repository (owner/repo or full_name required)');
  const repo = target.owner === VIEWER.login ? store.getRepo(target.repo) : undefined;
  if (repo === undefined) return toolError(`repository ${target.owner}/${target.repo} not found`);

  if (name === 'get_repo') {
    return toolResult(repoJson(store, repo));
  }

  if (name === 'create_issue') {
    const title = asString(args.title);
    if (title === null || title === '') return toolError('create_issue needs a non-empty title');
    const issue = store.createIssue(repo, title, asString(args.body) ?? '', []);
    return toolResult(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    const state = asString(args.state) ?? 'open';
    let issues: Issue[] = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => a.number - b.number);
    return toolResult(issues.map((issue) => issueJson(store, repo, issue)));
  }

  if (name === 'create_pull_request') {
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (title === null || title === '' || head === null || base === null) {
      return toolError('create_pull_request needs title, head and base');
    }
    if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
    const pull = store.createPull(repo, title, asString(args.body) ?? '', head, base);
    return toolResult(pullJson(store, repo, pull));
  }

  if (name === 'merge_pull_request') {
    const number = asNumber(args.pull_number);
    if (number === null) return toolError('merge_pull_request needs a pull_number');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolError(`pull request #${number} not found`);
    if (pull.state === 'closed') return toolError(`pull request #${number} is already closed`);
    const merged = mergePull(store, repo, pull, pull.title);
    if (!merged.ok) {
      pull.mergeable = false;
      return toolError(`pull request #${number} has a merge conflict`);
    }
    const t = store.tick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = t.seq;
    pull.closedSeq = t.seq;
    pull.mergeSha = merged.sha;
    pull.updatedSeq = t.seq;
    return toolResult(pullJson(store, repo, pull));
  }

  return toolError(`tool ${name} is not implemented`);
}

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Salvage a JSON-RPC id from an unparseable body, for the -32700 answer. */
function salvageId(text: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return Number(raw);
}

export function handleMcp(store: Store, _req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const text = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(jsonRpcError(salvageId(text), -32700, 'Parse error'))}\n`);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, jsonRpcError(isRecord(parsed) ? parsed.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications carry no id and get no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const info = serverInfo();
    sendJson(res, 200, jsonRpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: capabilities(),
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    }));
    return;
  }

  if (method === 'initialize') {
    const requested = asString(params.protocolVersion);
    const negotiated = requested !== null && SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_VERSION;
    sendJson(res, 200, jsonRpcResult(id, {
      protocolVersion: negotiated,
      capabilities: capabilities(),
      serverInfo: serverInfo(),
    }));
    return;
  }

  if (method === 'ping') {
    sendJson(res, 200, jsonRpcResult(id, {}));
    return;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, jsonRpcResult(id, { tools: toolList() }));
    return;
  }

  if (method === 'tools/call') {
    const name = asString(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === null || name === '') {
      sendJson(res, 200, jsonRpcError(id, -32602, 'tools/call needs a tool name'));
      return;
    }
    if (!TOOLS.some((tool) => tool.name === name)) {
      sendJson(res, 200, jsonRpcError(id, -32602, `unknown tool ${name}`));
      return;
    }
    const result = callTool(store, name, args);
    sendJson(res, 200, jsonRpcResult(id, result));
    return;
  }

  sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${method}`));
}
