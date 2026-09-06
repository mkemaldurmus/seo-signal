#!/usr/bin/env node
// Zero-dependency technical SEO crawler.
// Walks the static sitemap + homepage, checks on-page signals, detects
// orphans and broken internal links. Outputs JSON + CSV.
//
// Usage:
//   node scripts/seo/crawl.mjs --sitemap public/sitemap.xml --out /tmp/seo/crawl.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { requireSite, host, SITE } from './config.mjs'


const HOSTNAME = host()
// Matches root-relative links and absolute links back to this site.
const INTERNAL_LINK_RE = new RegExp(`href="(\\/[^"#?]*|https?://${HOSTNAME.replace(/\./g, '\\.')}/[^"#?]*)"`, 'g')
const UA = `Mozilla/5.0 (compatible; SeoSignal/1.0; +${SITE})`

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { sitemap: 'public/sitemap.xml', out: '/tmp/seo/crawl.json' }
  const keyMap = { '--sitemap': 'sitemap', '--out': 'out' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (keyMap[arg]) opts[keyMap[arg]] = args[++i]
    else if (arg === '--help' || arg === '-h') { console.error('usage: node scripts/seo/crawl.mjs [--sitemap <xml>] [--out <json>]'); process.exit(1) }
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function urlsFromSitemap(xml) {
  const urls = []
  for (const m of xml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/g)) urls.push(m[1])
  return urls
}

function meta(html, pattern) {
  const m = html.match(pattern)
  return m ? m[1].replace(/&amp;/g, '&').trim() : null
}

function stripTags(s) {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function crawlPage(url) {
  const started = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const html = await res.text()
  const ms = Date.now() - started
  const base = new URL(url)
  const canonical = meta(html, /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)
  const internalLinks = [...html.matchAll(INTERNAL_LINK_RE)]
    .map((m) => new URL(m[1], base))
    .filter((u) => u.hostname === HOSTNAME)
    .map((u) => u.pathname)
  const body = html
    .replace(/<nav[\s>][\s\S]*?<\/nav>/g, '')
    .replace(/<header[\s>][\s\S]*?<\/header>/g, '')
    .replace(/<footer[\s>][\s\S]*?<\/footer>/g, '')
  const bodyInternal = [...body.matchAll(INTERNAL_LINK_RE)]
    .map((m) => new URL(m[1], base))
    .filter((u) => u.hostname === HOSTNAME)
    .map((u) => u.pathname)
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => stripTags(m[1]))
  const jsonLd = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => {
    try { return JSON.parse(m[1]) } catch { return null }
  }).filter(Boolean)
  const ldTypes = [...new Set(jsonLd.flatMap((d) => (Array.isArray(d) ? d : [d])).map((d) => d['@type']).filter(Boolean))]
  const title = meta(html, /<title>([\s\S]*?)<\/title>/)
  const description = meta(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/)
  const robots = meta(html, /<meta[^>]+name="robots"[^>]+content="([^"]+)"/)
  const ogImage = meta(html, /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/)
  const ogTitle = meta(html, /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/)
  return {
    url: url.toString(),
    path: base.pathname,
    status: res.status,
    finalUrl: res.url,
    redirected: res.url !== url.toString(),
    ms,
    bytes: html.length,
    title,
    titleLength: (title || '').length,
    description,
    descriptionLength: (description || '').length,
    canonical,
    canonicalOk: canonical ? new URL(canonical).pathname === base.pathname : false,
    robots,
    h1Count: h1s.length,
    h1: h1s[0] || null,
    ldTypes,
    ogImage: !!ogImage,
    ogTitle: !!ogTitle,
    internalLinks: internalLinks.length,
    internalLinkPaths: [...new Set(internalLinks)],
    bodyInternalLinks: [...new Set(bodyInternal)].length,
  }
}

function toCsv(rows) {
  const fields = ['url', 'status', 'ms', 'titleLength', 'descriptionLength', 'canonicalOk', 'robots', 'h1Count', 'ldTypes', 'ogImage', 'internalLinks', 'bodyInternalLinks']
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [fields.join(',')].concat(rows.map((r) => fields.map((f) => esc(r[f])).join(','))).join('\n')
}

async function main() {
  const opts = parseArgs()
  requireSite('crawl')
  const sitemap = readFileSync(path.resolve(opts.sitemap), 'utf8')
  const urls = urlsFromSitemap(sitemap)
  if (!urls.length) throw new Error(`no URLs found in sitemap ${opts.sitemap}`)
  const results = []
  for (const url of urls) {
    try {
      results.push(await crawlPage(url))
      console.error(`ok   ${results.at(-1).status} ${url}`)
    } catch (err) {
      results.push({ url, status: 0, error: err.message })
      console.error(`FAIL ${url}: ${err.message}`)
    }
  }
  // orphan check: sitemap pages never linked from any other crawled page (nav+footer+body)
  const crawled = new Set(results.map((r) => r.path))
  const linkedAll = new Set()
  for (const r of results) {
    if (r.internalLinkPaths) for (const l of r.internalLinkPaths) linkedAll.add(l)
  }
  const orphans = [...crawled].filter((p) => !linkedAll.has(p) && p !== '/')
  const report = { crawledAt: new Date().toISOString(), pages: results, orphans }
  const outPath = path.resolve(opts.out)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  writeFileSync(outPath.replace(/\.json$/, '.csv'), toCsv(results))
  const issues = results.filter((r) => r.status !== 200 || (r.titleLength && r.titleLength < 30) || !r.descriptionLength || !r.canonicalOk || r.h1Count !== 1 || !r.ogImage)
  console.error(`\ncrawled ${results.length} pages, ${issues.length} with issues, orphans: ${orphans.join(', ') || 'none'}`)
  console.error(`report -> ${outPath}`)
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1) })
