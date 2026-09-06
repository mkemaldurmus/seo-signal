#!/usr/bin/env node
// Keeps public/sitemap.xml in sync with the pages that actually exist.
//
// Adding a landing page used to mean remembering three separate edits (the
// file, the sitemap, the homepage footer). The sitemap one is the expensive
// miss: a page Google never sees in the sitemap sits at "URL is unknown to
// Google" indefinitely. This derives the sitemap from public/*.html instead.
//
// lastmod comes from the file's last git commit date, so it only moves when
// the page actually changed. Existing priority/changefreq values are kept —
// this is a sync, not a reset.
//
// Usage:
//   node scripts/sitemap-sync.mjs --check   (exit 1 on drift, default)
//   node scripts/sitemap-sync.mjs --write

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { requireSite, SITEMAP_EXCLUDE, CONTENT_DIR, requireContentDir, SITE, invokedAs } from './config.mjs'

const BASE = SITE
// Pages that exist but must never be advertised: search-console verification
// files, legal boilerplate you do not want competing for crawl budget.
// Configured via excludeFromSitemap.
const EXCLUDE = SITEMAP_EXCLUDE
const DEFAULT_PRIORITY = '0.7'
const DEFAULT_CHANGEFREQ = 'monthly'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { write: false, publicDir: CONTENT_DIR, topicMap: 'topic-map.csv' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') opts.write = true
    else if (args[i] === '--check') opts.write = false
    else if (args[i] === '--public-dir') opts.publicDir = args[++i]
    else if (args[i] === '--topic-map') opts.topicMap = args[++i]
    else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`usage: ${invokedAs('node scripts/sitemap-sync.mjs')} [--check|--write] [--public-dir <dir>]`)
      process.exit(1)
    } else throw new Error(`unknown argument: ${args[i]}`)
  }
  return opts
}

// slug -> {lastmod, changefreq, priority} from the sitemap we already ship, so
// hand-tuned priorities survive a sync.
function readExisting(file) {
  let xml = ''
  try {
    xml = readFileSync(file, 'utf8')
  } catch {
    return new Map()
  }
  const out = new Map()
  for (const block of xml.split('<url>').slice(1)) {
    const pick = (tag) => block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? ''
    const loc = pick('loc')
    if (!loc) continue
    out.set(loc.replace(`${BASE}/`, '').replace(BASE, ''), {
      lastmod: pick('lastmod'),
      changefreq: pick('changefreq') || DEFAULT_CHANGEFREQ,
      priority: pick('priority') || DEFAULT_PRIORITY,
    })
  }
  return out
}

// topic-map priority is 1-10; the sitemap wants 0.0-1.0.
function readTopicPriorities(file) {
  const out = new Map()
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.trim().split('\n').slice(1)) {
    const filename = line.split(',')[0]
    const priority = Number(line.split(',').pop())
    if (!filename || !Number.isFinite(priority)) continue
    out.set(filename.replace(/\.html$/, ''), (priority / 10).toFixed(1))
  }
  return out
}

function gitLastModified(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], {
      encoding: 'utf8', timeout: 10000,
      // git prints 'not a git repository' to stderr before throwing, which is
      // noise for anyone running this outside a checkout — the catch handles it.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out) return out
  } catch { /* not a repo, or the file is untracked — fall through */ }
  return new Date().toISOString().slice(0, 10)
}

function build(opts) {
  const files = readdirSync(opts.publicDir)
    .filter((f) => f.endsWith('.html') && !EXCLUDE.has(f))
    .sort()
  const existing = readExisting(path.join(opts.publicDir, 'sitemap.xml'))
  const topic = readTopicPriorities(opts.topicMap)

  // The homepage is served by the SPA, not by a file in public/.
  const entries = [{
    slug: '',
    lastmod: existing.get('')?.lastmod || new Date().toISOString().slice(0, 10),
    changefreq: existing.get('')?.changefreq || 'weekly',
    priority: existing.get('')?.priority || '1.0',
  }]

  for (const f of files) {
    const slug = f.replace(/\.html$/, '')
    const prev = existing.get(slug)
    const committed = gitLastModified(path.join(opts.publicDir, f))
    entries.push({
      slug,
      // Never move lastmod backwards: a page can be edited in the working tree
      // before it is committed, and an older date would tell Google to skip it.
      lastmod: prev?.lastmod && prev.lastmod > committed ? prev.lastmod : committed,
      changefreq: prev?.changefreq || DEFAULT_CHANGEFREQ,
      priority: prev?.priority || topic.get(slug) || DEFAULT_PRIORITY,
    })
  }

  const body = entries.map((e) => (
    `  <url>\n    <loc>${BASE}/${e.slug}</loc>\n` +
    `    <lastmod>${e.lastmod}</lastmod>\n` +
    `    <changefreq>${e.changefreq}</changefreq>\n` +
    `    <priority>${e.priority}</priority>\n  </url>`
  )).join('\n')

  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`,
    slugs: entries.map((e) => e.slug),
    existingSlugs: [...existing.keys()],
  }
}

function main() {
  const opts = parseArgs()
  requireSite('sitemap-sync')
  requireContentDir('sitemap-sync')
  const { xml, slugs, existingSlugs } = build(opts)
  const target = path.join(opts.publicDir, 'sitemap.xml')
  const missing = slugs.filter((s) => !existingSlugs.includes(s))
  const stale = existingSlugs.filter((s) => !slugs.includes(s))

  let current = ''
  try { current = readFileSync(target, 'utf8') } catch { /* first run */ }

  if (missing.length) console.error(`missing from sitemap: ${missing.map((s) => `/${s}`).join(', ')}`)
  if (stale.length) console.error(`in sitemap but no page: ${stale.map((s) => `/${s}`).join(', ')}`)

  if (current === xml) {
    console.error(`sitemap in sync (${slugs.length} urls)`)
    return
  }
  if (!opts.write) {
    console.error(`sitemap OUT OF SYNC (${slugs.length} urls expected) — rerun with --write`)
    process.exit(1)
  }
  writeFileSync(target, xml)
  console.error(`sitemap written (${slugs.length} urls) -> ${target}`)
}

try {
  main()
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
