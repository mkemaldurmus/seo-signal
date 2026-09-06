#!/usr/bin/env node
// GSC CLI fetch — pulls Google Search Console Search Analytics data as CSV.
// Zero dependencies (node:crypto + fetch).
//
// Two auth modes:
//
// A) gcloud user account (simplest — no GCP console, no key files):
//    Install gcloud, then run ONCE:
//      gcloud auth application-default login \
//        --scopes=https://www.googleapis.com/auth/webmasters.readonly
//    (opens a browser consent screen; your Google account must be a user on
//    the GSC property — it already is if you can see it in Search Console.)
//    Then fetch with --token-source gcloud (no --key needed):
//      node scripts/gsc-fetch.mjs --site-url sc-domain:example.com \
//        --start-date 2026-05-22 --end-date 2026-08-22 \
//        --dimensions query page --token-source gcloud --out /tmp/gsc-query-page.csv
//    Note: plain `gcloud auth login` does NOT include the webmasters scope,
//    which is why the application-default login above is required.
//
// B) Service account (fully automated, no browser):
//   1. console.cloud.google.com -> project -> APIs & Services -> enable
//      "Search Console API" (aka webmasters).
//   2. IAM & Admin -> Service Accounts -> Create -> assign no role ->
//      Keys -> Add Key -> JSON -> download (this is --key).
//   3. Google Search Console -> your property -> Settings ->
//      Users and permissions -> Add user -> paste the service account
//      email -> Full. (Property access is delegated to the SA email;
//      without this the API returns 403.)
//   4. Store the key OUTSIDE the repo, e.g. ~/.seo-signal/gsc-key.json
//      (never commit it).
//
// Then feed the CSV to whatever analysis you like:
//   node scripts/keyword-mine.mjs --out out/keywords.json

import { createSign } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { QUOTA_PROJECT, invokedAs } from './config.mjs'

const METRIC_FIELDS = ['clicks', 'impressions', 'ctr', 'position']
const SUPPORTED_DIMENSIONS = ['query', 'page', 'date', 'country', 'device', 'searchAppearance']
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const API_BASE = 'https://www.googleapis.com/webmasters/v3'

function parseArgs() {
  const args = process.argv.slice(2)
  const opts = { dimensions: ['query', 'page'], type: 'web', rowLimit: 25000, maxRows: 100000, tokenSource: 'sa' }
  const keyMap = {
    '--site-url': 'siteUrl', '--start-date': 'startDate', '--end-date': 'endDate',
    '--key': 'keyPath', '--out': 'out', '--type': 'type', '--row-limit': 'rowLimit',
    '--max-rows': 'maxRows', '--filter': 'filter', '--token-source': 'tokenSource',
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dimensions') {
      const dims = []
      i++
      while (i < args.length && !args[i].startsWith('--')) dims.push(args[i++])
      opts.dimensions = dims
      i--
    } else if (keyMap[arg]) {
      opts[keyMap[arg]] = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      usage()
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  for (const required of ['siteUrl', 'startDate', 'endDate', 'out']) {
    if (!opts[required]) throw new Error(`missing required argument: --${required}`)
  }
  if (opts.tokenSource === 'sa' && !opts.keyPath) {
    throw new Error('--key is required for --token-source sa (or use --token-source gcloud)')
  }
  if (!['sa', 'gcloud'].includes(opts.tokenSource)) {
    throw new Error(`unknown token source: ${opts.tokenSource} (sa | gcloud)`)
  }
  opts.rowLimit = Number(opts.rowLimit)
  opts.maxRows = Number(opts.maxRows)
  const bad = opts.dimensions.filter((d) => !SUPPORTED_DIMENSIONS.includes(d))
  if (bad.length) throw new Error(`unsupported dimensions: ${bad.join(', ')}`)
  if (opts.rowLimit > 25000) throw new Error('--row-limit cannot exceed 25000')
  return opts
}

function usage() {
  console.error(`usage: ${invokedAs('node scripts/gsc-fetch.mjs')} --site-url <prop> --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --out <csv> [--token-source sa|gcloud] [--key <sa-key.json>] [--dimensions query page]`)
  process.exit(1)
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signJwt(key, scope) {
  const clientEmail = key.client_email
  const privateKey = key.private_key
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const claims = b64url(
    JSON.stringify({ iss: clientEmail, scope, aud: TOKEN_URI, iat: now, exp: now + 3600 })
  )
  const unsigned = `${header}.${claims}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64')
  return `${unsigned}.${b64url(signature)}`
}

async function getTokenSa(keyPath) {
  const key = JSON.parse(readFileSync(path.resolve(keyPath), 'utf8'))
  if (!key.private_key || !key.client_email) {
    throw new Error('key file must be a service account JSON key (private_key + client_email)')
  }
  const assertion = signJwt(key, 'https://www.googleapis.com/auth/webmasters.readonly')
  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(body)}`)
  return body.access_token
}

function getTokenGcloud() {
  const home = os.homedir()
  const env = { ...process.env, PATH: `${home}/google-cloud-sdk/bin:${process.env.PATH ?? ''}` }
  try {
    const token = execFileSync('gcloud', ['auth', 'application-default', 'print-access-token'], {
      encoding: 'utf8', env, timeout: 15000,
    }).trim()
    if (!token) throw new Error('gcloud returned an empty token')
    return token
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error('gcloud not found — install the Google Cloud SDK (https://cloud.google.com/sdk/docs/install)')
    }
    if (err?.status === 1) {
      throw new Error(`gcloud failed: ${err.stderr?.trim() || err.message} — run: gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/webmasters.readonly`)
    }
    throw err
  }
}

