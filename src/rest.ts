// src/rest.ts — the GitHub REST v3 API: repositories, branches, commits,
// contents, issues, comments, labels and pull requests, over the store.
//
// Shapes follow api.github.com: ids are sequential integers, node ids are
// base64 `<kind>:<key>` (reversible, so GraphQL can resolve them), and every
// timestamp comes from the store's logical clock.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER, nodeId, type Issue, type IssueComment, type Label, type Pull, type Repo } from './store.ts';
import { badRequest, notFound, sendJson, sendNoContent } from './app.ts';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './git.ts';

// ---------------------------------------------------------------- shapes

function userJson(login: string): Record<string, unknown> {
  const id = login === VIEWER.login ? VIEWER.id : 1001;
  return {
    login,
    id,
    node_id: nodeId('User', login),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function openIssueCount(repo: Repo): number {
  let count = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') count += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') count += 1;
  return count;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.isoOf(repo.createdSeq),
    updated_at: store.isoOf(repo.updatedSeq),
    pushed_at: store.isoOf(repo.updatedSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssueCount(repo),
    license: null,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, push: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name.toLowerCase());
  if (!label) return null;
  return {
    id: label.id,
    node_id: nodeId('Label', `${repo.owner}/${repo.name}:${label.name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueBase(store: Store, repo: Repo, issue: Issue, pull?: Pull): Record<string, unknown> {
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;
  const body: Record<string, unknown> = {
    id: issue.id,
    node_id: nodeId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((label) => label !== null),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: store.isoOf(issue.createdSeq),
    updated_at: store.isoOf(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.isoOf(issue.closedSeq),
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl}/issues/${issue.number}`,
    repository_url: baseUrl,
    labels_url: `${baseUrl}/issues/${issue.number}/labels{/name}`,
    comments_url: `${baseUrl}/issues/${issue.number}/comments`,
    events_url: `${baseUrl}/issues/${issue.number}/events`,
    timeline_url: `${baseUrl}/issues/${issue.number}/timeline`,
  };
  if (pull) {
    body.pull_request = {
      url: `${baseUrl}/pulls/${pull.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      diff_url: `${baseUrl}/pulls/${pull.number}.diff`,
      patch_url: `${baseUrl}/pulls/${pull.number}.patch`,
      merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    };
  }
  return body;
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return issueBase(store, repo, issue);
}

export function pullAsIssueJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const pseudo: Issue = {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: pull.user,
    createdSeq: pull.createdSeq,
    updatedSeq: pull.updatedSeq,
    closedSeq: pull.closedSeq,
    comments: pull.comments,
  };
  return issueBase(store, repo, pseudo, pull);
}

function commentJson(store: Store, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', `${repo.owner}/${repo.name}#${issueNumber}:${comment.id}`),
    url: `${baseUrl}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: store.isoOf(comment.createdSeq),
    updated_at: store.isoOf(comment.updatedSeq),
    author_association: 'OWNER',
    issue_url: `${baseUrl}/issues/${issueNumber}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;
  const headRepo = repoJson(store, repo);
  const baseRepo = repoJson(store, repo);
  const commits = pull.headSha === null ? 0 : countCommits(repo, pull.headSha, pull.baseSha);
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    labels: [],
    assignees: [],
    milestone: null,
    created_at: store.isoOf(pull.createdSeq),
    updated_at: store.isoOf(pull.updatedSeq),
    closed_at: pull.closedSeq === null ? null : store.isoOf(pull.closedSeq),
    merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeSha,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner),
      repo: baseRepo,
    },
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    comments: pull.comments.length,
    review_comments: 0,
    commits,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl}/pulls/${pull.number}`,
    diff_url: `${baseUrl}/pulls/${pull.number}.diff`,
    patch_url: `${baseUrl}/pulls/${pull.number}.patch`,
    issue_url: `${baseUrl}/issues/${pull.number}`,
    statuses_url: `${baseUrl}/commits/${pull.headSha ?? ''}/statuses`,
    review_comment_url: `${baseUrl}/pulls/comments{/number}`,
    review_comments_url: `${baseUrl}/pulls/${pull.number}/comments`,
    comments_url: `${baseUrl}/issues/${pull.number}/comments`,
    author_association: 'OWNER',
  };
}

/** How many commits the head has that the base does not (bounded walk). */
function countCommits(repo: Repo, headSha: string, baseSha: string | null): number {
  const baseSet = baseSha === null ? new Set<string>() : collectReachable([baseSha], (oid) => repo.objects.get(oid));
  let count = 0;
  const seen = new Set<string>();
  const queue = [headSha];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || baseSet.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    count += 1;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return count;
}

function commitDateOf(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return new Date(0).toISOString();
  const author = parseCommit(object.data).author;
  const match = / (\d+) [+-]\d{4}$/.exec(author);
  const epoch = match ? Number(match[1]) : 0;
  return new Date(epoch * 1000).toISOString();
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const date = commitDateOf(repo, oid);
  const authorName = commit.author.replace(/ <.*$/, '');
  const authorEmail = /<([^>]*)>/.exec(commit.author)?.[1] ?? '';
  const committerName = commit.committer.replace(/ <.*$/, '');
  const committerEmail = /<([^>]*)>/.exec(commit.committer)?.[1] ?? '';
  return {
    sha: oid,
    node_id: nodeId('Commit', `${repo.owner}/${repo.name}:${oid}`),
    commit: {
      // GitHub's API returns the message without the trailing newline the
      // on-disk commit format appends.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: authorName, email: authorEmail, date },
      committer: { name: committerName, email: committerEmail, date },
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string): Page<T> {
  const perPageRaw = Number(query.get('per_page') ?? 30);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? 1);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    const last = new URLSearchParams(query);
    last.set('page', String(Math.ceil(items.length / perPage)));
    last.set('per_page', String(perPage));
    link = `<${path}?${next.toString()}>; rel="next", <${path}?${last.toString()}>; rel="last"`;
  }
  return { items: [...slice], link };
}

// ---------------------------------------------------------------- git trees for contents

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build trees bottom-up from a flat path map; stores every tree object. */
export function buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** The tip commit of a branch name, or null. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The merge base of two commits: the first common ancestor found walking both. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** additions/deletions between two texts, by multiset line difference. */
function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = lineCounts(oldText);
  const newCounts = lineCounts(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const had = oldCounts.get(line) ?? 0;
    if (count > had) additions += count - had;
  }
  for (const [line, count] of oldCounts) {
    const has = newCounts.get(line) ?? 0;
    if (count > has) deletions += count - has;
  }
  return { additions, deletions };
}

export function parseJsonBody(body: Buffer | null): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body === null || body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------- router

function repoOf(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(name) ?? null;
}

function contentsObject(
  store: Store,
  repo: Repo,
  path: string,
  blobOid: string,
  size: number,
): Record<string, unknown> {
  const object = repo.objects.get(blobOid);
  const content = object ? object.data.toString('base64') : '';
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content,
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
    _links: {
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

/** Create a commit on `branch` from a flat file map; returns the commit oid. */
function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeFromMap(repo, files);
  const parent = branchTip(repo, branch);
  const t = store.tick();
  const timestamp = Math.floor(Date.parse(store.isoOf(t.seq)) / 1000);
  const who = `${VIEWER.name} <${VIEWER.email}>`;
  const data = buildCommit({
    tree: treeOid,
    parents: parent === null ? [] : [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: who,
    committer: who,
    timestamp,
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The files a pull request changes, base tree vs head tree. */
/** The changed files of a pull request (base-vs-head tree diff). Shared with GraphQL. */
export function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  if (pull.baseSha === null || pull.headSha === null) return [];
  const baseTree = treeOfCommit(repo, pull.baseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  if (baseTree === null || headTree === null) return [];
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.oid === head.oid) continue;
    const baseText = base ? (repo.objects.get(base.oid)?.data.toString('utf8') ?? '') : '';
    const headText = head ? (repo.objects.get(head.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = diffLineCounts(baseText, headText);
    out.push({
      sha: head?.oid ?? base!.oid,
      filename: path,
      status: !base ? 'added' : !head ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${path}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${path}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pull.headSha}`,
    });
  }
  return out;
}

