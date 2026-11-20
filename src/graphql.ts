// GraphQL v4 at /api/graphql — the shapes gh and github-mcp-server send.
// A small hand-rolled parser + executor over the same Store the REST surface
// uses, so every mutation is visible over REST and vice versa. Stdlib only.
//
// Supported surface (see the kit's checks-graphql.ts for the exact documents):
//   Query.viewer, Query.repository(owner:, name:), Query.node(id:), Query.__type
//   Repository{ id, databaseId, name, nameWithOwner, owner, defaultBranchRef,
//                viewerPermission, hasIssuesEnabled, issue, issues, pullRequests, pullRequest }
//   Issue{ id, number, title, state, body }, PullRequest{ id, number, state, merged,
//                headRefName, baseRefName, mergeable, files }
//   Mutation.createIssue / closeIssue / createPullRequest / mergePullRequest / addComment
//   Operation batching: a JSON array of {query, variables} answers an array, in order.
//   Unknown fields are GraphQL errors (HTTP 200 with an errors array), never HTTP 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, nodeId, parseNodeId, type Issue, type Pull, type Repo } from './store.ts';
import { mergePull, pullFiles } from './rest.ts';
import { sendJson } from './app.ts';

// ---------------------------------------------------------------------------
// Document parsing (a small subset of GraphQL: operations, variables, aliases,
// arguments as variables/literals/enums/lists/input objects, inline fragments).
// ---------------------------------------------------------------------------

type GqlValue =
  | null
  | boolean
  | number
  | string
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __var: string }
  | { __enum: string };

