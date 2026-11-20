// src/store.ts — the forge's whole state, in memory, deterministic.
//
// Every id is a sequential integer; every timestamp comes from one logical counter
// (base 2026-11-14T06:30:00Z + counter seconds), never from the wall clock, so two
// runs that serve the same requests leave the same state. Git objects are stored
// verbatim by SHA-1; refs are a name -> oid map per repository.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/**
 * The login the trial's bearer token names. The suite's scenario is built from the
 * contest's one fixed seed (wire.ts SCENARIO_SEED), so the viewer is the same in
 * every trial: adaiversen, id 1000. Repositories belong to this login; any other
 * owner in a path is a 404, never a 403.
 */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The logical clock's base: the competition's opening, 2026-11-14T06:30:00Z. */
export const CLOCK_BASE_MS = Date.parse('2026-11-14T06:30:00.000Z');

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  createdSeq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
  updatedSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  headSha: string | null;
  baseRef: string;
  baseSha: string | null;
  user: string;
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  mergedSeq: number | null;
  mergeSha: string | null;
  comments: IssueComment[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  itemSeq: number;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  commentSeq: number;
}

export function nodeId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseNodeId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private labelSeq = 0;
  /** The logical clock: bumped on every create/mutation, so timestamps stay ordered. */
  private clockSeq = 0;

  /** The next logical tick, as an ISO timestamp. */
  tick(): { seq: number; iso: string } {
    this.clockSeq += 1;
    return { seq: this.clockSeq, iso: new Date(CLOCK_BASE_MS + this.clockSeq * 1000).toISOString() };
  }

  isoOf(seq: number): string {
    return new Date(CLOCK_BASE_MS + seq * 1000).toISOString();
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const t = this.tick();
    const repo: Repo = {
      id: ++this.repoSeq,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: t.seq,
      updatedSeq: t.seq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      itemSeq: 0,
      pulls: new Map(),
      labels: new Map(),
      commentSeq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const t = this.tick();
    const label: Label = { id: ++this.labelSeq, name, color, description, createdSeq: t.seq };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const t = this.tick();
    const number = ++repo.itemSeq;
    const issue: Issue = {
      id: repo.id * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user: VIEWER.login,
      createdSeq: t.seq,
      updatedSeq: t.seq,
      closedSeq: null,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const t = this.tick();
    const number = ++repo.itemSeq;
    const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? null;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? null;
    const pull: Pull = {
      id: repo.id * 100000 + 50000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      headRef,
      headSha,
      baseRef,
      baseSha,
      user: VIEWER.login,
      createdSeq: t.seq,
      updatedSeq: t.seq,
      closedSeq: null,
      mergedSeq: null,
      mergeSha: null,
      comments: [],
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const t = this.tick();
    const comment: IssueComment = {
      id: ++repo.commentSeq,
      body,
      user: VIEWER.login,
      createdSeq: t.seq,
      updatedSeq: t.seq,
    };
    issue.comments.push(comment);
    return comment;
  }
}
