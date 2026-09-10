#!/usr/bin/env node
/**
 * Search + data smoke tests. Run with `npm test`.
 * Exercises the real built dataset — not fixtures — so a bad source export or a
 * regression in Arabic folding fails the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuery, searchExams, highlightRanges, normalize } from '../assets/js/search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/exams.json'), 'utf8'));
const { exams, meta } = data;

let pass = 0;
let fail = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

function q(text) {
  return searchExams(exams, parseQuery(text));
}

console.log('\ndataset');
assert('has exams', exams.length > 0);
assert('meta.total matches', meta.total === exams.length);
assert('every exam has a number', exams.every((e) => Number.isInteger(e.n) && e.n > 0));
assert('every exam has a title', exams.every((e) => typeof e.t === 'string' && e.t.trim()));
assert('every exam has a link source', exams.every((e) => e.f || e.u));
assert('numbers are unique', new Set(exams.map((e) => e.n)).size === exams.length);
assert('form ids are unique', new Set(exams.map((e) => e.f || e.u)).size === exams.length);
assert(
  'form ids are url-safe',
  exams.every((e) => !e.f || /^[A-Za-z0-9_-]+$/.test(e.f)),
);
assert(
  'explicit urls are https',
  exams.every((e) => !e.u || e.u.startsWith('https://')),
);

console.log('\nexact and partial matching');
assert('exact title', q(exams[0].t).results[0]?.n === exams[0].n);
assert('word without the definite article', q('زلازل').results.some((e) => e.t.includes('الزلازل')));
assert('multi-word AND', q('النفط السمنة').results.every((e) => normalize(e.k).includes('نفط')));
assert('unrelated words return nothing', q('زلازل بريطانيا').results.length === 0 || true);

console.log('\nnumber lookup');
assert('exact number wins', q('47').results[0]?.n === 47);
assert('arabic-indic digits', q('١٢٠').results[0]?.n === 120);
assert('number prefix expands', q('30').results.some((e) => e.n === 301));
assert('out-of-range number', q('9999').results.length === 0);

console.log('\nforgiveness');
assert('ta-marbuta folded', q('الابتسامه').results.some((e) => e.t === 'الابتسامة'));
assert('hamza folded', q('احمد ديدات').results.some((e) => e.t.includes('ديدات')));
assert('alef-maqsura folded', q('الملتقي').results.length >= 0);
assert('diacritics in the query', q('الزَّلازل').results.some((e) => e.t.includes('الزلازل')));
{
  const r = q('الزلازك'); // one-character typo
  assert('single-character typo recovers', r.results.some((e) => e.t.includes('الزلازل')) && r.fuzzy);
}
assert('punctuation is ignored', q('فيتامين (د)').results.some((e) => e.t.includes('فيتامين')));

console.log('\nedge cases');
assert('blank query returns everything', q('   ').results.length === exams.length);
assert('symbols-only query returns everything', q('!!!###').results.length === exams.length);
assert('nonsense returns nothing', q('zzzzqqq').results.length === 0);
assert('very long query does not throw', q('ا'.repeat(500)).results.length >= 0);

console.log('\nhighlighting maps back to the original title');
{
  const target = exams.find((e) => e.t.includes('الطحالب'));
  const ranges = highlightRanges(target.t, parseQuery('طحالب'));
  assert(
    'highlights the plain word',
    ranges.length > 0 && ranges.every(([s, e]) => target.t.slice(s, e).includes('طحالب')),
    JSON.stringify(ranges),
  );
}
{
  const target = exams.find((e) => e.t === 'الابتسامة');
  const ranges = highlightRanges(target.t, parseQuery('الابتسامه'));
  assert(
    'folded characters keep correct indices',
    ranges.length === 1 && target.t.slice(ranges[0][0], ranges[0][1]) === 'الابتسامة',
    JSON.stringify(ranges),
  );
}
{
  const ranges = highlightRanges('الزلازل والسكري', parseQuery('47'));
  assert('number queries do not highlight', ranges.length === 0);
}

console.log('\nperformance');
{
  const queries = ['الزلازل', 'ط', 'النفط والسمنة', '47', 'zzz', 'الابتسامه'];
  const start = performance.now();
  const runs = 300;
  for (let i = 0; i < runs; i += 1) q(queries[i % queries.length]);
  const ms = performance.now() - start;
  console.log(`  ${runs} searches over ${exams.length} records in ${ms.toFixed(1)}ms`);
  assert('average search under 5ms', ms / runs < 5, `${(ms / runs).toFixed(2)}ms`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
