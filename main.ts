// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON text-editor tool calls), finds the lines each edit names at the
// first of three matching tiers, and changes every file or none. SPEC.md is
// the whole contract. Node 22+, standard library alone; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split at its own line break. */
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(parts: FileParts): string {
  if (parts.lines.length === 0) return '';
  return parts.lines.join(parts.br) + (parts.final ? parts.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function onlyWs(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return rtrimWs(s);
  return trimWs(s);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old/new side. `ctx` lines are in both O and N; `oIdx` is a
 * context line's index in O, so N's copy is written as the file's own line. */
interface MLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

function occurrences(lines: string[], o: MLine[], tier: number): number[] {
  const out: number[] = [];
  const want = o.map((e) => normLine(e.text, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict: 0 only) at which O occurs. */
function findTier(lines: string[], o: MLine[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N writes in place of O matched at `pos`: context lines as the
 * file's own matched lines, other lines re-indented at tier 2. */
function buildReplacement(fileLines: string[], pos: number, o: MLine[], n: MLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[pos]!);
    p = leadWs(o[0]!.text);
  }
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + e.oIdx]!);
    } else if (tier === 2) {
      const t = e.text;
      if (t !== '' && !onlyWs(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** First line at or after `from` equal to `anchor` (a single line) at the
 * first tier where one is, or null. */
function anchorAt(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  o: MLine[];
  n: MLine[];
  tailNoNL: boolean;
  lastPlusNoNL: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The body lines of a hunk, from `start` until the first line that is not
 * one, a `diff --git` line, or a `--- ` line followed by a `+++ ` line.
 * Empty lines at the end of the body are not part of it. */
function collectBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

/** A hunk body's context/`-` lines (O) and context/`+` lines (N). */
function splitBody(body: string[]): { o: MLine[]; n: MLine[]; tailNoNL: boolean; lastPlusNoNL: boolean } {
  const o: MLine[] = [];
  const n: MLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, bi) => {
    if (b.startsWith(' ')) {
      const t = b.slice(1);
      o.push({ text: t, ctx: true, oIdx: o.length });
      n.push({ text: t, ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = bi;
    } else if (b.startsWith('-')) {
      o.push({ text: b.slice(1), ctx: false, oIdx: -1 });
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
      lastCtxPlus = bi;
      lastPlus = bi;
    } else if (b === '') {
      o.push({ text: '', ctx: true, oIdx: o.length });
      n.push({ text: '', ctx: true, oIdx: o.length - 1 });
      lastCtxPlus = bi;
    }
    // a `\` line refers to the body line before it and carries no text.
  });
  const after = (idx: number): boolean => idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]!.startsWith('\\');
  return { o, n, tailNoNL: after(lastCtxPlus), lastPlusNoNL: after(lastPlus) };
}

/** A path from a `--- ` / `+++ ` line: after the four characters, up to the
 * first tab, surrounding spaces removed, a leading `a/` or `b/` removed.
 * `/dev/null` means no file. */
function uniPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function renamePath(rest: string): string | null {
  const p = rest.trim();
  if (p === '/dev/null') return null;
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

function parseHunkAt(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const { body, next } = collectBody(lines, i + 1);
  const { o, n, tailNoNL, lastPlusNoNL } = splitBody(body);
  return { hunk: { a: Number(m[1]), o, n, tailNoNL, lastPlusNoNL }, next };
}

/** A section's hunks applied in order to a file's lines. */
function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): FileParts {
  let lines = parts.lines;
  let fin = parts.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.o;
    const N = h.n;
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const ins = N.map((e) => e.text);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      if (atEnd && N.length > 0) fin = !h.tailNoNL;
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.occ) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          best = p;
          bd = dd;
        }
      }
      const atEnd = best + O.length === lines.length;
      const rep = buildReplacement(lines, best, O, N, found.tier);
      lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + O.length)];
      if (atEnd) fin = !h.tailNoNL;
      d += N.length - O.length;
    }
  }
  return { br: parts.br, lines, final: fin };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP === null && newP === null) return;
    const isCreate = sec.create || oldP === null;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (!e.ctx) out.push(e.text);
      let finalBr = true;
      for (const h of sec.hunks) {
        if (h.n.some((e) => !e.ctx)) finalBr = !h.lastPlusNoNL;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    const isDelete = sec.del || newP === null;
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const q = newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const isMove = p !== q;
    if (isMove && !safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(q) !== null) throw new Fail('exists', q);
    const result = joinFile(applyHunks(splitFile(before), sec.hunks, strict, p));
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(q, result);
      tree.moves.push([p, q]);
    } else {
      tree.now.set(p, result);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let pairSeen = false;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    pairSeen = false;
  };
  const startDiff = (l: string, i: number): number => {
    const m = DIFF_RE.exec(l);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    startSection(m[1]!, m[2]!);
    return i + 1;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        i = startDiff(l, i);
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const o = uniPath(l);
        const n = uniPath(lines[i + 1]!);
        startSection(o, n);
        pairSeen = true;
        i += 2;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        const { hunk, next } = parseHunkAt(lines, i);
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      if (l.startsWith('diff --git ')) {
        i = startDiff(l, i);
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = uniPath(l);
          cur.newPath = uniPath(lines[i + 1]!);
          pairSeen = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        if (!pairSeen) cur.oldPath = renamePath(l.slice(12));
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!pairSeen) cur.newPath = renamePath(l.slice(10));
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      i = startDiff(l, i);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = uniPath(l);
      const n = uniPath(lines[i + 1]!);
      startSection(o, n);
      pairSeen = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunkAt(lines, i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      let j = -1;
      for (let k = i + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '=======') {
          j = k;
          break;
        }
      }
      if (j < 0) throw new Exit2(`error: parse ${s + 1}`);
      let k = -1;
      for (let m = j + 1; m < lines.length; m += 1) {
        if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
          k = m;
          break;
        }
      }
      if (k < 0) throw new Exit2(`error: parse ${s + 1}`);
      let path: string | null = null;
      for (let m = i - 1; m >= prevEnd; m -= 1) {
        const t = lines[m]!;
        if (blank(t)) continue;
        if (t.trim().startsWith('```')) continue;
        path = t.trim();
        break;
      }
      if (path === null) {
        if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
        else throw new Exit2(`error: parse ${s + 1}`);
      }
      blocks.push({ path, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k) });
      prevEnd = k + 1;
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return blocks.map((b) => {
    const p = b.path;
    const O: MLine[] = b.oldLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const N: MLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    return (tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (O.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, N.length === 0 ? '' : N.map((e) => e.text).join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = splitFile(before);
      const found = findTier(parts.lines, O, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const rep = buildReplacement(parts.lines, pos, O, N, found.tier);
      const nl = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + O.length)];
      tree.now.set(p, joinFile({ br: parts.br, lines: nl, final: parts.final }));
    };
  });
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface VChunk {
  anchor: string | null;
  raw: string[];
  eof: boolean;
  o: MLine[];
  n: MLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function v4aSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice(17).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice(17).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const s = v4aSectionStart(l);
    if (s === null) throw new Exit2(`error: parse ${i + 1}`);
    if (s.kind === 'add') {
      const raw: string[] = [];
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (v4aSectionStart(x) !== null) break;
        raw.push(x);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let t = 0; t < raw.length; t += 1) {
        const x = raw[t]!;
        if (x.startsWith('+') || x === '') continue;
        throw new Exit2(`error: parse ${i + 2 + t}`);
      }
      sections.push({ kind: 'add', path: s.path, moveTo: null, addLines: raw.map((r) => (r === '' ? '' : r.slice(1))), chunks: [] });
      i = j;
      continue;
    }
    if (s.kind === 'delete') {
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (blank(x)) {
          j += 1;
          continue;
        }
        if (v4aSectionStart(x) !== null) break;
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind: 'delete', path: s.path, moveTo: null, addLines: [], chunks: [] });
      i = j;
      continue;
    }
    // update
    let moveTo: string | null = null;
    let j = i + 1;
    while (j < last && blank(lines[j]!)) j += 1;
    if (j < last && lines[j]!.startsWith('*** Move to: ')) {
      moveTo = lines[j]!.slice(13).trim();
      j += 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    const closeChunk = (): void => {
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
    };
    while (j < last) {
      const x = lines[j]!;
      if (v4aSectionStart(x) !== null) break;
      if (x.startsWith('@@')) {
        closeChunk();
        const anchor = x.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, raw: [], eof: false, o: [], n: [] };
        j += 1;
        continue;
      }
      if (x.trim() === '*** End of File') {
        if (cur === null) cur = { anchor: null, raw: [], eof: true, o: [], n: [] };
        else cur.eof = true;
        closeChunk();
        j += 1;
        continue;
      }
      if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
          cur = { anchor: null, raw: [], eof: false, o: [], n: [] };
        }
        cur.raw.push(x);
        j += 1;
        continue;
      }
      if (x === '' || blank(x)) {
        // A blank line is an empty context line while a chunk is open, else
        // it is ignored (blank lines between sections, or at a section's end).
        if (cur !== null) cur.raw.push('');
        j += 1;
        continue;
      }
      throw new Exit2(`error: parse ${j + 1}`);
    }
    closeChunk();
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.raw.length > 0 && blank(lastChunk.raw[lastChunk.raw.length - 1]!)) lastChunk.raw.pop();
    }
    for (const ch of chunks) {
      const split = splitBody(ch.raw);
      ch.o = split.o;
      ch.n = split.n;
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
    sections.push({ kind: 'update', path: s.path, moveTo, addLines: [], chunks });
    i = j;
  }
  return sections.map((sec) => {
    return (tree: Tree): void => {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const q = sec.moveTo;
      if (q !== null && !safe(q)) throw new Fail('unsafe', q);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (q !== null && tree.get(q) !== null) throw new Fail('exists', q);
      const parts = splitFile(before);
      let curLines = parts.lines;
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const at = anchorAt(curLines, ch.anchor, cursor, strict);
          if (at === null) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const O = ch.o;
        const N = ch.n;
        if (O.length === 0) {
          const pos = ch.eof ? curLines.length : cursor;
          const ins = N.map((e) => e.text);
          curLines = [...curLines.slice(0, pos), ...ins, ...curLines.slice(pos)];
          cursor = pos + ins.length;
        } else {
          let found: { tier: number; occ: number[] } | null = null;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            const occ = occurrences(curLines, O, t).filter((pos) => pos >= cursor && (!ch.eof || pos + O.length === curLines.length));
            if (occ.length > 0) {
              found = { tier: t, occ };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', p);
          const pos = found.occ[0]!;
          const rep = buildReplacement(curLines, pos, O, N, found.tier);
          curLines = [...curLines.slice(0, pos), ...rep, ...curLines.slice(pos + O.length)];
          cursor = pos + rep.length;
        }
      }
      const result = joinFile({ br: parts.br, lines: curLines, final: parts.final });
      if (q !== null) {
        tree.now.set(p, null);
        tree.now.set(q, result);
        tree.moves.push([p, q]);
      } else {
        tree.now.set(p, result);
      }
    };
  });
}

/* ---- Invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ---- */

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      coveredOld.add(old);
      coveredNew.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    const changed = [...tree.now.keys()].sort(byteOrder);
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was !== null && now === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (now !== null && was !== now) {
        try {
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
        } catch {
          // not there, or not a directory: writing below creates what is needed.
        }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