interface FieldNode {
  /** Response key (alias when present, else the field name). */
  key: string;
  name: string;
  args: Record<string, GqlValue>;
  children: FieldNode[] | null;
  /** For `... on Type`: the type condition; null for a plain field. */
  inlineType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  fields: FieldNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'punct' | 'spread';
  value: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && text.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          const esc = text[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += text[j]!;
          j += 1;
        }
      }
      if (j >= text.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (text[j] === '-') j += 1;
      while (j < text.length && /[0-9.]/.test(text[j]!)) j += 1;
      tokens.push({ kind: 'int', value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j += 1;
      tokens.push({ kind: 'name', value: text.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next?.kind === 'name') name = this.next().value;
    }
    const variables: string[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        variables.push(this.expectName());
        this.expectPunct(':');
        // A variable type: a name, possibly wrapped in [ ] and suffixed with !.
        // Consume name/[ ]/! tokens; stop at ')' (next variable or the end),
        // '=' (a default value) or '$' (the next variable).
        for (;;) {
          const t = this.peek();
          if (t === undefined) throw new Error('unexpected end of GraphQL document');
          if (t.kind === 'name') {
            this.next();
            continue;
          }
          if (t.kind === 'punct' && (t.value === '[' || t.value === ']' || t.value === '!')) {
            this.next();
            continue;
          }
          break;
        }
        // An optional default value.
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const fields = this.parseSelectionSet();
    return { kind, name, variables, fields };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      let inlineType: string | null = null;
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        inlineType = this.expectName();
      } else {
        // A named fragment spread: not used by the suite; skip its selection set.
        this.expectName();
      }
      const children = this.parseSelectionSet();
      return { key: '', name: '', args: {}, children, inlineType };
    }
    const first = this.expectName();
    let key = first;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      name = this.expectName();
      key = first;
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let children: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      children = this.parseSelectionSet();
    }
    return { key, name, args, children, inlineType: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number(token.value);
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: { [key: string]: GqlValue } = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value ${token.value} in GraphQL document`);
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Source {
  __typename: string;
  [key: string]: unknown;
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>, path: (string | number)[]): unknown {
  if (value !== null && typeof value === 'object' && '__var' in value) {
    return variables[(value as { __var: string }).__var];
  }
  if (value !== null && typeof value === 'object' && '__enum' in value) {
    return (value as { __enum: string }).__enum;
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(item, variables, [...path, index]));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables, [...path, key]);
    return out;
  }
  return value;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function issueCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function userSource(login: string): Source {
  return { __typename: 'User', login };
}

function stateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Issues in the requested order, as (issue, seq) pairs for stable sorting. */
function orderedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  const statesRaw = args.states;
  const wanted = Array.isArray(statesRaw)
    ? new Set(statesRaw.filter((entry): entry is string => typeof entry === 'string'))
    : null;
  let list = [...repo.issues.values()];
  if (wanted !== null) list = list.filter((issue) => wanted.has(stateOf(issue)));
  const orderBy = asRecord(args.orderBy);
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  // No orderBy means oldest first; an explicit orderBy defaults to DESC
  // unless ASC is given.
  const direction = orderBy === null ? 1 : orderBy.direction === 'ASC' ? 1 : -1;
  const seqOf = (issue: Issue): number => {
    if (field === 'UPDATED_AT') return issue.updatedSeq;
    if (field === 'COMMENTS') return issue.comments.length;
    return issue.createdSeq;
  };
  list.sort((a, b) => {
    const diff = seqOf(a) - seqOf(b);
    if (diff !== 0) return diff * direction;
    return (a.number - b.number) * direction;
  });
  return list;
}

/** Resolve one field of a source object. Returns undefined when the field is unknown. */
function resolveField(ctx: ExecContext, source: Source, field: FieldNode, path: (string | number)[]): unknown {
  const { store } = ctx;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) {
    args[key] = resolveValue(value, ctx.variables, [...path, key]);
  }
  const repo = source.repo as Repo | undefined;
  const issue = source.issue as Issue | undefined;
  const pull = source.pull as Pull | undefined;

  switch (source.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return userSource(VIEWER.login);
      if (field.name === 'repository') {
        const owner = asString(args.owner);
        const name = asString(args.name);
        if (owner === null || name === null) return null;
        if (owner !== VIEWER.login) return null;
        const found = store.getRepo(name);
        return found === undefined ? null : repoSource(found);
      }
      if (field.name === 'node') {
        const id = asString(args.id);
        if (id === null) return null;
        const parsed = parseNodeId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const [owner, name] = parsed.key.split('/', 2);
          if (owner !== VIEWER.login || name === undefined) return null;
          const found = store.getRepo(name);
          return found === undefined ? null : repoSource(found);
        }
        if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
          const hash = parsed.key.indexOf('#');
          if (hash < 0) return null;
          const ownerRepo = parsed.key.slice(0, hash);
          const number = Number.parseInt(parsed.key.slice(hash + 1), 10);
          const [owner, name] = ownerRepo.split('/', 2);
          if (owner !== VIEWER.login || name === undefined || !Number.isInteger(number)) return null;
          const found = store.getRepo(name);
          if (found === undefined) return null;
          if (parsed.kind === 'Issue') {
            const foundIssue = found.issues.get(number);
            return foundIssue === undefined ? null : issueSource(found, foundIssue);
          }
          const foundPull = found.pulls.get(number);
          return foundPull === undefined ? null : pullSource(found, foundPull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = asString(args.name);
        if (name === null) return null;
        return typeSource(name);
      }
      return undefined;
    }
    case 'User': {
      if (field.name === 'login') return source.login;
      if (field.name === 'id') return nodeId('User', String(source.login));
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      if (field.name === 'avatarUrl') return `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`;
      if (field.name === 'url') return `/api/v3/users/${source.login}`;
      return undefined;
    }
    case 'Repository': {
      if (repo === undefined) return undefined;
      if (field.name === 'id') return nodeId('Repository', `${repo.owner}/${repo.name}`);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return userSource(repo.owner);
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field.name === 'description') return repo.description;
      if (field.name === 'createdAt') return store.isoOf(repo.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(repo.updatedSeq);
      if (field.name === 'isPrivate') return repo.isPrivate;
      if (field.name === 'defaultBranch') return repo.defaultBranch;
      if (field.name === 'issue') {
        const number = asNumber(args.number);
        if (number === null) return null;
        const found = repo.issues.get(number);
        return found === undefined ? null : issueSource(repo, found);
      }
      if (field.name === 'issues') {
        const ordered = orderedIssues(repo, args);
        const after = asString(args.after);
        let start = 0;
        if (after !== null) {
          const number = cursorNumber(after);
          const index = number === null ? -1 : ordered.findIndex((entry) => entry.number === number);
          start = index < 0 ? 0 : index + 1;
        }
        const first = asNumber(args.first);
        const page = first === null ? ordered.slice(start) : ordered.slice(start, start + first);
        const endCursor = page.length === 0 ? null : issueCursor(page[page.length - 1]!.number);
        const hasNextPage = first !== null && start + first < ordered.length;
        return {
          __typename: 'IssueConnection',
          items: page.map((entry) => issueSource(repo, entry)),
          hasNextPage,
          endCursor,
        };
      }
      if (field.name === 'pullRequests') {
        const first = asNumber(args.first);
        const open = [...repo.pulls.values()].filter((entry) => entry.state === 'open');
        open.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = first === null ? open : open.slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          items: page.map((entry) => pullSource(repo, entry)),
          hasNextPage: first !== null && first < open.length,
          endCursor: null,
        };
      }
      if (field.name === 'pullRequest') {
        const number = asNumber(args.number);
        if (number === null) return null;
        const found = repo.pulls.get(number);
        return found === undefined ? null : pullSource(repo, found);
      }
      return undefined;
    }
    case 'Issue': {
      if (repo === undefined || issue === undefined) return undefined;
      if (field.name === 'id') return nodeId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return stateOf(issue);
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt') return store.isoOf(issue.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(issue.updatedSeq);
      if (field.name === 'author') return userSource(issue.user);
      if (field.name === 'repository') return repoSource(repo);
      if (field.name === 'closedAt') return issue.closedSeq === null ? null : store.isoOf(issue.closedSeq);
      if (field.name === 'labels') return { __typename: 'LabelConnection', items: [] };
      if (field.name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          items: issue.comments.map((comment) => ({
            __typename: 'IssueComment',
            id: nodeId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`),
            body: comment.body,
          })),
          hasNextPage: false,
          endCursor: null,
        };
      }
      return undefined;
    }
    case 'PullRequest': {
      if (repo === undefined || pull === undefined) return undefined;
      if (field.name === 'id') return nodeId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'state') return pullStateOf(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'body') return pull.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'createdAt') return store.isoOf(pull.createdSeq);
      if (field.name === 'updatedAt') return store.isoOf(pull.updatedSeq);
      if (field.name === 'author') return userSource(pull.user);
      if (field.name === 'repository') return repoSource(repo);
      if (field.name === 'mergedAt') return pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq);
      if (field.name === 'closedAt') return pull.closedSeq === null ? null : store.isoOf(pull.closedSeq);
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.baseRef };
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.headRef };
      if (field.name === 'files') {
        const first = asNumber(args.first);
        const files = pullFiles(repo, pull);
        const items = files.map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: typeof file.filename === 'string' ? file.filename : '',
          additions: typeof file.additions === 'number' ? file.additions : 0,
          deletions: typeof file.deletions === 'number' ? file.deletions : 0,
          changeType: typeof file.status === 'string' ? file.status.toUpperCase() : 'MODIFIED',
        }));
        const page = first === null ? items : items.slice(0, first);
        return { __typename: 'PullRequestChangedFileConnection', items: page, hasNextPage: false, endCursor: null };
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (field.name === 'nodes') return (source.items as Source[]) ?? [];
      if (field.name === 'edges') {
        const items = (source.items as Source[]) ?? [];
        return items.map((item) => ({ __typename: 'Edge', node: item, cursor: '' }));
      }
      if (field.name === 'totalCount') return ((source.items as unknown[]) ?? []).length;
      if (field.name === 'pageInfo') {
        return {
          __typename: 'PageInfo',
          hasNextPage: source.hasNextPage === true,
          endCursor: typeof source.endCursor === 'string' ? source.endCursor : null,
          hasPreviousPage: false,
          startCursor: null,
        };
      }
      return undefined;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name;
      if (field.name === 'id') return nodeId('Ref', String(source.name));
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return source.path;
      if (field.name === 'additions') return source.additions;
      if (field.name === 'deletions') return source.deletions;
      if (field.name === 'changeType') return source.changeType;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.hasNextPage;
      if (field.name === 'endCursor') return source.endCursor;
      if (field.name === 'hasPreviousPage') return source.hasPreviousPage;
      if (field.name === 'startCursor') return source.startCursor;
      return undefined;
    }
    case 'Edge': {
      if (field.name === 'node') return source.node;
      if (field.name === 'cursor') return source.cursor;
      return undefined;
    }
    case 'IssueComment': {
      if (field.name === 'id') return source.id;
      if (field.name === 'body') return source.body;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return source.node;
      if (field.name === 'cursor') return '';
      return undefined;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return source.issue;
      return undefined;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return source.issue;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return source.pullRequest;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return source.pullRequest;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return source.commentEdge;
      return undefined;
    }
    case '__Type': {
      if (field.name === 'name') return source.name;
      if (field.name === 'kind') return source.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const fields = source.fields as string[] | null;
        if (fields === null) return null;
        return fields.map((name) => ({ __typename: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        const values = source.enumValues as string[] | null;
        if (values === null) return null;
        return values.map((name) => ({ __typename: '__EnumValue', name }));
      }
      return undefined;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      return undefined;
    }
    case 'Mutation': {
      return undefined;
    }
    default:
      return undefined;
  }
}