// Search Console rejects user ADC with no quota project, and reports it as a
// 403 whose message reads like an auth-scope failure. Worse, `gcloud auth
// application-default login` CLEARS quota_project_id — so re-authing to add a
// scope silently breaks every call here until you run
// `gcloud auth application-default set-quota-project <project>`.
function getQuotaProject() {
  if (QUOTA_PROJECT) return QUOTA_PROJECT
  try {
    const adc = JSON.parse(readFileSync(path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'), 'utf8'))
    return adc.quota_project_id || ''
  } catch {
    return ''
  }
}

async function fetchRows(opts, token) {
  const rows = []
  let startRow = 0
  const url = `${API_BASE}/sites/${encodeURIComponent(opts.siteUrl)}/searchAnalytics/query`
  while (rows.length < opts.maxRows) {
    const payload = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions,
      type: opts.type,
      rowLimit: Math.min(opts.rowLimit, opts.maxRows - rows.length),
      startRow,
      dataState: 'final',
    }
    if (opts.filter) {
      const [dimension, operator, expression] = opts.filter.split(':', 3)
      payload.dimensionFilterGroups = [{ groupType: 'and', filters: [{ dimension, operator, expression }] }]
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    if (opts.tokenSource === 'gcloud') {
      const quotaProject = getQuotaProject()
      if (quotaProject) headers['x-goog-user-project'] = quotaProject
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(`Search Console API failed: ${res.status} ${JSON.stringify(body)}`)
    const apiRows = body.rows || []
    if (!apiRows.length) break
    for (const r of apiRows) {
      const out = {}
      opts.dimensions.forEach((d, i) => { out[d] = r.keys?.[i] ?? '' })
      for (const m of METRIC_FIELDS) out[m] = r[m] ?? 0
      rows.push(out)
    }
    if (apiRows.length < payload.rowLimit) break
    startRow += payload.rowLimit
  }
  return rows
}

function toCsv(rows, fields) {
  const escape = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = fields.map(escape).join(',')
  const lines = rows.map((r) => fields.map((f) => escape(r[f])).join(','))
  return [header, ...lines].join('\n')
}

async function main() {
  const opts = parseArgs()
  const token = opts.tokenSource === 'gcloud'
    ? getTokenGcloud()
    : await getTokenSa(opts.keyPath)
  const rows = await fetchRows(opts, token)
  const outPath = path.resolve(opts.out)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, toCsv(rows, [...opts.dimensions, ...METRIC_FIELDS]), 'utf8')
  console.error(`fetched ${rows.length} rows -> ${outPath}`)
}

main().catch((err) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
