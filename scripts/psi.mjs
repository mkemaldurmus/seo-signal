#!/usr/bin/env node
// Zero-dependency PageSpeed Insights / Core Web Vitals check for the SEO pages.
// Uses the free PageSpeed Insights API (no key needed; optional PSI_API_KEY env
// raises the quota). CWV are a real ranking signal, so this belongs in the
// SEO pipeline alongside GSC data.
//
// Usage:
//   node scripts/seo/psi.mjs --sitemap public/sitemap.xml --out /tmp/seo/psi.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { invokedAs } from './config.mjs'

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { sitemap: 'public/sitemap.xml', out: '/tmp/seo/psi.json', strategies: ['mobile'] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--sitemap') opts.sitemap = args[++i]
    else if (arg === '--out') opts.out = args[++i]
    else if (arg === '--strategies') opts.strategies = args[++i].split(',')
    else if (arg === '--help' || arg === '-h') { console.error(`usage: ${invokedAs('node scripts/psi.mjs')} [--sitemap <xml>] [--out <json>] [--strategies mobile,desktop]`); process.exit(1) }
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function metric(audit) {
  if (!audit || audit.score === null || audit.score === undefined) return null
  return { score: audit.score, display: audit.displayValue || null }
}

async function check(url, strategy) {
  const key = process.env.PSI_API_KEY || ''
  const q = new URLSearchParams({ url, strategy, category: 'performance' })
  if (key) q.set('key', key)
  const res = await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(120000) })
  const data = await res.json()
  if (!res.ok) throw new Error(`PSI ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
  const lr = data.lighthouseResult
  const audits = lr?.audits || {}
  return {
    url,
    strategy,
    performance: lr ? lr.categories.performance?.score : null,
    seo: data.lighthouseResult?.categories?.seo?.score ?? null,
    fcp: metric(audits['first-contentful-paint']),
    lcp: metric(audits['largest-contentful-paint']),
    cls: metric(audits['cumulative-layout-shift']),
    tbt: metric(audits['total-blocking-time']),
    speedIndex: metric(audits['speed-index']),
    opportunitySavings: lr?.categories?.performance?.auditRefs
      ?.filter((a) => a.group === 'load-opportunities' && a.weight > 0)
      .map((a) => ({ id: a.id, savings: audits[a.id]?.displayValue })) || [],
  }
}

function toCsv(rows) {
  const fields = ['url', 'strategy', 'performance', 'fcp', 'lcp', 'cls', 'tbt']
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const lines = rows.map((r) => fields.map((f) => {
    const v = r[f]
    return esc(v && typeof v === 'object' ? v.display : v)
  }).join(','))
  return [fields.join(',')].concat(lines).join('\n')
}

async function main() {
  const opts = parseArgs()
  const xml = readFileSync(path.resolve(opts.sitemap), 'utf8')
  const urls = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
  const results = []
  for (const url of urls) {
    for (const strategy of opts.strategies) {
      // Lighthouse 500s are routine and transient — a third of a run can come
      // back "Something went wrong" and pass on an immediate retry, which left
      // the report showing NaN for pages that are actually fine.
      let last
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          results.push(await check(url, strategy))
          console.error(`ok   ${strategy} ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
          last = null
          break
        } catch (err) {
          last = err
          const retriable = /PSI 5\d\d|timeout|fetch failed/i.test(err.message)
          if (!retriable || attempt === 3) break
          console.error(`retry ${attempt} ${strategy} ${url}: ${err.message.slice(0, 80)}`)
          await new Promise((r) => setTimeout(r, attempt * 5000))
        }
      }
      if (last) {
        results.push({ url, strategy, error: last.message })
        console.error(`FAIL ${strategy} ${url}: ${last.message}`)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  const outPath = path.resolve(opts.out)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify({ crawledAt: new Date().toISOString(), pages: results }, null, 2))
  writeFileSync(outPath.replace(/\.json$/, '.csv'), toCsv(results))
  console.error(`report -> ${outPath}`)
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1) })
