#!/usr/bin/env node
/**
 * SEO / AI-discoverability checks. Run with `npm test`.
 *
 * Guards the things that silently rot when copy is edited: structured data that
 * no longer parses, FAQ markup that no longer matches what the page shows
 * (Google treats that as spam), pages missing from the sitemap, and an
 * llms.txt whose figures drifted from the dataset.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'teacher.html', 'about.html'];
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

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

/** Visible text: drop scripts/styles and tags, collapse whitespace. */
const visibleText = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

const graphOf = (html) => {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const data = JSON.parse(match[1]);
  return data['@graph'] ?? [data];
};

for (const page of PAGES) {
  console.log(`\n${page}`);
  const html = read(page);

  let graph = [];
  try {
    graph = graphOf(html);
    assert('structured data parses', graph.length > 0);
  } catch (error) {
    assert('structured data parses', false, error.message);
  }

  const title = html.match(/<title>([^<]+)<\/title>/)?.[1] ?? '';
  assert('title is present and not too long', title.length > 10 && title.length <= 75, `(${title.length})`);
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/)?.[1] ?? '';
  assert('meta description 70-230 chars', description.length >= 70 && description.length <= 230, `(${description.length})`);
  assert('canonical', /<link rel="canonical" href="__SITE_URL__/.test(html));
  assert('hreflang ar-sa + x-default', /hreflang="ar-sa"/.test(html) && /hreflang="x-default"/.test(html));
  assert('Open Graph title/description/image', /og:title/.test(html) && /og:description/.test(html) && /og:image"/.test(html));
  assert('exactly one h1', (html.match(/<h1[\s>]/g) || []).length === 1);
  assert('names the teacher in text', visibleText(html).includes('أحمد طلعت ربيع'));
  assert('brand written without harakat', !html.includes('العِراب'));

  {
    const defined = new Set(graph.map((node) => node['@id']).filter(Boolean));
    const referenced = new Set();
    JSON.stringify(graph).replace(/\{"@id":"([^"]+)"\}/g, (match, id) => {
      referenced.add(id);
      return match;
    });
    const dangling = [...referenced].filter((id) => !defined.has(id));
    assert('every @id reference resolves on this page', dangling.length === 0, dangling.join(' | '));
  }

  assert(
    'every <img> declares width and height',
    [...html.matchAll(/<img\b[^>]*>/gs)].every((m) => /\bwidth=/.test(m[0]) && /\bheight=/.test(m[0])),
  );
  assert(
    'every target="_blank" link is rel="noopener noreferrer"',
    [...html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/gs)].every((m) => /rel="noopener noreferrer"/.test(m[0])),
  );

  const faq = graph.find((node) => node['@type'] === 'FAQPage');
  if (faq) {
    // Compared without whitespace: inline tags (<bdi> around the phone number,
    // <span> around a figure) split the text without changing what a reader or
    // a crawler sees.
    const text = visibleText(html).replace(/\s+/g, '');
    const has = (value) => text.includes(value.replace(/\s+/g, ''));
    const missing = faq.mainEntity.filter((q) => !has(q.name) || !has(q.acceptedAnswer.text));
    assert(
      `FAQ markup matches visible text (${faq.mainEntity.length} Q&A)`,
      missing.length === 0,
      missing.map((q) => q.name).join(' | '),
    );
  }
}

