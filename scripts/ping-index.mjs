#!/usr/bin/env node
// Tells search engines to come and look, after a content change.
//
// Two mechanisms, because they cover different engines:
//
//   IndexNow  — Bing, Yandex, Seznam, Naver. One POST with a URL list, no auth
//               beyond a key file hosted on the domain. Google does NOT
//               participate, so this is Bing-and-friends coverage, not Google.
//   GSC       — resubmitting the sitemap through the Search Console API is the
//               only programmatic nudge Google actually offers for ordinary
//               pages. The Indexing API is restricted to JobPosting and
//               BroadcastEvent; using it for landing pages is against its terms
//               and does nothing, so it is deliberately not wired up here.
//               Per-URL "Request indexing" remains a manual click in the GSC UI.
//
// The GSC call needs the full webmasters scope, not webmasters.readonly:
//   gcloud auth application-default login \
//     --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters
//
// Usage:
//   node scripts/ping-index.mjs --sitemap public/sitemap.xml [--dry-run]
//     [--only-changed <n>]     only submit the n most recently modified urls
//     [--skip-dynamic]         static sitemap only, skip server-rendered feeds

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { requireSite, host, GSC_PROPERTY, QUOTA_PROJECT, CONTENT_DIR, EXTRA_FEEDS, SITE } from './config.mjs'

const BASE = SITE
const HOST = host()
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
const SITE_URL = GSC_PROPERTY
// The static sitemap ships in your repo. EXTRA_FEEDS are ones a server renders
// at request time — user-generated pages, for instance — which can only be read
// over HTTP. Every configured feed is submitted on each run.
const FEEDS = [`${BASE}/sitemap.xml`, ...EXTRA_FEEDS]

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { sitemap: `${CONTENT_DIR}/sitemap.xml`, publicDir: CONTENT_DIR, dryRun: false, onlyChanged: 0, skipDynamic: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sitemap') opts.sitemap = args[++i]
    else if (args[i] === '--public-dir') opts.publicDir = args[++i]
    else if (args[i] === '--only-changed') opts.onlyChanged = Number(args[++i])
    else if (args[i] === '--dry-run') opts.dryRun = true
    else if (args[i] === '--skip-dynamic') opts.skipDynamic = true
    else if (args[i] === '--help' || args[i] === '-h') {
      console.error('usage: node scripts/seo/ping-index.mjs [--sitemap public/sitemap.xml] [--only-changed <n>] [--skip-dynamic] [--dry-run]')
      process.exit(1)
    } else throw new Error(`unknown argument: ${args[i]}`)
  }
  return opts
}

// The key is a shared secret only in the weakest sense — it is published at
// /<key>.txt so the engine can prove we control the domain. Keeping it out of
// the repo anyway keeps the public repo free of one more thing to rotate.
function loadOrCreateKey(publicDir) {
  const keyFile = process.env.INDEXNOW_KEY_FILE || path.join(os.homedir(), '.seo-signal', 'indexnow-key')
  let key = process.env.INDEXNOW_KEY || ''
  if (!key && existsSync(keyFile)) key = readFileSync(keyFile, 'utf8').trim()
  if (!key) {
    key = randomBytes(16).toString('hex')
    mkdirSync(path.dirname(keyFile), { recursive: true })
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 })
    console.error(`generated new IndexNow key -> ${keyFile}`)
  }
  const published = path.join(publicDir, `${key}.txt`)
  if (!existsSync(published)) {
    writeFileSync(published, key)
    console.error(`wrote key file ${published} — this must be DEPLOYED before the ping is accepted`)
  }
  return key
}

function readSitemapUrls(file) {
  const xml = readFileSync(file, 'utf8')
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
}

// Server-rendered feeds exist only at request time, so their URLs have to come
// off the network. A failure here must not sink the ping for the static pages.
async function fetchDynamicUrls() {
  const urls = []
  for (const feed of EXTRA_FEEDS) {
    try {
      const res = await fetch(feed, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) {
        console.error(`${feed}: ${res.status}, skipping those urls`)
        continue
      }
      const xml = await res.text()
      urls.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]))
    } catch (err) {
      console.error(`${feed} unreachable (${err.message}), skipping those urls`)
    }
  }
  return urls
}

