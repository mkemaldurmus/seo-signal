// Single source of site-specific values, so every script below stays generic.
//
// Looked up in this order: environment variable, then seo-signal.config.json in
// the working directory, then a default. The env override exists so CI can run
// these against a staging host without editing a committed file.

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const CONFIG_FILE = process.env.SEO_SIGNAL_CONFIG || 'seo-signal.config.json'

function load() {
  const p = path.resolve(CONFIG_FILE)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`)
  }
}

const file = load()

function pick(key, envKey, fallback) {
  return process.env[envKey] || file[key] || fallback
}

// https://example.com — no trailing slash.
export const SITE = pick('site', 'SEO_SIGNAL_SITE', '').replace(/\/$/, '')

// Search Console property. Domain properties look like "sc-domain:example.com";
// URL-prefix properties look like "https://example.com/".
export const GSC_PROPERTY = pick('gscProperty', 'SEO_SIGNAL_GSC_PROPERTY', SITE ? `sc-domain:${host()}` : '')

// Google Cloud project used for API quota. Search Console rejects user ADC
// without one, and `gcloud auth application-default login` silently clears it,
// so this is worth setting explicitly.
export const QUOTA_PROJECT = pick('gcpQuotaProject', 'SEO_SIGNAL_QUOTA_PROJECT', '')

// Directory of static .html pages to crawl, score and list in the sitemap.
export const CONTENT_DIR = pick('contentDir', 'SEO_SIGNAL_CONTENT_DIR', 'public')

// Your own product and brand names. Keyword mining drops suggestions containing
// these: a navigational search for your own name is not a content gap.
export const BRAND_TERMS = file.brandTerms || []

// The vocabulary of your domain. Keyword mining keeps a suggestion only if it
// contains one of these, which is what stops a broad seed like "chrome
// extension" from filling the report with vpn and ad-blocker queries.
export const TOPIC_VOCABULARY = file.topicTokens || []

// Sitemaps your server renders at request time (user-generated pages, for
// instance) rather than ones committed to the repo. Absolute URLs.
export const EXTRA_FEEDS = (file.extraFeeds || []).map((f) =>
  f.startsWith('http') ? f : `${SITE}${f.startsWith('/') ? '' : '/'}${f}`,
)

// Filenames under CONTENT_DIR that exist but should never enter the sitemap —
// search-engine verification files, legal boilerplate you do not want competing
// for crawl budget.
export const SITEMAP_EXCLUDE = new Set(file.excludeFromSitemap || [])

export function host() {
  try {
    return new URL(SITE).hostname
  } catch {
    return ''
  }
}

export function requireContentDir(script) {
  if (!existsSync(CONTENT_DIR)) {
    throw new Error(
      `${script}: contentDir "${CONTENT_DIR}" does not exist. Point it at the directory ` +
      `holding your static .html pages in ${CONFIG_FILE}, or set SEO_SIGNAL_CONTENT_DIR.`,
    )
  }
  return CONTENT_DIR
}

export function requireSite(script) {
  if (!SITE) {
    throw new Error(
      `${script}: no site configured. Create ${CONFIG_FILE} with {"site": "https://example.com"} ` +
      'or set SEO_SIGNAL_SITE.',
    )
  }
  return SITE
}
