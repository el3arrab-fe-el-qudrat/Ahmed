# العراب في القدرات — بوابة نماذج تجميعات اللفظي

موقع ثابت بالكامل يجمع نماذج **تجميعات اللفظي** للأستاذ **أحمد طلعت ربيع** في صفحة واحدة،
مع بحث فوري بالاسم أو بالرقم، وتصفية، ومتابعة تقدّم محفوظة على جهاز الطالب.

**لا يوجد خادم، ولا قاعدة بيانات، ولا عملية بناء (build) مطلوبة للنشر.**
الملفات المرفوعة هي الموقع نفسه.

---

## Quick start

```bash
npm start           # preview at http://127.0.0.1:4173 (PORT=5177 npm start to change)
npm run verify      # rebuild data + run tests + validate every link
```

There is nothing to install — every script is plain Node (>= 18) with zero dependencies.

---

## How it is put together

```
index.html              the portal: hero + search, quick access, filters, exam grid
teacher.html            الأستاذ — the teacher's profile page (Person / ProfilePage / FAQ schema)
about.html              عن المنصة — how to use the site, FAQ (FAQPage schema)
llms.txt                GENERATED — plain-text brief for AI assistants (llmstxt.org)
robots.txt              allows search engines and AI crawlers by name
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
  img/                  logo seal (mark-*.webp), the teacher's photos
                        (teacher-portrait-*, teacher-standing-*), favicons, OG cover
  data/exams.json       GENERATED — do not edit by hand

data/
  source/               the original, untouched export (the single source of truth)
  source/photos/        the teacher's original photos, untouched
  build-report.json     GENERATED — what was published and what was excluded

tools/
  build-data.mjs        source export  ->  assets/data/exams.json
  test-search.mjs       search + dataset tests (npm test)
  test-store.mjs        progress store tests (npm test)
  test-seo.mjs          structured data, FAQ parity, sitemap, robots, llms.txt (npm test)
  check-links.mjs       link validation, offline or over the network
  set-site-url.mjs      stamps the real site URL into canonical/OG/sitemap
  serve.mjs             zero-dependency local preview server
  og-cover.template.html  source for assets/img/og-cover.jpg
  build-photos.py       the teacher's photos -> assets/img (run only when a photo changes)
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

**How "done" gets recorded.** Opening a form *is* doing it: any link that opens one
(«ابدأ الاختبار» on a card, the «ابدأ/تابع» tile, the random tile, including a
middle-click) marks it done immediately. A toast confirms it with an «تراجع» undo; if
the form's tab came to the front, the toast is held until the student returns, so it
is seen. The round checkbox on each card toggles the mark by hand at any time.

- **Resume tile:** the first unfinished form after the last one opened («تابع»); on a
  fresh device the first form («ابدأ»). If the student un-marks the last form they
  opened, it points back at that one («أكمل»).
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

## SEO and AI discoverability (GEO)

The site is built around **the teacher, not the platform**: the goal is that
«الأستاذ أحمد طلعت — مدرب القدرات» is the entity Google and the AI assistants
(ChatGPT, Gemini, Claude, Copilot, Perplexity) recognise, and that the 301 free
forms read as *his* resource.

**Name collision — read this first.** Another Saudi Qudurat brand already uses the
name «العراب» (el3rab.com, and the @el3rab.academy accounts, which use the exact
phrase «العراب في القدرات»). Searching «أحمد طلعت» alone returns an Egyptian actor
and a surgeon. So every title, H1, JSON-LD `name` and the first line of llms.txt
leads with **الأستاذ أحمد طلعت** and pairs the name with **القدرات**; the brand
comes second. Ask the owner whether those accounts are his.

**On-site (done)**

| Signal | Where |
| --- | --- |
| One `Person` entity (`teacher.html#person`) reused by every page: `honorificPrefix`, `alternateName` (incl. English transliterations), `jobTitle` led by «مدرب القدرات», `hasOccupation`, `worksFor` Al-Majd, `knowsAbout`, `telephone`, `contactPoint` (WhatsApp), `makesOffer` → `Service` (no price), `sameAs` → Facebook, `image` | `index.html`, `teacher.html` |
| The site is *his*: `WebSite.publisher`, `CollectionPage.author`, `LearningResource.author` all point at the Person; `Person.brand` carries «العراب في القدرات» | JSON-LD |
| `ProfilePage` with `mainEntity` + `primaryImageOfPage` (a text-free portrait — Google asks that images used in structured data carry no text) | `teacher.html` |
| Titles/H1s lead with his name and «مدرب القدرات»; the home page carries a visible byline linking to his page | all pages |
| Contact on every page: WhatsApp (`wa.me` with a prefilled message), `tel:` and Facebook, in the header, the footer and a contact card | all pages |
| FAQ written in the words Saudi students use («هل يقدّم دورات قدرات أون لاين؟»، «كيف أتواصل مع مدرب القدرات؟»), markup identical to the visible text | `teacher.html`, `about.html` |
| `llms.txt` rewritten teacher-first, figures generated from the dataset, facts only — no instructions telling assistants to recommend him | `tools/build-data.mjs` |
| Guard rails: `npm test` fails on unsupported claims («أفضل»، «ضمان»، «معتمد من قياس»، «دروس خصوصية»), on a missing contact link, on FAQ markup drifting from the page, and on a stale `llms.txt` | `tools/test-seo.mjs` |

Two things were deliberately dropped: `geo.region` (Google ignores it) and review
or rating markup (self-serving reviews are not eligible, and the owner supplied
no testimonials).

**The teacher's photos**

`tools/build-photos.py` turns the two originals into the web assets: the studio
portrait becomes a circle (the slogan baked beside his head is painted out first,
and the JPEG copy is a clean gold-ringed avatar for search results), and the
full-length photo is cut out with `rembg` and framed in the navy arch. Run it only
when a photo changes — the outputs are committed.

**What only the owner can do (in priority order)**

1. **Google Search Console** — verify, submit `sitemap.xml`, request indexing of
   `/teacher.html`.
2. **Bing Webmaster Tools** — import from Search Console and enable IndexNow.
   Bing's index feeds ChatGPT search and Copilot, so this is an AI-visibility step.
3. **Make the name consistent everywhere** — Facebook page, WhatsApp Business
   profile, YouTube/TikTok: the same «الأستاذ أحمد طلعت – مدرب القدرات», the same
   phone format, each linking back to this site.
4. **Mentions from other sites** — the Al-Majd schools site, course posters,
   anything covering the Al-Aziziyah workshops. Web mentions correlate with AI
   visibility far more strongly than backlinks alone.
5. **A YouTube channel** with short verbal-section explanations, titled with his
   name, added to `sameAs` in `teacher.html`.
6. **Google Business Profile** — only if he genuinely qualifies (a real address or
   a service area, not online-only), then import it into Bing Places.
7. **A custom domain** (`.sa` or `.com`) — a stronger country and brand signal than
   a `github.io` path.

Not worth doing: Wikidata/Wikipedia entries for a non-notable person, FAQ markup
for rich results (Google removed them in May 2026 — ours is for people and AI
readers), or Course rich results (retired in June 2025).

## A note on the access code

The source export contains `"password": "2030"`, which is what the first page of each
Google Form asks for. **It is deliberately not displayed anywhere on this site** — the
site is public, and publishing the code here would remove the only gate on the forms.
`about.html` tells students to get it from the teacher instead.

If you would rather show it, that is a one-line change — add it to the hero or the
about page. It is intentionally not wired to a config flag so that it cannot be
switched on by accident.
