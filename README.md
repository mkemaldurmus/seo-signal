# seo-signal

Zero-dependency SEO scripts for sites whose pages live in a git repo.

No SaaS, no API keys beyond the free ones, no `node_modules`. Seven Node scripts
that each answer one question a real site kept getting wrong.

They came out of running [zihin.engineer](https://zihin.engineer) for a year and
repeatedly discovering that the dashboard could not see the thing that was
actually broken. Three of them exist because of a specific, embarrassing miss.

---

## The three that are not obvious

### `keyword-mine.mjs` — the queries Search Console structurally cannot show you

Search Console reports the queries you **already rank for**. That sounds like a
keyword tool and isn't one: it is blind, by construction, to every topic you
have no page for. Every "opportunity" it surfaces is a page you already wrote.

This mines Google autocomplete instead — real query data, free, no auth — then
subtracts what your existing pages already cover and ranks what's left by how
many independent seeds converged on it. A phrase several unrelated seeds all
point at is a cluster; one that appears once is usually a long-tail accident.

```bash
node scripts/keyword-mine.mjs --out out/keywords.json
node scripts/keyword-mine.mjs --deep --out out/keywords-deep.json
```

`--deep` suffixes every seed with a–z and ten question words. Autocomplete only
returns ~10 completions per prefix, so a bare seed shows you the head of a topic
and nothing else. On one run: 20 seeds became 740 prefixes, 225 suggestions
became 2721, and uncovered gaps went from 88 to 1619.

Set `topicTokens` in the config to your domain's vocabulary. Without it, a broad
seed like "chrome extension" fills the report with vpn and ad-blocker queries.

### `staleness.mjs` — which page is quietly answering an expired question

A page on the site this came from opened with *"X gives you no way to search
them."* X had shipped that search bar roughly two years earlier. It was the
site's third-biggest impression earner, stuck at position 46, and **nothing in
any tool could see it**: crawlers check structure, Search Console reports rank,
and neither reads what a sentence claims.

This cannot verify a fact either. What it does is rank pages by how likely they
are to have rotted, so the re-read is aimed instead of random:

- **age** — days since the page was last edited, from git
- **absolute claims** — "there is no", "cannot export", "does not support",
  "never". These are exactly the sentences a competitor's product update turns
  into a lie.
- **a past year in the title** — a page announcing its own expiry

```bash
node scripts/staleness.mjs --out out/staleness.json
```

Body text is deliberately excluded from the year check: "X made likes private in
June 2024" is legitimate history, not rot.

### `ping-index.mjs` — an honest account of what "tell Google to index this" can do

Almost nothing, and most guides are vague about it. This script is explicit:

- **Google's Indexing API is restricted to `JobPosting` and `BroadcastEvent`.**
  Using it for ordinary pages violates its terms and does not work. It is
  deliberately not wired up here.
- **Sitemap ping URLs were deprecated in 2023.**
- What is left for Google: **resubmitting your sitemap** through the Search
  Console API, internal links, and a fresh `lastmod`. Per-URL "Request indexing"
  is a manual click in the UI, roughly 10–12 a day.
- **IndexNow** covers Bing, Yandex, Seznam and Naver. Google does not
  participate. It is still worth doing; it is just not Google.

```bash
node scripts/ping-index.mjs --dry-run
node scripts/ping-index.mjs
```

Generates and manages the IndexNow key, publishes it to your content directory,
and submits every sitemap you configure — including ones your server renders at
request time for user-generated pages, which are easy to forget and often never
submitted to Search Console at all.

---

## The other four

| Script | What it does |
|---|---|
| `sitemap-sync.mjs` | Derives `sitemap.xml` from your HTML files, `lastmod` from each file's last commit. `--check` exits 1 on drift, so a page can't ship without being in the sitemap. Existing priorities survive; lastmod never moves backwards. |
| `crawl.mjs` | Zero-dependency crawl of every sitemap URL: status, title and description length, canonical, H1 count, JSON-LD types, OG image, internal links, orphans. |
| `psi.mjs` | PageSpeed Insights / Core Web Vitals for every page. Retries transient Lighthouse 500s, which are frequent enough that a third of a run can otherwise come back as `NaN`. |
| `gsc-fetch.mjs` | Search Console Search Analytics to CSV. Two auth modes: gcloud ADC, or a service-account key. |

## Setup

Node 18+. Nothing to install.

```bash
git clone https://github.com/mkemaldurmus/seo-signal
cd seo-signal
cp seo-signal.config.example.json seo-signal.config.json
$EDITOR seo-signal.config.json
```

```json
{
  "site": "https://example.com",
  "gscProperty": "sc-domain:example.com",
  "gcpQuotaProject": "my-gcp-project",
  "contentDir": "public",
  "brandTerms": ["acme"],
  "topicTokens": ["invoice", "billing", "receipt"],
  "extraFeeds": ["/c/sitemap.xml"],
  "excludeFromSitemap": ["terms.html"]
}
```

Every value also reads from an environment variable (`SEO_SIGNAL_SITE`,
`SEO_SIGNAL_GSC_PROPERTY`, …) so CI can point the same scripts at staging.

Point `contentDir` at the directory holding your static `.html` pages. The
scripts that need git read it from wherever you run them; outside a checkout
they degrade quietly instead of failing.

### Search Console access

Only `gsc-fetch.mjs` and `ping-index.mjs` need it.

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters
gcloud auth application-default set-quota-project YOUR_PROJECT
```

**Run the second command.** `application-default login` clears
`quota_project_id`, Search Console rejects user ADC without one, and it reports
that as a **403 whose message reads like an auth-scope failure**. Two unrelated
problems share that status code and need opposite fixes — read the response body
before believing the message. Both scripts here name the right one.

Read-only use (`gsc-fetch.mjs`) works with `webmasters.readonly`. Resubmitting a
sitemap is a write and needs the full `webmasters` scope.

### PageSpeed Insights

`psi.mjs` works without a key at a low rate limit. For a real run, get a free
API key and set `PSI_API_KEY`.

## Two things that will fool you

**A 200 does not mean the file exists.** If your host has an SPA fallback
(`try_files {path} {path}.html /index.html` and friends), *every* unknown path
returns 200 with your app shell. A deploy check written as
`curl -o /dev/null -w "%{http_code}"` will report success for a file that was
never deployed. Compare the response **body**.

**The Sitemaps API `indexed` count is deprecated and always returns 0.**
`contents: {submitted: 21, indexed: 0}` does not mean nothing is indexed. Use
URL Inspection, which is authoritative — it said 12 of 17 at the same moment
that field said zero.

## Licence

MIT.