function resolveSelection(
  ctx: ExecContext,
  source: Source,
  fields: FieldNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.inlineType !== null) {
      // An inline fragment applies only when the source is of that type.
      if (field.inlineType === source.__typename && field.children !== null) {
        Object.assign(out, resolveSelection(ctx, source, field.children, path));
      }
      continue;
    }
    const fieldPath = [...path, field.key];
    if (field.children === null) {
      const value = resolveField(ctx, source, field, fieldPath);
      if (value === undefined) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${source.__typename}".`, path: fieldPath });
        out[field.key] = null;
      } else {
        out[field.key] = value;
      }
      continue;
    }
    const value = resolveField(ctx, source, field, fieldPath);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${source.__typename}".`, path: fieldPath });
      out[field.key] = null;
      continue;
    }
    if (value === null) {
      out[field.key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[field.key] = value.map((item, index) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? resolveSelection(ctx, item as Source, field.children!, [...fieldPath, index])
          : item,
      );
      continue;
    }
    if (typeof value === 'object' && '__typename' in value) {
      out[field.key] = resolveSelection(ctx, value as Source, field.children!, fieldPath);
      continue;
    }
    out[field.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Introspection data (static; the fields gh feature-detects).
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'assignees', 'milestone', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'baseRef', 'headRef', 'commits', 'changedFiles', 'repository', 'mergedAt', 'closedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'defaultBranch', 'isPrivate', 'fork', 'homepageUrl'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeSource(name: string): Source | null {
  if (name in TYPE_FIELDS) {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: [...TYPE_FIELDS[name]!], enumValues: null };
  }
  if (name in TYPE_ENUM_VALUES) {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: [...TYPE_ENUM_VALUES[name]!] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mutations.
// ---------------------------------------------------------------------------

function findRepoByNodeId(store: Store, id: string): Repo | null {
  const parsed = parseNodeId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const [owner, name] = parsed.key.split('/', 2);
  if (owner !== VIEWER.login || name === undefined) return null;
  return store.getRepo(name) ?? null;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseNodeId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const hash = parsed.key.indexOf('#');
  if (hash < 0) return null;
  const [owner, name] = parsed.key.slice(0, hash).split('/', 2);
  const number = Number.parseInt(parsed.key.slice(hash + 1), 10);
  if (owner !== VIEWER.login || name === undefined || !Number.isInteger(number)) return null;
  const repo = store.getRepo(name);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  return issue === undefined ? null : { repo, issue };
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseNodeId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const hash = parsed.key.indexOf('#');
  if (hash < 0) return null;
  const [owner, name] = parsed.key.slice(0, hash).split('/', 2);
  const number = Number.parseInt(parsed.key.slice(hash + 1), 10);
  if (owner !== VIEWER.login || name === undefined || !Number.isInteger(number)) return null;
  const repo = store.getRepo(name);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(number);
  return pull === undefined ? null : { repo, pull };
}

function runMutation(ctx: ExecContext, field: FieldNode, path: (string | number)[]): Source | null {
  const { store } = ctx;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) {
    args[key] = resolveValue(value, ctx.variables, [...path, key]);
  }
  const input = asRecord(args.input) ?? {};
  const fieldPath = [...path, field.key];

  if (field.name === 'createIssue') {
    const repositoryId = asString(input.repositoryId);
    const title = asString(input.title);
    const body = asString(input.body) ?? '';
    if (repositoryId === null || title === null) {
      ctx.errors.push({ message: 'createIssue needs input.repositoryId and input.title.', path: fieldPath });
      return null;
    }
    const repo = findRepoByNodeId(store, repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: `createIssue: no repository for id ${repositoryId}.`, path: fieldPath });
      return null;
    }
    const issue = store.createIssue(repo, title, body, []);
    return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue) };
  }

  if (field.name === 'closeIssue') {
    const issueId = asString(input.issueId);
    if (issueId === null) {
      ctx.errors.push({ message: 'closeIssue needs input.issueId.', path: fieldPath });
      return null;
    }
    const found = findIssueByNodeId(store, issueId);
    if (found === null) {
      ctx.errors.push({ message: `closeIssue: no issue for id ${issueId}.`, path: fieldPath });
      return null;
    }
    if (found.issue.state !== 'closed') {
      const t = store.tick();
      found.issue.state = 'closed';
      found.issue.closedSeq = t.seq;
      found.issue.updatedSeq = t.seq;
    }
    return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue) };
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = asString(input.repositoryId);
    const title = asString(input.title);
    const headRefName = asString(input.headRefName);
    const baseRefName = asString(input.baseRefName);
    const body = asString(input.body) ?? '';
    if (repositoryId === null || title === null || headRefName === null || baseRefName === null) {
      ctx.errors.push({ message: 'createPullRequest needs input.repositoryId, title, headRefName and baseRefName.', path: fieldPath });
      return null;
    }
    const repo = findRepoByNodeId(store, repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: `createPullRequest: no repository for id ${repositoryId}.`, path: fieldPath });
      return null;
    }
    if (!repo.refs.has(`refs/heads/${headRefName}`)) {
      ctx.errors.push({ message: `createPullRequest: head branch ${headRefName} does not exist.`, path: fieldPath });
      return null;
    }
    const pull = store.createPull(repo, title, body, headRefName, baseRefName);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull) };
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = asString(input.pullRequestId);
    if (pullRequestId === null) {
      ctx.errors.push({ message: 'mergePullRequest needs input.pullRequestId.', path: fieldPath });
      return null;
    }
    const found = findPullByNodeId(store, pullRequestId);
    if (found === null) {
      ctx.errors.push({ message: `mergePullRequest: no pull request for id ${pullRequestId}.`, path: fieldPath });
      return null;
    }
    if (found.pull.state === 'closed') {
      ctx.errors.push({ message: `mergePullRequest: pull request #${found.pull.number} is already closed.`, path: fieldPath });
      return null;
    }
    const merged = mergePull(store, found.repo, found.pull, found.pull.title);
    if (!merged.ok) {
      found.pull.mergeable = false;
      ctx.errors.push({ message: `mergePullRequest: pull request #${found.pull.number} has a merge conflict.`, path: fieldPath });
      return null;
    }
    const t = store.tick();
    found.pull.state = 'closed';
    found.pull.merged = true;
    found.pull.mergedSeq = t.seq;
    found.pull.closedSeq = t.seq;
    found.pull.mergeSha = merged.sha;
    found.pull.updatedSeq = t.seq;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull) };
  }

  if (field.name === 'addComment') {
    const subjectId = asString(input.subjectId);
    const body = asString(input.body);
    if (subjectId === null || body === null) {
      ctx.errors.push({ message: 'addComment needs input.subjectId and body.', path: fieldPath });
      return null;
    }
    const found = findIssueByNodeId(store, subjectId);
    if (found === null) {
      ctx.errors.push({ message: `addComment: no issue for id ${subjectId}.`, path: fieldPath });
      return null;
    }
    const comment = store.addComment(found.repo, found.issue, body);
    const node: Source = {
      __typename: 'IssueComment',
      id: nodeId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${comment.id}`),
      body: comment.body,
    };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node } };
  }

  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".`, path: fieldPath });
  return null;
}

