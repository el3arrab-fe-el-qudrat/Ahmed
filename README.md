# العراب في القدرات — بوابة نماذج تجميعات اللفظي

موقع ثابت بالكامل يجمع نماذج **تجميعات اللفظي** للأستاذ **أحمد طلعت ربيع** في صفحة واحدة،
مع بحث فوري بالاسم أو بالرقم، وتصفية، ومتابعة تقدّم محفوظة على جهاز الطالب.

**لا يوجد خادم، ولا قاعدة بيانات، ولا عملية بناء (build) مطلوبة للنشر.**
الملفات المرفوعة هي الموقع نفسه.

---

## Quick start

```bash
npm start           # preview at http://127.0.0.1:5177
npm run verify      # rebuild data + run tests + validate every link
```

There is nothing to install — every script is plain Node (>= 18) with zero dependencies.

---

## How it is put together

```
index.html              the portal: hero + search, quick access, filters, exam grid
about.html              عن المنصة — how to use the site, FAQ
404.html                fully self-contained (no external CSS/JS/images at all)

assets/
  css/tokens.css        design tokens: brand palette, type scale, spacing, radii, motion
  css/base.css          font faces, reset, typography, layout primitives, a11y
  css/components.css    every component
  js/search.js          Arabic-aware search (normalisation, ranking, highlighting)
  js/store.js           device-local progress (localStorage, fully guarded)
  js/app.js             state -> URL -> render; card building; filters; sheet
  js/ui.js              theme toggle + mobile nav (shared by all pages)
  fonts/                IBM Plex Sans Arabic, self-hosted and subset (tools/build-fonts.md)
  img/                  logo seal (mark-*.webp), favicons, maskable icons, OG cover
  data/exams.json       GENERATED — do not edit by hand

data/
  source/               the original, untouched export (the single source of truth)
  build-report.json     GENERATED — what was published and what was excluded

tools/
  build-data.mjs        source export  ->  assets/data/exams.json
  test-search.mjs       search + dataset tests (npm test)
  check-links.mjs       link validation, offline or over the network
  set-site-url.mjs      stamps the real site URL into canonical/OG/sitemap
  serve.mjs             zero-dependency local preview server
  og-cover.template.html  source for assets/img/og-cover.jpg
  build-fonts.md        how to refetch and re-subset the fonts
```

### Why no framework

The site is one screen over ~300 records. Vanilla ES modules ship about **13 KB of
JavaScript**; React + a bundler would have cost roughly ten times that, plus a build
step that can break a deployment. Everything is loaded as plain static files with
**relative** paths, so the site works identically at
`user.github.io/repo/`, at `user.github.io/`, and on a custom domain.

---

## Updating the exam list

1. Export the new list and drop it into `data/source/` (replacing the old `.json`).
   The original file is never modified by any script.
2. Run the pipeline:

   ```bash
   npm run verify
   ```

   `build-data.mjs` validates every record and prints what it published and what it
   excluded. A record with a missing title, a non-https URL, a duplicate number or a
   duplicate link is **left out of the site entirely** rather than rendered as a
   broken exam. `data/build-report.json` lists any exclusions.
3. Commit. The GitHub Actions workflow rebuilds and redeploys automatically.

The source schema currently in use:

```json
{
  "project": "…", "teacher": "…", "questions_per_form": 13,
  "count": 301, "generated": "YYYY-MM-DD",
  "forms": [{ "section": 1, "title": "…", "short": "https://forms.gle/…",
              "url": "https://docs.google.com/forms/d/e/…/viewform" }]
}
```

`build-data.mjs` tolerates a bare array of forms too, and keeps any URL that is valid
https even if it is not a Google Forms link.

### Checking that the forms are still live

```bash
npm run check:links              # probes all 301 URLs (slow, hits Google)
npm run check:links -- --limit 25
```

This is deliberately **not** part of CI — 300 outbound requests get rate-limited.
Run it manually after a data update.

---

## Deploying to GitHub Pages

### The automatic path (recommended)

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Do this *before* the first run — see the troubleshooting note below.
3. Push to `main`. `.github/workflows/deploy.yml` will:
   rebuild the dataset → run the tests → validate the links →
   **stamp the real Pages URL** into the canonical/OG/sitemap tags →
   add `.nojekyll` → deploy.

Nothing else needs configuring; `actions/configure-pages` reports the real URL, so
the same workflow is correct for a project page, a user page or a custom domain.

#### If the build fails at "Configure Pages"

```
Error: Get Pages site failed. Please verify that the repository has Pages
enabled and configured to build using GitHub Actions.
Error: HttpError: Not Found
```

This means Pages has never been turned on for the repository, so there is no Pages
site for the action to look up. It is a repository setting, not a problem with the
site or the build.

**Fix:** *Settings → Pages → Build and deployment → Source: **GitHub Actions***, then
re-run the workflow (Actions → the failed run → *Re-run all jobs*).

The workflow already tries to avoid this on its own:

- `configure-pages` is called with `enablement: true`, which creates the Pages site
  via the API when it is missing. That needs Actions to have write access —
  *Settings → Actions → General → Workflow permissions* must be
  **Read and write permissions**, otherwise the API call is rejected.
