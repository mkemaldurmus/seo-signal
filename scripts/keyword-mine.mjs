#!/usr/bin/env node
// Finds queries people actually type that no page here answers.
//
// GSC only ever shows queries the site ALREADY ranks for, so on its own it can
// never point at a topic we have not written yet — every "opportunity" it
// produces is a page we already have. This closes that blind spot using Google
// autocomplete, which is real query data, free, and needs no auth: expand each
// seed, drop the suggestions our pages already cover, and rank what is left by
// how many independent seeds surfaced it.
//
// Seeds come from topic-map.csv keywords plus --seed arguments.
//
// Usage:
//   node scripts/keyword-mine.mjs --out out/keywords.json
//     [--topic-map topic-map.csv] [--content-dir public]
//     [--seed "x bookmarks"] [--max-seeds 40] [--deep]
//
// --deep suffixes every seed with a-z and ten question words, which is the
// difference between seeing the head of a topic's demand and seeing its tail
// (20 seeds -> 740 prefixes, 225 suggestions -> 2721). It costs ~10 minutes and
// ~740 requests, so the pipeline runs the shallow version and --deep is for
// occasional research passes when you are about to write a batch of pages.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { CONTENT_DIR, BRAND_TERMS, TOPIC_VOCABULARY, requireContentDir, invokedAs } from './config.mjs'

const SUGGEST = 'https://suggestqueries.google.com/complete/search'
// Autocomplete is not a rate-limited API in any documented sense, but it is
// also not ours — keep the request rate obviously polite.
const DELAY_MS = 350
// Suggestions containing these are navigational or off-topic noise, not gaps.
const STOPWORDS = ['login', 'sign in', 'apk', 'download for pc', '.html', ...BRAND_TERMS]
// Seeds like "chrome extension" and "browser extension" are ours, but their
// autocomplete is dominated by the rest of the extension store (vpn, ad
// blocker, video downloader). A suggestion has to mention something we are
// actually in the business of to count as a gap.
const QUESTION_WORDS = ['how', 'why', 'what', 'where', 'can', 'does', 'is', 'best', 'without', 'vs']
const TOPIC_TOKENS = TOPIC_VOCABULARY

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = {
    topicMap: 'topic-map.csv',
    contentDir: CONTENT_DIR,
    out: 'out/keywords.json',
    seeds: [],
    maxSeeds: 40,
    deep: false,
  }
  const keyMap = { '--topic-map': 'topicMap', '--content-dir': 'contentDir', '--out': 'out' }
  for (let i = 0; i < args.length; i++) {
    if (keyMap[args[i]]) opts[keyMap[args[i]]] = args[++i]
    else if (args[i] === '--seed') opts.seeds.push(args[++i])
    else if (args[i] === '--max-seeds') opts.maxSeeds = Number(args[++i])
    else if (args[i] === '--deep') opts.deep = true
    else if (args[i] === '--help' || args[i] === '-h') {
      console.error(`usage: ${invokedAs('node scripts/keyword-mine.mjs')} --out <json> [--seed <phrase>] [--max-seeds 40] [--deep]`)
      process.exit(1)
    } else throw new Error(`unknown argument: ${args[i]}`)
  }
  return opts
}

// The keywords column is quoted and comma-separated inside the quotes.
function seedsFromTopicMap(file) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const seeds = []
  for (const line of text.trim().split('\n').slice(1)) {
    const quoted = line.match(/"([^"]*)"/)?.[1]
    if (!quoted) continue
    for (const kw of quoted.split(',')) {
      const s = kw.trim().toLowerCase()
      if (s) seeds.push(s)
    }
  }
  return seeds
}

// A suggestion counts as covered when an existing page's visible text already
// contains every significant word in it. Deliberately generous: the point is to
// surface topics with NO page, not to re-litigate wording on pages we have.
function buildCoverage(contentDir) {
  const pages = []
  for (const f of readdirSync(contentDir)) {
    if (!f.endsWith('.html')) continue
    const raw = readFileSync(path.join(contentDir, f), 'utf8')
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
    pages.push({ file: f, words: new Set(text.split(' ').filter(Boolean)) })
  }
  return pages
}

function isCovered(phrase, pages) {
  const words = phrase.split(/[^a-z0-9]+/).filter((w) => w.length > 2)
  if (!words.length) return true
  return pages.some((p) => words.every((w) => p.words.has(w)))
}

async function suggest(seed) {
  const url = `${SUGGEST}?${new URLSearchParams({ q: seed, client: 'firefox', hl: 'en', gl: 'us' })}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return []
    const body = JSON.parse(await res.text())
    return Array.isArray(body?.[1]) ? body[1].map((s) => String(s).toLowerCase()) : []
  } catch {
    return []
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const opts = parseArgs()
  requireContentDir('keyword-mine')
  let seeds = [...new Set([...opts.seeds, ...seedsFromTopicMap(opts.topicMap)])].slice(0, opts.maxSeeds)
  // --deep: autocomplete only returns ~10 completions per prefix, so a bare seed
  // shows the head of its demand and nothing else. Suffixing each seed with a
  // letter and with question words walks the same index sideways and surfaces
  // the long tail that the plain query hides.
  if (opts.deep) {
    const suffixes = [...'abcdefghijklmnopqrstuvwxyz', ...QUESTION_WORDS]
    seeds = seeds.flatMap((s) => [s, ...suffixes.map((x) => `${s} ${x}`)])
    console.error(`deep mode: ${seeds.length} expanded prefixes`)
  }
  const pages = buildCoverage(opts.contentDir)
  console.error(`mining ${seeds.length} seeds against ${pages.length} pages`)

  // seed count is the signal: a phrase several unrelated seeds converge on is a
  // real cluster, one that only shows up once is usually a long-tail accident.
  const hits = new Map()
  for (const seed of seeds) {
    for (const s of await suggest(seed)) {
      if (s === seed) continue
      if (STOPWORDS.some((w) => s.includes(w))) continue
      if (!TOPIC_TOKENS.some((w) => s.includes(w))) continue
      const entry = hits.get(s) || { phrase: s, seeds: new Set() }
      entry.seeds.add(seed)
      hits.set(s, entry)
    }
    await sleep(DELAY_MS)
  }

  const rows = [...hits.values()]
    .map((h) => ({ phrase: h.phrase, seedCount: h.seeds.size, seeds: [...h.seeds], covered: isCovered(h.phrase, pages) }))
    .sort((a, b) => b.seedCount - a.seedCount || a.phrase.localeCompare(b.phrase))

  const gaps = rows.filter((r) => !r.covered)
  const result = {
    minedAt: new Date().toISOString(),
    deep: opts.deep,
    seeds: seeds.length,
    suggestions: rows.length,
    gaps: gaps.length,
    topGaps: gaps.slice(0, 40),
    all: rows,
  }
  mkdirSync(path.dirname(opts.out), { recursive: true })
  writeFileSync(opts.out, JSON.stringify(result, null, 2))
  console.error(`${rows.length} suggestions, ${gaps.length} uncovered -> ${opts.out}`)
  for (const g of gaps.slice(0, 12)) console.error(`  gap x${g.seedCount}  ${g.phrase}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
