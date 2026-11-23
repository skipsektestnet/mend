// Extra hand-written checks for cases the practice set does not show.
// Run: node tests/extra-tests.mjs   (from the repository root)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
let pass = 0;
let fail = 0;
function t(name, files, argv, stdin, wantExit, wantOut, wantFiles) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mend-test-'));
  for (const [p, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), v);
  }
  const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: d, input: stdin ?? '', encoding: 'utf8' });
  const gotFiles = {};
  const walk = (dir, rel = '') => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p, `${rel + n}/`);
      else gotFiles[rel + n] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(d);
  const ok = r.status === wantExit && r.stdout === wantOut && JSON.stringify(gotFiles) === JSON.stringify(wantFiles);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) {
    fail += 1;
    console.log('  exit', r.status, 'want', wantExit, '\n  out', JSON.stringify(r.stdout), 'want', JSON.stringify(wantOut), '\n  files', JSON.stringify(gotFiles), 'want', JSON.stringify(wantFiles));
  } else pass += 1;
  fs.rmSync(d, { recursive: true, force: true });
}
t('u-insert-top', { 'a.txt': 'one\ntwo\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+zero\n+half\n' }, ['p.diff'], null, 0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'zero\nhalf\none\ntwo\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+zero\n+half\n' });
t('atomic-multi', { 'a.txt': 'x\n', 'b.txt': 'y\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+X\n--- b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-NOPE\n+Z\n' }, ['p.diff'], null, 1, 'error: no-match b.txt\nfailed: 1 of 2 edits\n', { 'a.txt': 'x\n', 'b.txt': 'y\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+X\n--- b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-NOPE\n+Z\n' });
t('check-ok', { 'a.txt': 'x\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+X\n' }, ['--check', 'p.diff'], null, 0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'x\n', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+X\n' });
t('sr-reuse-path', { 'a.txt': 'aa\nbb\ncc\n', 'p.txt': 'a.txt\n<<<<<<< SEARCH\naa\n=======\nAA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ncc\n=======\nCC\n>>>>>>> REPLACE\n' }, ['--format=search-replace', 'p.txt'], null, 0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'AA\nbb\nCC\n', 'p.txt': 'a.txt\n<<<<<<< SEARCH\naa\n=======\nAA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ncc\n=======\nCC\n>>>>>>> REPLACE\n' });
t('create-then-modify', { 'p.json': '{"command":"create","path":"n.txt","file_text":"a\\nb\\n"}\n{"command":"str_replace","path":"n.txt","old_str":"b","new_str":"B"}\n' }, ['--format=json', 'p.json'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'a\nB\n', 'p.json': '{"command":"create","path":"n.txt","file_text":"a\\nb\\n"}\n{"command":"str_replace","path":"n.txt","old_str":"b","new_str":"B"}\n' });
t('move-then-modify', { 'old.txt': 'hello\nworld\n', 'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n', 'q.json': '{"command":"str_replace","path":"new.txt","old_str":"hello","new_str":"hi"}\n' }, ['p.diff'], null, 0, 'R old.txt -> new.txt\nok: 1 file\n', { 'new.txt': 'hello\nthere\n', 'p.diff': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n', 'q.json': '{"command":"str_replace","path":"new.txt","old_str":"hello","new_str":"hi"}\n' });
t('no-edit-parse1', { 'p.diff': 'just some prose\nno patch here\n' }, ['--format=unified', 'p.diff'], null, 2, 'error: parse 1\n', { 'p.diff': 'just some prose\nno patch here\n' });
t('unsafe', { 'p.txt': '../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, ['--format=search-replace', 'p.txt'], null, 1, 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', { 'p.txt': '../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' });
t('v4a-move', { 'a.txt': 'l1\nl2\nl3\n', 'p.txt': '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@ l1\n-l2\n+L2\n*** End Patch\n' }, ['p.txt'], null, 0, 'R a.txt -> b.txt\nok: 1 file\n', { 'b.txt': 'l1\nL2\nl3\n', 'p.txt': '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@ l1\n-l2\n+L2\n*** End Patch\n' });
t('noeol-mid', { 'a.txt': 'a\nb\nc', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n' }, ['p.diff'], null, 0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'a\nB\nc', 'p.diff': '--- a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n' });
t('json-insert-end', { 'a.txt': 'a\nb\n', 'p.json': '{"command":"insert","path":"a.txt","insert_line":2,"new_str":"c"}\n' }, ['p.json'], null, 0, 'M a.txt\nok: 1 file\n', { 'a.txt': 'a\nb\nc\n', 'p.json': '{"command":"insert","path":"a.txt","insert_line":2,"new_str":"c"}\n' });
t('usage-wins', {}, ['--bogus', 'missing.diff'], null, 2, 'error: usage\n', {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
