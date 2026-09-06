# Changelog

## 0.1.0 — unreleased

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