// Recently touched pages first, so --only-changed submits what actually moved.
function sortByRecency(urls, publicDir) {
  const dateOf = (url) => {
    const slug = url.replace(`${BASE}/`, '').replace(BASE, '')
    if (!slug) return '9999'
    try {
      return execFileSync('git', ['log', '-1', '--format=%cI', '--', path.join(publicDir, `${slug}.html`)], {
        encoding: 'utf8', timeout: 10000,
        // git prints to stderr before throwing outside a checkout; the catch
        // handles it, so keep the noise out of the run.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || '0'
    } catch {
      return '0'
    }
  }
  return urls.map((u) => ({ u, d: dateOf(u) })).sort((a, b) => b.d.localeCompare(a.d)).map((x) => x.u)
}

async function pingIndexNow(urls, key, dryRun) {
  const payload = { host: HOST, key, keyLocation: `${BASE}/${key}.txt`, urlList: urls }
  if (dryRun) {
    console.error(`[dry-run] IndexNow would submit ${urls.length} urls`)
    return { ok: true, status: 0, dryRun: true }
  }
  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.text().catch(() => '')
  // 200 accepted, 202 accepted but key still being validated.
  const ok = res.status === 200 || res.status === 202
  console.error(`IndexNow: ${res.status}${ok ? ' accepted' : ` — ${body.slice(0, 200)}`} (${urls.length} urls)`)
  if (res.status === 403) {
    console.error(`  403 means ${BASE}/${key}.txt is not reachable yet — deploy the key file, then re-run.`)
  }
  return { ok, status: res.status, body: body.slice(0, 500) }
}

function gcloudToken() {
  const home = os.homedir()
  const env = { ...process.env, PATH: `${home}/google-cloud-sdk/bin:${process.env.PATH ?? ''}` }
  try {
    return execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8', env, timeout: 15000,
    }).trim()
  } catch {
    return ''
  }
}

// Search Console refuses user ADC without a quota project — same requirement
// gsc-fetch.mjs satisfies with this header. Re-running `application-default
// login` CLEARS quota_project_id, so a fresh consent silently breaks every GSC
// call until `gcloud auth application-default set-quota-project <id>` runs.
function quotaProject() {
  try {
    const adc = JSON.parse(readFileSync(path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'), 'utf8'))
    return adc.quota_project_id || ''
  } catch {
    return ''
  }
}

async function resubmitSitemap(dryRun) {
  const token = gcloudToken()
  if (!token) {
    console.error('GSC sitemap resubmit: skipped (no gcloud ADC token)')
    return { ok: false, skipped: true }
  }
  const results = []
  for (const feed of FEEDS) results.push(await putSitemap(token, feed, dryRun))
  return { ok: results.every((r) => r.ok), feeds: results }
}

async function putSitemap(token, feed, dryRun) {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE_URL)}/sitemaps/${encodeURIComponent(feed)}`
  if (dryRun) {
    console.error(`[dry-run] GSC would PUT ${feed}`)
    return { ok: true, feed, dryRun: true }
  }
  const headers = { Authorization: `Bearer ${token}` }
  const quota = quotaProject()
  if (quota) headers['x-goog-user-project'] = quota
  const res = await fetch(url, { method: 'PUT', headers, signal: AbortSignal.timeout(30000) })
  if (res.ok) {
    console.error(`GSC sitemap resubmit: ${res.status} ok (${feed})`)
    return { ok: true, feed, status: res.status }
  }
  const body = await res.text().catch(() => '')
  console.error(`GSC sitemap resubmit: ${res.status} — ${body.slice(0, 200)}`)
  // Two different 403s live here and they need opposite fixes, so name the one
  // that actually happened instead of always blaming the scope.
  if (res.status === 403 && /quota project/i.test(body)) {
    console.error('  ADC has no quota project (a fresh `application-default login` clears it):')
    console.error(`  gcloud auth application-default set-quota-project ${QUOTA_PROJECT || '<your-gcp-project>'}`)
  } else if (res.status === 403 || res.status === 401) {
    console.error('  the ADC token is probably webmasters.readonly; resubmitting needs the write scope:')
    console.error('  gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters')
  }
  return { ok: false, feed, status: res.status, body: body.slice(0, 500) }
}

async function main() {
  const opts = parseArgs()
  requireSite('ping-index')
  let urls = readSitemapUrls(opts.sitemap)
  if (opts.onlyChanged > 0) urls = sortByRecency(urls, opts.publicDir).slice(0, opts.onlyChanged)
  const dynamic = opts.skipDynamic ? [] : await fetchDynamicUrls()
  if (dynamic.length) console.error(`+${dynamic.length} url(s) from server-rendered feeds`)
  urls = [...new Set([...urls, ...dynamic])]
  const key = loadOrCreateKey(opts.publicDir)
  const indexnow = await pingIndexNow(urls, key, opts.dryRun)
  const gsc = await resubmitSitemap(opts.dryRun)
  const out = { pingedAt: new Date().toISOString(), urls: urls.length, dynamic: dynamic.length, indexnow, gsc }
  mkdirSync('out', { recursive: true })
  writeFileSync('out/ping.json', JSON.stringify(out, null, 2))
  // A failed ping is not a failed pipeline — it is a notification, and the
  // report carries the outcome either way.
  console.error('ping summary -> out/ping.json')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