// ---------------------------------------------------------------------------
// HTTP entry point.
// ---------------------------------------------------------------------------

function runOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.kind === 'query') {
    const root: Source = { __typename: 'Query' };
    Object.assign(data, resolveSelection(ctx, root, operation.fields, []));
  } else {
    for (const field of operation.fields) {
      if (field.inlineType !== null) continue;
      const payload = runMutation(ctx, field, []);
      if (payload === null) {
        data[field.key] = null;
        continue;
      }
      if (field.children === null) {
        data[field.key] = payload;
        continue;
      }
      data[field.key] = resolveSelection(ctx, payload, field.children, [field.key]);
    }
  }
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

export function handleGraphql(store: Store, _req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { message: 'Request body is not valid JSON' });
    return;
  }
  const operations: { query: string; variables?: Record<string, unknown>; operationName?: string }[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const record = asRecord(entry);
      if (record === null || typeof record.query !== 'string') {
        sendJson(res, 400, { message: 'Each batched operation needs a query string' });
        return;
      }
      operations.push({
        query: record.query,
        variables: asRecord(record.variables) ?? {},
        operationName: typeof record.operationName === 'string' ? record.operationName : undefined,
      });
    }
  } else {
    const record = asRecord(parsed);
    if (record === null || typeof record.query !== 'string') {
      sendJson(res, 400, { message: 'A GraphQL request needs a query string' });
      return;
    }
    operations.push({
      query: record.query,
      variables: asRecord(record.variables) ?? {},
      operationName: typeof record.operationName === 'string' ? record.operationName : undefined,
    });
  }
  if (operations.length === 0) {
    sendJson(res, 400, { message: 'A GraphQL request needs at least one operation' });
    return;
  }
  const answers: Record<string, unknown>[] = [];
  for (const operation of operations) {
    let documents: Operation[];
    try {
      documents = new Parser(tokenize(operation.query)).parseDocument();
    } catch (err) {
      answers.push({
        data: null,
        errors: [{ message: err instanceof Error ? err.message : 'Could not parse the GraphQL document.' }],
      });
      continue;
    }
    const chosen =
      operation.operationName === undefined
        ? documents[0]
        : documents.find((document) => document.name === operation.operationName) ?? documents[0];
    if (chosen === undefined) {
      answers.push({ data: null, errors: [{ message: 'No operation in the GraphQL document.' }] });
      continue;
    }
    answers.push(runOperation(store, chosen, operation.variables ?? {}));
  }
  sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0]);
}