- The step is marked `continue-on-error`, and the next step derives the
  conventional URL (`https://<owner>.github.io/<repo>/`, or the domain root for an
  `<owner>.github.io` repository) so the metadata is still stamped correctly.

Note that only *this* step is tolerant. The actual `deploy-pages` step at the end
still requires Pages to be enabled — there is no way around the one-time setting.

### The manual path (deploy from a branch)

This also works — the site needs no build — but run this once first so the
absolute URLs in the metadata are correct:

```bash
npm run set-url -- https://your-name.github.io/your-repo/
```

Then set **Settings → Pages → Source: Deploy from a branch**, pick the branch and
the root folder. `.nojekyll` is already committed, which matters here: without it
Jekyll would drop files and choke on the Arabic filenames under `data/source/`.

> If you skip `set-url`, a small inline script repairs `canonical` and `og:url` in
> the browser, but crawlers that do not run JavaScript read the raw HTML — so run it
> before sharing the link anywhere.

---

## Design system

Tokens live in `assets/css/tokens.css`. The palette was sampled from the brand mark:

| Role | Light | Dark |
| --- | --- | --- |
| Navy (structure, text) | `#182234` | `#eef1f6` on `#0e1524` |
| Burgundy (the one action colour) | `#7a2229` | `#a6303c` |
| Gold (accent: numbers, completion, focus) | `#a87538` | `#ddb478` |
| Paper | `#f7f5f1` / `#ffffff` | `#0e1524` / `#151e2f` |

Rules the implementation follows:

- **Burgundy is only ever used for the primary action.** Gold is an accent, never a
  surface. On the exam cards, where «ابدأ الاختبار» repeats hundreds of times, the
  button is a burgundy *tint* that fills solid on hover, so the grid stays calm.
- **Minimum body size is 15px, minimum metadata size is 13px.** Nothing smaller.
- **Every text colour meets WCAG AA (4.5:1)** against its own background, verified in
  both themes.
- **Light is the default for every visitor**, whatever their operating system is set to.
  Dark is opt-in only, through the header toggle, and the choice is remembered.
- **The logo always sits on a white disc** (`assets/img/mark-*.webp`, cut from the
  original artwork) so it reads identically in both themes; only the rim, ring and
  shadow around it adapt.

---

## Behaviour worth knowing

**Search** (`assets/js/search.js`) folds alef/hamza variants, ta-marbuta,
alef-maqsura, diacritics and tatweel, and both Arabic-Indic and Latin digits. The
definite article and a leading «و» are indexed as extra stems, so «زلازل» finds
«الزلازل والسكري». A pure number addresses a form directly. If a strict pass finds
nothing, a second pass tolerates a one-character typo. Matches are highlighted on
the original Arabic title via an index map, so folded characters still highlight
correctly.

**State lives in the URL.** `?q=…&range=…&status=…&sort=…` — any view can be shared,
and the back button works. `#exam-47` deep-links to a specific form, loading more
batches if needed.

**Progress is device-local.** «مُنجز», «المفضلة» and «آخر ما فتحت» are stored in
`localStorage` only (`assets/js/store.js`). Nothing is ever sent anywhere. Every
storage call is wrapped, so a private window or blocked site data keeps working in
memory instead of throwing. Stored data is sanitised on read, changes are written
immediately when the tab is hidden, and a second open tab picks up changes through
the `storage` event instead of overwriting them. `tools/test-store.mjs` covers all of it.

**How "done" gets recorded.** A Google Form cannot tell the page it was submitted, so
opening a form (card button, «أكمل/تابع» tile, random tile) queues a check. When the
student comes back to the tab — at least 20 seconds later, within 7 days — a panel
asks «هل أنهيت النموذج؟». «نعم» marks it done and offers the next unfinished form;
«ليس بعد» dismisses it. The round checkbox on each card does the same by hand.

- **Resume tile:** the last opened form if it is not done («أكمل»), otherwise the next
  unfinished one after it («تابع»); on a fresh device the first form («ابدأ»).
- **Random tile:** an unfinished form (never the one just opened), regardless of the
  current search or filters.
- **Status tabs** show live counts under the current range and search. Marking a card
  inside a filtered tab updates it in place — the list is not rebuilt, so the student
  keeps their scroll position.
- **«مسح الإنجاز»** clears done marks and history but keeps favourites, and is undoable
  from the toast.

**Rendering is incremental.** 48 cards per batch, extended by an IntersectionObserver
with an explicit «عرض المزيد» button as the accessible fallback.

**Links are validated twice** — once at build time, once again before a card is
rendered. Anything that is not a plain `https:` URL never becomes a clickable exam.
All external links carry `rel="noopener noreferrer"`.

---

## A note on the access code

The source export contains `"password": "2030"`, which is what the first page of each
Google Form asks for. **It is deliberately not displayed anywhere on this site** — the
site is public, and publishing the code here would remove the only gate on the forms.
`about.html` tells students to get it from the teacher instead.

If you would rather show it, that is a one-line change — add it to the hero or the
about page. It is intentionally not wired to a config flag so that it cannot be
switched on by accident.
