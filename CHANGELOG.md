# Changelog

## 0.1.2

Published 2026-09-06. (0.1.1 was tagged in the tree but never reached the
registry — a broken local npm auth token swallowed it — so its contents ship
here.)

- `staleness` explains an empty result instead of printing `0 pages scored` and
  exiting silently. It now reports how many files were skipped as too small,
  excluded by config, or not HTML — and says so differently when the directory
  is simply empty. Found by running the published 0.1.0 package against a stub
  page, which is exactly the first run a new user gets.
- The size floor is now `--min-bytes` (default 1000) rather than a constant.

## 0.1.0

First cut, extracted from a year of running one small product site.

- `keywords` — keyword-gap mining from Google autocomplete, with `--deep` to
  walk the autocomplete index sideways (a-z and question-word suffixes).
- `staleness` — scores pages by how likely they are to be out of date: age from
  git, count of absolute claims, a past year in the title.
- `sitemap` — derives `sitemap.xml` from your pages; `--check` exits 1 on drift.
- `ping` — IndexNow submit plus Search Console sitemap resubmit, and a README
  that is explicit about what Google's indexing APIs cannot do.
- `crawl`, `psi`, `gsc` — technical crawl, Core Web Vitals, Search Console CSV.
- `init` writes a starter config.
- Zero dependencies, enforced in CI. Twelve end-to-end tests on Node 18 and 22.
