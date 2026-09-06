#!/usr/bin/env node
// Flags pages that are probably out of date, before Google notices for us.
//
// This exists because of a specific miss. /search-x-bookmarks opened with "X
// gives you no way to search them" for roughly two years after X shipped a
// bookmarks search bar. It was the site's third-biggest impression earner and
// it was answering a question whose premise had expired, sitting at position
// 46 the whole time. Nothing in the pipeline could see it: the crawl checks
// structure, GSC reports rank, and neither knows what a sentence claims.
//
// Nothing here can verify a fact. What it can do is rank pages by how likely
// they are to have rotted, so a human re-reads the top of the list instead of
// re-reading twenty pages at random. Three signals:
//
//   age        how long since the page was last edited (git)
//   absolutes  "there is no", "you cannot", "X does not" — claims about a
//              platform's missing features, which is exactly the kind of
//              sentence a product update turns into a lie
//   years      a hardcoded year older than the current one
//
// Usage:
//   node scripts/staleness.mjs --content-dir public --out out/staleness.json

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { SITE, CONTENT_DIR, SITEMAP_EXCLUDE, requireContentDir, invokedAs } from './config.mjs'

// Phrases that assert a platform lacks something. Kept narrow on purpose: a
// generic negation matcher flags every sentence on every page and the ranking
// stops meaning anything.
const ABSOLUTE_CLAIMS = [
  /\bthere(?:'s| is| are)? no\b/gi,
  /\bhas no\b/gi,
  /\bhave no\b/gi,
  /\bdoes(?: not|n't) (?:have|support|let|offer|include|provide)\b/gi,
  /\bcan(?:not|'t) (?:search|export|sort|filter|find|organize|organise)\b/gi,
  /\bno (?:built-in|native|official) \w+/gi,
  /\bnever\b/gi,
  /\bonly way\b/gi,
]

const EXCLUDE = SITEMAP_EXCLUDE

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { contentDir: CONTENT_DIR, out: 'out/staleness.json', ageWarnDays: 120, minBytes: 1000 }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--content-dir') opts.contentDir = args[++i]
    else if (args[i] === '--out') opts.out = args[++i]
    else if (args[i] === '--age-warn-days') opts.ageWarnDays = Number(args[++i])
    else if (args[i] === '--min-bytes') opts.minBytes = Number(args[++i])
    else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`usage: ${invokedAs('node scripts/staleness.mjs')} [--content-dir <dir>] [--out <json>] [--age-warn-days 120] [--min-bytes 1000]`)
      process.exit(1)
    } else throw new Error(`unknown argument: ${args[i]}`)
  }
  return opts
}

// An untracked or brand-new file has no commit yet. That is the opposite of
// stale, so it must not fall through to a huge age — doing so put a page
// written five minutes earlier at the top of the list.
function lastEdited(file) {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      encoding: 'utf8', timeout: 10000,
      // git prints 'not a git repository' to stderr before throwing, which is
      // noise for anyone running this outside a checkout — the catch handles it.
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return iso || new Date().toISOString()
  } catch {
    return new Date().toISOString()
  }
}

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
}

// One sentence of context per hit, so the report is reviewable without opening
// the file.
function claimSnippets(text) {
  const out = []
  for (const re of ABSOLUTE_CLAIMS) {
    for (const m of text.matchAll(re)) {
      const start = Math.max(0, m.index - 60)
      const snippet = text.slice(start, m.index + 90).trim()
      out.push({ match: m[0].toLowerCase(), snippet })
      if (out.length > 60) return out
    }
  }
  return out
}

function main() {
  const opts = parseArgs()
  requireContentDir('staleness')
  const currentYear = new Date().getFullYear()
  const now = Date.now()
  const pages = []
  const skipped = { notHtml: 0, excluded: 0, tooSmall: 0 }

  for (const f of readdirSync(opts.contentDir)) {
    if (!f.endsWith('.html')) { skipped.notHtml++; continue }
    if (EXCLUDE.has(f)) { skipped.excluded++; continue }
    const full = path.join(opts.contentDir, f)
    const html = readFileSync(full, 'utf8')
    // Stubs, redirect shims and verification files are not content, and
    // scoring them buries the pages that matter.
    if (html.length < opts.minBytes) { skipped.tooSmall++; continue }
    const text = visibleText(html)
    const edited = lastEdited(full)
    const ageDays = Math.max(0, Math.round((now - Date.parse(edited)) / 86400000))

    const claims = claimSnippets(text)
    // Only the title and H1 count. A past year in the body is usually a
    // legitimate historical reference ("X made likes private in June 2024");
    // a past year in the title is a page announcing itself as out of date.
    const headline = [
      html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '',
      html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '',
    ].join(' ')
    const staleYears = [...new Set(
      [...headline.matchAll(/\b(20[12]\d)\b/g)].map((m) => Number(m[1])).filter((y) => y < currentYear),
    )]

    // Age dominates, because a page nobody has re-read is the one that rots.
    // Claims and stale years are multipliers on that, not standalone alarms.
    const score = Math.round(
      Math.min(ageDays / opts.ageWarnDays, 3) * 40 +
      Math.min(claims.length, 12) * 4 +
      staleYears.length * 25,
    )

    pages.push({
      file: f,
      url: `${SITE}/${f.replace(/\.html$/, '')}`,
      lastEdited: edited.slice(0, 10),
      ageDays,
      absoluteClaims: claims.length,
      staleYears,
      score,
      topClaims: claims.slice(0, 3),
    })
  }

  pages.sort((a, b) => b.score - a.score)
  mkdirSync(path.dirname(opts.out), { recursive: true })
  writeFileSync(opts.out, JSON.stringify({ checkedAt: new Date().toISOString(), currentYear, pages }, null, 2))
  console.error(`${pages.length} pages scored -> ${opts.out}`)
  if (!pages.length) {
    const seen = skipped.notHtml + skipped.excluded + skipped.tooSmall
    if (!seen) {
      console.error(`  ${opts.contentDir}/ is empty — is contentDir pointing at your built pages?`)
    } else {
      console.error(`  nothing in ${opts.contentDir}/ qualified: ${skipped.tooSmall} file(s) under ${opts.minBytes} bytes` +
        `, ${skipped.excluded} excluded by config, ${skipped.notHtml} not .html`)
      if (skipped.tooSmall) console.error('  raise or lower the floor with --min-bytes if those are real pages')
    }
  }
  for (const p of pages.slice(0, 8)) {
    console.error(`  ${String(p.score).padStart(3)}  ${p.file}  (${p.ageDays}d old, ${p.absoluteClaims} absolute claims${p.staleYears.length ? `, years ${p.staleYears.join('/')}` : ''})`)
  }
}

try {
  main()
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
