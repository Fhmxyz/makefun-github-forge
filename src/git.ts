// src/git.ts — git smart HTTP, implemented in-process on node:zlib + node:crypto.
//
// No git binary anywhere: objects are hashed, stored and packed here. Protocol v2
// for upload-pack (advertise, ls-refs, fetch with shallow support), v0 for
// receive-pack (report-status, side-band-64k, delete-refs) and for the v0 fallback.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';
import { ZERO_OID } from './store.ts';

export const PKT_LINE_MAX = 65520;
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload ${data.length} bytes over the maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

/** Decode a whole buffer of pkt-lines; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > PKT_LINE_MAX) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

function pktText(packet: DecodedPacket): string {
  return packet.kind === 'data' ? packet.payload!.toString('utf8') : '';
}

// ---------------------------------------------------------------- object model

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots`; `leafCommits` are treated as having no parents. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { leafCommits?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      if (options.leafCommits?.has(oid)) continue;
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Generations from `tip` down to `target` following parents (-1 if unreachable). */
export function commitDistance(repo: Repo, tip: string, target: string): number {
  if (tip === target) return 0;
  const seen = new Set<string>();
  const queue: [string, number][] = [[tip, 0]];
  while (queue.length) {
    const [oid, distance] = queue.shift()!;
    if (oid === target) return distance;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push([parent, distance + 1]);
    }
  }
  return -1;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- packfile write

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A packfile of plain objects (no deltas), sorted by oid for determinism. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => (hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- packfile read

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackReadResult {
  objects: GitObject[];
  version: number;
  declaredCount: number;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA chains. */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (!baseEntry) throw new Error('ref-delta base not in pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    entry.resolved = object;
    resolvedByOid.set(hashObject(object.type, object.data), entry);
    resolving.delete(entry.offset);
    return object;
  };
  const objects = raw.map((entry) => resolve(entry));
  return { objects, version, declaredCount };
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** The peeled commit of a tag ref, or null when the ref is not an annotated tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

function v0Capabilities(repo: Repo): string {
  const caps = [
    'multi_ack',
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'report-status',
    'delete-refs',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ];
  return caps.join(' ');
}

/** v0 ref advertisement: `# service=...` preamble, refs, first line carries capabilities. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const caps = service === 'git-receive-pack' ? v0Capabilities(repo) : v0Capabilities(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = headTip(repo);
    const headLine = tip !== null ? `${tip} HEAD\0${caps}\n` : null;
    if (headLine) lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
    if (!headLine) {
      // No default-branch tip: capabilities ride the first ref line instead.
      const first = lines[2] as string;
      lines[2] = first.replace('\n', `\0${caps}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** v2 capability advertisement: `version 2` + capability lines. */
export function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'object-format=sha1\n',
    'server-option\n',
    'flush',
  ];
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- ls-refs (v2)

export interface LsRefsOptions {
  prefixes?: string[];
  peel?: boolean;
  symrefs?: boolean;
  unborn?: boolean;
}

/** v2 ls-refs: HEAD + refs, honouring ref-prefix filtering server-side. */
export function lsRefsResponse(repo: Repo, options: LsRefsOptions): Buffer {
  const lines: (string | 'flush')[] = [];
  const tip = headTip(repo);
  const prefixes = options.prefixes ?? [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (options.symrefs !== false && keep('HEAD')) {
    const target = `refs/heads/${repo.defaultBranch}`;
    if (tip !== null) lines.push(`${tip} HEAD symref-target:${target}\n`);
    else if (options.unborn !== false) lines.push(`unborn HEAD symref-target:${target}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (options.peel !== false) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  /** deepen is relative to the client's current shallow boundary
   * (v2 `deepen-relative`; v0 deepen with a reported boundary). */
  depthRelative?: boolean;
}

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Which objects a fetch must send, and the new shallow boundary. */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const clientShallow = new Set(request.shallow);
  // 1. What the client already holds: reachable from its haves, with its shallow
  //    boundary commits treated as leaves (their parents are not held).
  const haveSet = collectReachable(request.haves, lookup, { leafCommits: clientShallow });
  // 2. The commits the fetch covers: BFS from the wants, depth-limited.
  const wantRoots: string[] = [];
  const startCommits: string[] = [];
  for (const want of request.wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      wantRoots.push(want);
      startCommits.push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      startCommits.push(want);
    }
  }
  const included = new Map<string, number>();
  // A relative deepen extends the client's current depth: the current depth
  // is 1 + the greatest distance from any want to a reported shallow
  // boundary (a boundary at the tip itself means depth 1).
  let effectiveDepth = request.depth;
  if (request.depthRelative && request.depth !== undefined && request.shallow.length > 0) {
    let base = 1;
    for (const want of request.wants) {
      for (const boundary of request.shallow) {
        const distance = commitDistance(repo, want, boundary);
        if (distance >= 0) base = Math.max(base, distance + 1);
      }
    }
    effectiveDepth = base + request.depth;
  }
  const queue: [string, number][] = startCommits.map((oid) => [oid, 0]);
  while (queue.length) {
    const [oid, distance] = queue.shift()!;
    if (included.has(oid)) continue;
    included.set(oid, distance);
    if (effectiveDepth !== undefined && distance + 1 >= effectiveDepth) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent)) queue.push([parent, distance + 1]);
    }
  }
  // 3. The new shallow boundary: included commits with a parent cut off; the
  //    unshallow list is old boundary commits that are now fully included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included.keys()) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const cut = parseCommit(object.data).parents.some((parent) => !included.has(parent));
    if (cut) shallow.push(oid);
    else if (clientShallow.has(oid)) unshallow.push(oid);
  }
  // 4. The objects: everything reachable from the wanted roots and the
  //    depth-limited commits, minus what the client holds. The traversal
  //    only follows a commit's parents while the parent is also in the
  //    depth-limited set — otherwise a depth-1 clone would still carry the
  //    whole history (the shallow boundary only hides it from `git log`).
  const all = new Set<string>();
  const walkQueue: string[] = [...wantRoots, ...included.keys()];
  while (walkQueue.length) {
    const oid = walkQueue.pop()!;
    if (all.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    all.add(oid);
    if (object.type === 'commit') {
      if (!included.has(oid)) continue;
      const commit = parseCommit(object.data);
      walkQueue.push(commit.tree);
      for (const parent of commit.parents) {
        if (included.has(parent)) walkQueue.push(parent);
      }
    } else if (object.type === 'tag') {
      walkQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        walkQueue.push(entry.oid);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of all) {
    if (haveSet.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

/** v2 fetch response: acknowledgments (only when the client sent haves),
 * shallow-info, packfile sections. Per protocol-v2, the acknowledgments
 * section is omitted entirely when the request carried no `have` lines:
 * a client that sent none expects `packfile` (or `shallow-info`) first. */
export function fetchV2Response(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    // Real git answers each recognized have with `ACK <oid>`, then `ready`
    // (which licenses the shallow-info section to follow — without `ready`
    // the client expects `packfile` immediately after the acknowledgments).
    const lines: (string | 'delim')[] = ['acknowledgments\n'];
    let acked = 0;
    for (const have of request.haves) {
      if (repo.objects.has(have)) {
        lines.push(`ACK ${have}\n`);
        acked += 1;
      }
    }
    if (acked === 0) lines.push('NAK\n');
    lines.push('ready\n');
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (plan.shallow.length || plan.unshallow.length) {
    const lines: (string | 'delim')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 fetch response: ACK each recognized have (else NAK) / shallow lines,
 * then the sideband-framed pack. */
export function fetchV0Response(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  let acked = 0;
  for (const have of request.haves) {
    if (repo.objects.has(have)) {
      lines.push(`ACK ${have}\n`);
      acked += 1;
    }
  }
  if (acked === 0) lines.push('NAK\n');
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (v0)

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  lines: PushReportLine[];
}

/**
 * Apply a receive-pack: ingest the pack, then apply each command with a
 * fast-forward check. One report line per command; a refused ref never moves.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushOutcome {
  if (pack !== null && pack.length > 0) {
    try {
      const read = readPack(pack);
      for (const object of read.objects) {
        repo.objects.set(hashObject(object.type, object.data), object);
      }
    } catch (err) {
      return {
        unpackOk: false,
        unpackDetail: `error ${(err as Error).message}`,
        lines: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      };
    }
  }
  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, new must descend from old.
    if (current === undefined || command.oldOid !== current) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return { unpackOk: true, unpackDetail: 'ok', lines };
}

/** The report-status stream, pkt-lined inside sideband band 1, then a flush. */
export function pushReportResponse(outcome: PushOutcome): Buffer {
  const lines: string[] = [`unpack ${outcome.unpackDetail}\n`];
  for (const line of outcome.lines) {
    lines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  // Real git sends ALL status lines inside ONE band-1 packet (band byte +
  // inner pkt-lines), followed by an INNER flush inside that same band-1
  // payload, then the outer flush. The inner flush is what terminates the
  // client's report loop — without it the client reads EOF after the last
  // line and reports "remote end hung up".
  const inner = Buffer.concat([encodePktLines(lines), pktFlush()]);
  const payload = Buffer.concat([Buffer.from([1]), inner]);
  return Buffer.concat([encodePktLine(payload), pktFlush()]);
}

/** Parse a receive-pack request body into commands + the pack that follows. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let seenFlush = false;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      seenFlush = true;
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > body.length) {
      throw new Error(`invalid pkt-line length ${length}`);
    }
    const raw = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul >= 0 ? raw.slice(0, nul) : raw).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    offset += length;
  }
  if (!seenFlush) throw new Error('push body has no flush after the command list');
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

/** Parse a v2 command request (ls-refs / fetch) into its command and arguments. */
/** Parse a protocol-v2 request body. Arguments come in two forms: `key=value`
 * (command, agent, object-format) and space-separated `key value` (want,
 * have, deepen, shallow, ref-prefix, filter). Bare flags (thin-pack,
 * no-progress, ofs-delta, peel, symrefs, unborn, done) carry no value. */
export function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]> } {
  const packets = decodePktLines(body);
  const args = new Map<string, string[]>();
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    const equals = line.indexOf('=');
    const space = line.indexOf(' ');
    let key: string;
    let value: string;
    if (equals >= 0 && (space < 0 || equals < space)) {
      key = line.slice(0, equals);
      value = line.slice(equals + 1);
    } else if (space >= 0) {
      key = line.slice(0, space);
      value = line.slice(space + 1);
    } else {
      key = line;
      value = '';
    }
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

/** Parse a v0 upload-pack request body into wants/haves/depth. In v0 a
 * deepen that reports a shallow boundary extends that boundary. */
export function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  return { wants, haves, shallow, depth, depthRelative: shallow.length > 0 };
}