console.log('\ncross-page');
{
  const ids = new Map();
  for (const page of PAGES) {
    for (const node of graphOf(read(page))) {
      if (!node['@id']) continue;
      const seen = ids.get(node['@id']);
      if (!seen || Object.keys(node).length > Object.keys(seen).length) ids.set(node['@id'], node);
    }
  }
  const person = ids.get('__SITE_URL__teacher.html#person');
  assert('one Person entity for the teacher', person?.['@type'] === 'Person' && person.name === 'أحمد طلعت ربيع');
  assert('he is a قدرات trainer first', person?.jobTitle?.[0] === 'مدرب القدرات');
  assert('phone in E.164', person?.telephone === '+966501368526');
  assert('Facebook in sameAs', (person?.sameAs || []).some((u) => u.startsWith('https://www.facebook.com/')));
  assert('a text-free portrait as the Person image', String(person?.image?.url || '').includes('teacher-portrait'));
  assert('courses offered, with no price', Boolean(person?.makesOffer) && !JSON.stringify(person.makesOffer).includes('price'));
  assert('the site is published by him', JSON.stringify(ids.get('__SITE_URL__#website')).includes('teacher.html#person'));

  for (const page of PAGES) {
    for (const node of graphOf(read(page))) {
      const full = node['@id'] && ids.get(node['@id']);
      if (!full || full === node) continue;
      const clashes = Object.keys(node).filter(
        (key) => key !== '@id' && JSON.stringify(node[key]) !== JSON.stringify(full[key]),
      );
      const id = node['@id'].replace('__SITE_URL__', '/');
      assert(`${page}: ${id} agrees with its full definition`, clashes.length === 0, clashes.join(' | '));
    }
  }

  for (const page of PAGES) {
    const html = read(page);
    assert(`${page} links to WhatsApp`, html.includes('https://wa.me/966501368526'));
    assert(`${page} links to a phone call`, html.includes('tel:+966501368526'));
    assert(`${page} links to Facebook`, html.includes('https://www.facebook.com/alastadh.ahmd.tl.t/'));
  }

  // Claims the owner did not make, and rivals' spellings, must never appear.
  const forbidden = [
    /أفضل/, /\bbest\b/i, /الأول في|رقم واحد/,
    /نضمن|مضمون|ضمان الدرجة|نتيجة مضمونة|guarantee/i,
    /معتمد\s*(من|لدى|في)\s*قياس|مدرب قياس|تابع لقياس|بالتعاون مع قياس/,
    /دروس خصوصية|مدرس خصوصي|درس خاص/,
    /العِراب|العرّاب/,
    /\d+\s*(سنة|سنوات|عام|عامًا|عاما)\s*(من\s*)?(ال)?خبرة/, /خبرة\s*\d+\s*(سنة|سنوات|عام)/,
    /\d{2,}\s*(طالب|طالبة|متدرب|متدربة)/,
    /ريال|\bSAR\b|السعر|الأسعار/,
  ];
  for (const page of [...PAGES, 'llms.txt']) {
    const text = read(page);
    const hit = forbidden.filter((pattern) => pattern.test(text)).map(String);
    assert(`${page} makes no unsupported claim`, hit.length === 0, hit.join(' | '));
  }

  const sitemap = read('sitemap.xml');
  // Locally the sitemap still carries the placeholder; after a deploy it carries
  // the real origin. Both must pass, so the page name is matched, not the base.
  const base = '(?:__SITE_URL__|https?://[^<]*?/)';
  for (const page of PAGES) {
    const loc = page === 'index.html' ? `<loc>${base}</loc>` : `<loc>${base}${page}</loc>`;
    assert(`sitemap lists ${page}`, new RegExp(loc).test(sitemap));
  }
  const urlCount = (sitemap.match(/<url>/g) || []).length;
  assert('sitemap closes every <url>', urlCount === (sitemap.match(/<\/url>/g) || []).length);
  assert(
    'sitemap dates every page',
    (sitemap.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || []).length === urlCount,
  );
  assert('sitemap declares the image namespace', sitemap.includes('sitemap-image/1.1'));
  assert('sitemap offers his portrait to image search', sitemap.includes('teacher-portrait.jpg'));
  assert(
    'every sitemap image is titled',
    (sitemap.match(/<image:loc>/g) || []).length ===
      (sitemap.match(/<image:title>/g) || []).length,
  );

  const robots = read('robots.txt');
  for (const bot of ['Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    assert(`robots.txt allows ${bot}`, new RegExp(`User-agent: ${bot}[ \\t]*\\r?\\nAllow: /`).test(robots));
  }
  assert('robots.txt disallows nothing', !/^\s*Disallow:\s*\S/m.test(robots));
}

console.log('\nllms.txt');
{
  const llms = read('llms.txt');
  const { meta } = JSON.parse(read('assets/data/exams.json'));
  assert('exists and starts with an H1', llms.startsWith('# '));
  assert('has a summary blockquote', /^> /m.test(llms));
  assert('leads with the teacher, not the platform', llms.split(String.fromCharCode(10))[0].includes('أحمد طلعت'));
  assert('gives his WhatsApp number', llms.includes('+966 50 136 8526'));
  assert(`form count matches the dataset (${meta.total})`, llms.includes(`عدد النماذج: ${meta.total}`));
  assert('links every page', PAGES.every((p) => llms.includes(p === 'index.html' ? '(__SITE_URL__)' : `(__SITE_URL__${p})`)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
