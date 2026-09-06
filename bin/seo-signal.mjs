#!/usr/bin/env node
// Single entry point, so the whole thing is `npx seo-signal <command>` instead
// of a clone and a path to remember. Every command is one of the scripts in
// ../scripts, run as a child process with the arguments passed straight
// through — the scripts stay independently runnable and keep their own --help.

import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const COMMANDS = {
  keywords: {
    script: 'keyword-mine.mjs',
    blurb: 'find queries with demand and no page behind them (add --deep for the long tail)',
  },
  staleness: {
    script: 'staleness.mjs',
    blurb: 'score pages by how likely they are to be out of date',
  },
  sitemap: {
    script: 'sitemap-sync.mjs',
    blurb: 'derive sitemap.xml from your pages (--check exits 1 on drift, --write fixes it)',
  },
  ping: {
    script: 'ping-index.mjs',
    blurb: 'submit to IndexNow and resubmit your sitemap to Search Console',
  },
  crawl: {
    script: 'crawl.mjs',
    blurb: 'technical crawl of every sitemap URL',
  },
  psi: {
    script: 'psi.mjs',
    blurb: 'PageSpeed Insights / Core Web Vitals per page',
  },
  gsc: {
    script: 'gsc-fetch.mjs',
    blurb: 'pull Search Console performance data to CSV',
  },
}

const CONFIG_FILE = 'seo-signal.config.json'

// Where static site generators put built HTML, roughly in order of how likely
// a hit is to be the real thing.
const LIKELY_CONTENT_DIRS = ['public', 'dist', 'build', '_site', 'out', 'site', 'docs', 'www']

function countHtml(dir) {
  try {
    if (!statSync(dir).isDirectory()) return 0
    return readdirSync(dir).filter((f) => f.endsWith('.html')).length
  } catch {
    return 0
  }
}

// Guessing beats defaulting to "public" and then failing on the very next
// command the init message tells you to run.
function detectContentDir() {
  const found = LIKELY_CONTENT_DIRS
    .map((d) => ({ dir: d, count: countHtml(d) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
  if (found.length) return found[0]
  // A site whose pages sit at the repo root is unusual but real.
  const rootCount = countHtml('.')
  return rootCount > 0 ? { dir: '.', count: rootCount } : null
}

// A git remote is the best guess available for the site, and gets the user one
// field closer to a working config.
function detectSite() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const repo = url.replace(/\.git$/, '').split(/[:/]/).pop()
    const owner = url.replace(/\.git$/, '').split(/[:/]/).slice(-2)[0]
    if (owner && repo) return `https://${owner}.github.io/${repo}`
  } catch { /* not a repo, or no origin */ }
  return ''
}

function starterConfig({ contentDir, site }) {
  return {
    site: site || 'https://example.com',
    gscProperty: site ? `sc-domain:${new URL(site).hostname}` : 'sc-domain:example.com',
    gcpQuotaProject: '',
    contentDir: contentDir || 'public',
    brandTerms: [],
    topicTokens: [],
    extraFeeds: [],
    excludeFromSitemap: [],
  }
}

function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  console.error('seo-signal — zero-dependency SEO scripts for sites whose pages live in a git repo\n')
  console.error('usage: npx seo-signal <command> [options]\n')
  console.error('commands:')
  for (const [name, { blurb }] of Object.entries(COMMANDS)) {
    console.error(`  ${name.padEnd(width)}  ${blurb}`)
  }
  console.error(`  ${'init'.padEnd(width)}  write a starter ${CONFIG_FILE} in the current directory`)
  console.error(`\nEvery command takes --help. Configuration lives in ${CONFIG_FILE};`)
  console.error('each value can also be set with an SEO_SIGNAL_* environment variable.')
  console.error('\ndocs: https://github.com/mkemaldurmus/seo-signal')
}

function init() {
  const target = path.resolve(CONFIG_FILE)
  if (existsSync(target)) {
    console.error(`${CONFIG_FILE} already exists — leaving it alone.`)
    console.error(`current site: ${JSON.parse(readFileSync(target, 'utf8')).site || '(unset)'}`)
    process.exit(1)
  }

  const detected = detectContentDir()
  const site = detectSite()
  writeFileSync(target, `${JSON.stringify(starterConfig({ contentDir: detected?.dir, site }), null, 2)}\n`)
  console.error(`wrote ${CONFIG_FILE}`)

  if (detected) {
    console.error(`  contentDir: ${detected.dir}/  (${detected.count} html file${detected.count === 1 ? '' : 's'} found)`)
    if (site) console.error(`  site:       ${site}  — a guess from your git remote, change it if wrong`)
    console.error('\nTry this now, it needs no credentials:')
    console.error('  npx seo-signal staleness')
    if (!site) console.error('\nSet "site" before anything that talks to a search engine.')
  } else {
    // Say so plainly rather than writing a config whose next command fails.
    console.error(`\nNo HTML found in ${LIKELY_CONTENT_DIRS.slice(0, 4).join('/, ')}/ or here,`)
    console.error('so "contentDir" is a placeholder. Point it at your built pages:')
    console.error(`  ${CONFIG_FILE} -> "contentDir": "<your build output>"`)
    console.error('\nIf you are just trying this out, build your site first — these')
    console.error('commands read the HTML you actually ship, not your source files.')
  }
}

const [command, ...rest] = process.argv.slice(2)

if (!command || command === '--help' || command === '-h' || command === 'help') {
  usage()
  process.exit(command ? 0 : 1)
}

if (command === '--version' || command === '-v') {
  console.log(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
  process.exit(0)
}

if (command === 'init') {
  init()
  process.exit(0)
}

const entry = COMMANDS[command]
if (!entry) {
  console.error(`unknown command: ${command}\n`)
  usage()
  process.exit(1)
}

// stdio inherit so each script's own progress output and exit code pass
// through untouched — the wrapper should be invisible.
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', entry.script), ...rest], {
  stdio: 'inherit',
  env: { ...process.env, SEO_SIGNAL_INVOKED_AS: `seo-signal ${command}` },
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