/**
 * Squash-merge a pull request: a 3-way merge of the head's changes onto the
 * base tip. A path changed on both sides to different blobs is a conflict.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull, message: string): { ok: true; sha: string } | { ok: false } {
  if (pull.baseSha === null || pull.headSha === null) return { ok: false };
  // The base tip is read live: a pull request created before another pull
  // merged must conflict against the current base, not the stale base tip
  // recorded at creation time.
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = pull.headSha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : treeOfCommit(repo, base);
  const baseTipTree = treeOfCommit(repo, baseTip);
  const headTree = treeOfCommit(repo, headTip);
  if (baseTipTree === null || headTree === null) return { ok: false };
  const baseMap = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const baseTipMap = flattenTree(repo, baseTipTree);
  const headMap = flattenTree(repo, headTree);
  const merged = new Map(baseTipMap);
  const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...baseTipMap.keys()]);
  for (const path of paths) {
    const fromBase = baseMap.get(path);
    const headVersion = headMap.get(path);
    const baseTipVersion = baseTipMap.get(path);
    const headChanged = (fromBase?.oid ?? null) !== (headVersion?.oid ?? null);
    const baseChanged = (fromBase?.oid ?? null) !== (baseTipVersion?.oid ?? null);
    if (headChanged && baseChanged && (headVersion?.oid ?? null) !== (baseTipVersion?.oid ?? null)) {
      return { ok: false };
    }
    if (headChanged) {
      if (headVersion) merged.set(path, headVersion);
      else merged.delete(path);
    }
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const t = store.tick();
  const timestamp = Math.floor(Date.parse(store.isoOf(t.seq)) / 1000);
  const who = `${VIEWER.name} <${VIEWER.email}>`;
  const data = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: who,
    committer: who,
    timestamp,
  });
  const sha = hashObject('commit', data);
  repo.objects.set(sha, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return { ok: true, sha };
}

export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  body: Buffer | null,
): void {
  const segments = path.split('/').filter((segment) => segment !== '');
  // segments[0] is 'api', segments[1] is 'v3'.
  const rest = segments.slice(2);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    badRequest(res, 'Invalid JSON');
    return;
  }
  const input = parsed.value;
  // Link headers carry absolute URLs (GitHub's form; a relative URL fails the
  // suite's sameOrigin check on the followed page).
  const linkBase = `http://${req.headers.host ?? '127.0.0.1'}${path}`;

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}',
        notifications_url: '/api/v3/notifications{?since,all,participating}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
    return;
  }

  // GET /api/v3/rate_limit
  if (rest.length === 1 && rest[0] === 'rate_limit' && method === 'GET') {
    const reset = Math.floor(Date.parse('2026-11-15T06:30:00.000Z') / 1000);
    sendJson(res, 200, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset, used: 1 },
        search: { limit: 30, remaining: 30, reset, used: 0 },
        graphql: { limit: 5000, remaining: 4999, reset, used: 1 },
      },
      rate: { limit: 5000, remaining: 4999, reset, used: 1 },
    });
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      ...userJson(VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      bio: null,
      company: null,
      location: null,
      public_repos: store.listRepos().length,
      followers: 0,
      following: 0,
      created_at: store.isoOf(1),
      updated_at: store.isoOf(1),
    });
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const page = paginate(store.listRepos(), query, linkBase);
      sendJson(res, 200, page.items.map((repo) => repoJson(store, repo)), page.link ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      const name = asString(input.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }] });
        return;
      }
      if (store.getRepo(name)) {
        sendJson(res, 422, { message: 'Repository already exists.', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return;
      }
      const repo = store.createRepo(name, asString(input.description), asBool(input.private, false));
      sendJson(res, 201, repoJson(store, repo));
      return;
    }
    notFound(res);
    return;
  }

  // GET /api/v3/users/{login}
  if (rest.length === 2 && rest[0] === 'users' && method === 'GET') {
    if (rest[1] === VIEWER.login) {
      sendJson(res, 200, { ...userJson(VIEWER.login), name: VIEWER.name, email: VIEWER.email });
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const name = rest[2];
    const repo = repoOf(store, owner, name);
    if (repo === null) {
      notFound(res);
      return;
    }
    handleRepoRoute(store, req, res, repo, rest.slice(3), method, query, input, linkBase);
    return;
  }

  notFound(res);
}

function handleRepoRoute(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  input: Record<string, unknown>,
  path: string,
): void {
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // /repos/{owner}/{repo} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input.default_branch === 'string') repo.defaultBranch = input.default_branch;
      const t = store.tick();
      repo.updatedSeq = t.seq;
      sendJson(res, 200, repoJson(store, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.name);
      sendNoContent(res);
      return;
    }
    notFound(res);
    return;
  }

  const section = rest[0];

  // ---- branches
  if (section === 'branches') {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({
        name: branch,
        commit: { sha: repo.refs.get(`refs/heads/${branch}`), url: `${baseUrl}/commits/${repo.refs.get(`refs/heads/${branch}`)}` },
        protected: false,
      }));
    if (rest.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const page = paginate(branches, query, path);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    const branch = rest.slice(1).join('/');
    const found = branches.find((entry) => entry.name === branch);
    if (!found) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, found);
      return;
    }
    notFound(res);
    return;
  }

  // ---- commits
  if (section === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const refName = asString(query.get('sha') ?? '') || repo.defaultBranch;
      const tip = branchTip(repo, refName) ?? (repo.objects.has(refName) ? refName : null);
      const commits: Record<string, unknown>[] = [];
      if (tip !== null) {
        const seen = new Set<string>();
        const queue = [tip];
        while (queue.length) {
          const oid = queue.pop()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const object = repo.objects.get(oid);
          if (!object || object.type !== 'commit') continue;
          const view = commitJson(store, repo, oid);
          if (view) commits.push(view);
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      }
      const page = paginate(commits, query, path);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    const sha = rest[1];
    let view = commitJson(store, repo, sha);
    if (!view) {
      // A short sha: the one object it prefixes.
      const matches = [...repo.objects.keys()].filter((oid) => oid.startsWith(sha));
      if (matches.length === 1) view = commitJson(store, repo, matches[0]);
    }
    if (!view) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, view);
      return;
    }
    notFound(res);
    return;
  }

  // ---- git refs / trees / commits
  if (section === 'git') {
    if (rest[1] === 'refs' && rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, oid]) => ({
            ref,
            node_id: nodeId('Ref', `${repo.owner}/${repo.name}:${ref}`),
            url: `${baseUrl}/git/${ref}`,
            object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: `${baseUrl}/git/commits/${oid}` },
          }));
        const page = paginate(refs, query, path);
        sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
        return;
      }
      if (method === 'POST') {
        const ref = asString(input.ref);
        const sha = asString(input.sha);
        if (ref === '' || !ref.startsWith('refs/')) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'invalid' }] });
          return;
        }
        if (sha === '' || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'sha', code: 'invalid' }] });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'already_exists' }] });
          return;
        }
        repo.refs.set(ref, sha);
        const object = repo.objects.get(sha);
        sendJson(res, 201, {
          ref,
          node_id: nodeId('Ref', `${repo.owner}/${repo.name}:${ref}`),
          url: `${baseUrl}/git/${ref}`,
          object: { sha, type: object?.type ?? 'commit', url: `${baseUrl}/git/commits/${sha}` },
        });
        return;
      }
      notFound(res);
      return;
    }
    if (rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
      const refName = rest.slice(2).join('/');
      const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
      const oid = repo.refs.get(full);
      if (!oid) {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        ref: full,
        node_id: nodeId('Ref', `${repo.owner}/${repo.name}:${full}`),
        url: `${baseUrl}/git/${full}`,
        object: { sha: oid, type: 'commit', url: `${baseUrl}/git/commits/${oid}` },
      });
      return;
    }
    if (rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
      const treeOid = rest[2];
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') {
        notFound(res);
        return;
      }
      sendJson(res, 200, {
        sha: treeOid,
        url: `${baseUrl}/git/trees/${treeOid}`,
        tree: parseTree(object.data).map((entry) => ({
          path: entry.name,
          mode: entry.mode,
          type: entry.mode === '40000' ? 'tree' : 'blob',
          sha: entry.oid,
          size: entry.mode === '40000' ? undefined : (repo.objects.get(entry.oid)?.data.length ?? 0),
          url: `${baseUrl}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
        })),
        truncated: false,
      });
      return;
    }
    if (rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
      const view = commitJson(store, repo, rest[2]);
      if (!view) {
        notFound(res);
        return;
      }
      sendJson(res, 200, view);
      return;
    }
    notFound(res);
    return;
  }

  // ---- contents
  if (section === 'contents') {
    const contentPath = rest.slice(1).join('/');
    handleContents(store, res, repo, contentPath, method, query, input);
    return;
  }

  // ---- labels
  if (section === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const page = paginate(
          [...repo.labels.values()].sort((a, b) => a.id - b.id).map((label) => labelJson(repo, label.name)),
          query,
          path,
        );
        sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
        return;
      }
      if (method === 'POST') {
        const name = asString(input.name);
        if (name === '') {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] });
          return;
        }
        if (repo.labels.has(name.toLowerCase())) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] });
          return;
        }
        const label = store.createLabel(repo, name, asString(input.color) || 'ededed', asString(input.description));
        sendJson(res, 201, labelJson(repo, label.name));
        return;
      }
      notFound(res);
      return;
    }
    const labelName = decodeURIComponent(rest.slice(1).join('/'));
    const label = repo.labels.get(labelName.toLowerCase());
    if (!label) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, labelJson(repo, label.name));
      return;
    }
    if (method === 'DELETE') {
      repo.labels.delete(labelName.toLowerCase());
      sendNoContent(res);
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.name === 'string' && input.name !== '') {
        repo.labels.delete(labelName.toLowerCase());
        label.name = input.name;
        repo.labels.set(label.name.toLowerCase(), label);
      }
      if (typeof input.color === 'string') label.color = input.color;
      if (typeof input.description === 'string') label.description = input.description;
      sendJson(res, 200, labelJson(repo, label.name));
      return;
    }
    notFound(res);
    return;
  }

  // ---- issues
  if (section === 'issues') {
    handleIssues(store, res, repo, rest.slice(1), method, query, input, path);
    return;
  }

  // ---- pulls
  if (section === 'pulls') {
    handlePulls(store, res, repo, rest.slice(1), method, query, input, path);
    return;
  }

  notFound(res);
}

function handleContents(
  store: Store,
  res: ServerResponse,
  repo: Repo,
  contentPath: string,
  method: string,
  query: URLSearchParams,
  input: Record<string, unknown>,
): void {
  const branch = asString(input.branch ?? query.get('ref') ?? '') || repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const treeOid = tip === null ? null : treeOfCommit(repo, tip);
  const files = treeOid === null ? new Map() : flattenTree(repo, treeOid);

  if (method === 'GET') {
    if (tip === null) {
      notFound(res);
      return;
    }
    const entry = files.get(contentPath);
    if (entry) {
      const object = repo.objects.get(entry.oid);
      sendJson(res, 200, contentsObject(store, repo, contentPath, entry.oid, object?.data.length ?? 0));
      return;
    }
    // A directory lists its entries.
    const prefix = `${contentPath}/`;
    const children = [...files.keys()].filter((path) => path.startsWith(prefix));
    if (children.length === 0 && contentPath !== '') {
      notFound(res);
      return;
    }
    const names = new Map<string, { oid: string; mode: string; path: string }>();
    for (const child of children) {
      const rest = child.slice(prefix.length);
      const first = rest.split('/')[0];
      if (!names.has(first)) {
        const full = `${contentPath}/${first}`;
        const direct = files.get(full);
        names.set(first, { oid: direct?.oid ?? '', mode: direct ? direct.mode : '40000', path: full });
      }
    }
    sendJson(
      res,
      200,
      [...names.values()].map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
        name: child.path.split('/').pop(),
        path: child.path,
        sha: child.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${child.path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${child.mode === '40000' ? 'trees' : 'blobs'}/${child.oid}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${branch}/${child.path}`,
        download_url: child.mode === '40000' ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${child.path}`,
      })),
    );
    return;
  }

  if (method === 'PUT') {
    const message = asString(input.message) || `Update ${contentPath}`;
    const content = asString(input.content);
    if (content === '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'content', code: 'missing_field' }] });
      return;
    }
    const data = Buffer.from(content, 'base64');
    const existing = files.get(contentPath);
    if (existing) {
      if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existing.oid) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
    } else if (typeof input.sha === 'string' && input.sha !== '') {
      sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'sha', code: 'invalid' }] });
      return;
    }
    const blobOid = hashObject('blob', data);
    repo.objects.set(blobOid, { type: 'blob', data });
    const next = new Map(files);
    next.set(contentPath, { oid: blobOid, mode: '100644' });
    const sha = commitFiles(store, repo, branch, next, message);
    sendJson(res, existing ? 200 : 201, {
      content: contentsObject(store, repo, contentPath, blobOid, data.length),
      commit: { sha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
    return;
  }

  if (method === 'DELETE') {
    const existing = files.get(contentPath);
    if (!existing) {
      notFound(res);
      return;
    }
    if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existing.oid) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    const message = asString(input.message) || `Delete ${contentPath}`;
    const next = new Map(files);
    next.delete(contentPath);
    const sha = commitFiles(store, repo, branch, next, message);
    sendJson(res, 200, { commit: { sha, message, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    return;
  }

  notFound(res);
}

function handleIssues(
  store: Store,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  input: Record<string, unknown>,
  path: string,
): void {
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // /issues/comments/{id}
  if (rest.length === 2 && rest[0] === 'comments' && method === 'GET') {
    const id = Number(rest[1]);
    for (const issue of repo.issues.values()) {
      const found = issue.comments.find((comment) => comment.id === id);
      if (found) {
        sendJson(res, 200, commentJson(store, repo, issue.number, found));
        return;
      }
    }
    for (const pull of repo.pulls.values()) {
      const found = pull.comments.find((comment) => comment.id === id);
      if (found) {
        sendJson(res, 200, commentJson(store, repo, pull.number, found));
        return;
      }
    }
    notFound(res);
    return;
  }

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const labels = (query.get('labels') ?? '').split(',').filter((label) => label !== '');
      const items: Record<string, unknown>[] = [];
      for (const issue of [...repo.issues.values()].sort((a, b) => b.number - a.number)) {
        if (state !== 'all' && issue.state !== state) continue;
        if (labels.length && !labels.every((label) => issue.labels.some((own) => own.toLowerCase() === label.toLowerCase()))) continue;
        items.push(issueJson(store, repo, issue));
      }
      for (const pull of [...repo.pulls.values()].sort((a, b) => b.number - a.number)) {
        if (state !== 'all' && pull.state !== state) continue;
        items.push(pullAsIssueJson(store, repo, pull));
      }
      // ?sort=created|updated|comments & ?direction=asc|desc (default: created desc).
      const sortField = query.get('sort') ?? 'created';
      const direction = query.get('direction') === 'asc' ? 1 : -1;
      const seqOf = (item: Record<string, unknown>): number => {
        if (sortField === 'comments') return typeof item.comments === 'number' ? item.comments : 0;
        if (sortField === 'updated') return Date.parse(String(item.updated_at ?? '')) || 0;
        return Date.parse(String(item.created_at ?? '')) || 0;
      };
      items.sort((a, b) => {
        const diff = seqOf(a) - seqOf(b);
        if (diff !== 0) return diff * direction;
        return ((a.number as number) - (b.number as number)) * direction;
      });
      const page = paginate(items, query, path);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      const title = asString(input.title);
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] });
        return;
      }
      const labels = Array.isArray(input.labels) ? input.labels.map((label) => String(label)) : [];
      const unknown = labels.filter((label) => !repo.labels.has(label.toLowerCase()));
      if (unknown.length) {
        sendJson(res, 422, { message: `Validation Failed: label "${unknown[0]}" does not exist`, errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
        return;
      }
      const issue = store.createIssue(repo, title, asString(input.body), labels);
      sendJson(res, 201, issueJson(store, repo, issue));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue && !pull) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      const comments = issue ? issue.comments : pull!.comments;
      const page = paginate(comments.map((comment) => commentJson(store, repo, number, comment)), query, path);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      const bodyText = asString(input.body);
      if (bodyText === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] });
        return;
      }
      const target = issue ?? null;
      let comment;
      if (target) comment = store.addComment(repo, target, bodyText);
      else {
        const pseudo: Issue = {
          id: pull!.id,
          number: pull!.number,
          title: pull!.title,
          body: pull!.body,
          state: pull!.state,
          labels: [],
          user: pull!.user,
          createdSeq: pull!.createdSeq,
          updatedSeq: pull!.updatedSeq,
          closedSeq: pull!.closedSeq,
          comments: pull!.comments,
        };
        comment = store.addComment(repo, pseudo, bodyText);
      }
      sendJson(res, 201, commentJson(store, repo, number, comment));
      return;
    }
    notFound(res);
    return;
  }

  if (rest.length === 1) {
    if (!issue && !pull) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue ? issueJson(store, repo, issue) : pullAsIssueJson(store, repo, pull!));
      return;
    }
    if (method === 'PATCH' && issue) {
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (Array.isArray(input.labels)) {
        const labels = input.labels.map((label) => String(label));
        const unknown = labels.filter((label) => !repo.labels.has(label.toLowerCase()));
        if (unknown.length) {
          sendJson(res, 422, { message: `Validation Failed: label "${unknown[0]}" does not exist` });
          return;
        }
        issue.labels = labels;
      }
      if (input.state === 'closed' && issue.state !== 'closed') {
        issue.state = 'closed';
        issue.closedSeq = store.tick().seq;
      } else if (input.state === 'open' && issue.state !== 'open') {
        issue.state = 'open';
        issue.closedSeq = null;
      }
      issue.updatedSeq = store.tick().seq;
      sendJson(res, 200, issueJson(store, repo, issue));
      return;
    }
    if (method === 'PATCH' && pull) {
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'closed' && pull.state !== 'closed') {
        pull.state = 'closed';
        pull.closedSeq = store.tick().seq;
      } else if (input.state === 'open' && pull.state !== 'open') {
        pull.state = 'open';
        pull.closedSeq = null;
      }
      pull.updatedSeq = store.tick().seq;
      sendJson(res, 200, pullAsIssueJson(store, repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}

function handlePulls(
  store: Store,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
  input: Record<string, unknown>,
  path: string,
): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const items = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(store, repo, pull));
      const page = paginate(items, query, path);
      sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
      return;
    }
    if (method === 'POST') {
      const title = asString(input.title);
      const head = asString(input.head);
      const base = asString(input.base) || repo.defaultBranch;
      if (title === '' || head === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'missing_field' }] });
        return;
      }
      if (!repo.refs.has(`refs/heads/${head}`)) {
        sendJson(res, 422, { message: `Validation Failed: head branch "${head}" does not exist`, errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
        return;
      }
      if (!repo.refs.has(`refs/heads/${base}`)) {
        sendJson(res, 422, { message: `Validation Failed: base branch "${base}" does not exist`, errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] });
        return;
      }
      const pull = store.createPull(repo, title, asString(input.body), head, base);
      sendJson(res, 201, pullJson(store, repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) {
    notFound(res);
    return;
  }
  const pull = repo.pulls.get(number);

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) {
      notFound(res);
      return;
    }
    const page = paginate(pullFiles(repo, pull), query, path);
    sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) {
      notFound(res);
      return;
    }
    if (pull.state === 'closed') {
      sendJson(res, 405, { message: 'Pull request is already closed' });
      return;
    }
    const message = asString(input.commit_message) || asString(input.commit_title) || pull.title;
    const merged = mergePull(store, repo, pull, message);
    if (!merged.ok) {
      pull.mergeable = false;
      sendJson(res, 405, { message: 'Merge conflict' });
      return;
    }
    const t = store.tick();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = t.seq;
    pull.closedSeq = t.seq;
    pull.mergeSha = merged.sha;
    pull.updatedSeq = t.seq;
    sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
    return;
  }

  if (rest.length === 2 && (rest[1] === 'comments' || rest[1] === 'reviews') && method === 'GET') {
    if (!pull) {
      notFound(res);
      return;
    }
    const page = paginate(pull.comments.map((comment) => commentJson(store, repo, number, comment)), query, path);
    sendJson(res, 200, page.items, page.link ? { link: page.link } : {});
    return;
  }

  if (rest.length === 1) {
    if (!pull) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(store, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'closed' && pull.state !== 'closed') {
        pull.state = 'closed';
        pull.closedSeq = store.tick().seq;
      } else if (input.state === 'open' && pull.state !== 'open') {
        pull.state = 'open';
        pull.closedSeq = null;
      }
      pull.updatedSeq = store.tick().seq;
      sendJson(res, 200, pullJson(store, repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  notFound(res);
}
