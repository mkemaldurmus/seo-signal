// End-to-end tests: each script is run as a real subprocess and asserted on its
// output. These are CLIs, so testing them through their actual interface is
// both simpler than exporting internals and closer to what breaks in practice.
//
// No network is touched. Anything that talks to Google is covered only for its
// argument handling and failure messages.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE_SITE = path.join(ROOT, 'fixtures', 'site')

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-signal-'))
  cpSync(FIXTURE_SITE, path.join(dir, 'site'), { recursive: true })
  return dir
}

function run(script, args = [], { env = {}, cwd = ROOT } = {}) {
  return execFileSync('node', [path.join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, SEO_SIGNAL_CONFIG: 'no-such-config.json', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runExpectingFailure(script, args = [], { env = {}, cwd = ROOT } = {}) {
  try {
    run(script, args, { env, cwd })
    assert.fail(`${script} was expected to exit non-zero`)
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    return { status: err.status, stderr: String(err.stderr || '') }
  }
}

const baseEnv = (dir) => ({
  SEO_SIGNAL_SITE: 'https://example.com',
  SEO_SIGNAL_CONTENT_DIR: path.join(dir, 'site'),
})

test('staleness ranks a rotting page above a current one', () => {
  const dir = sandbox()
  try {
    const out = path.join(dir, 'staleness.json')
    run('staleness.mjs', ['--out', out], { env: baseEnv(dir) })
    const report = JSON.parse(readFileSync(out, 'utf8'))
    const byFile = Object.fromEntries(report.pages.map((p) => [p.file, p]))

    assert.ok(byFile['rotting-page.html'].score > byFile['fresh-page.html'].score)
    assert.ok(byFile['rotting-page.html'].absoluteClaims > 0)
    assert.equal(byFile['fresh-page.html'].absoluteClaims, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('staleness counts a past year in the title but not in body copy', () => {
  const dir = sandbox()
  try {
    const out = path.join(dir, 'staleness.json')
    run('staleness.mjs', ['--out', out], { env: baseEnv(dir) })
    const rotting = JSON.parse(readFileSync(out, 'utf8')).pages
      .find((p) => p.file === 'rotting-page.html')

    // The title says 2019; the body mentions 2018 as legitimate history.
    assert.deepEqual(rotting.staleYears, [2019])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sitemap-sync writes every page, then reports itself in sync', () => {
  const dir = sandbox()
  try {
    const env = baseEnv(dir)
    run('sitemap-sync.mjs', ['--write'], { env })
    const xml = readFileSync(path.join(dir, 'site', 'sitemap.xml'), 'utf8')

    assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/)
    assert.match(xml, /<loc>https:\/\/example\.com\/fresh-page<\/loc>/)
    assert.match(xml, /<loc>https:\/\/example\.com\/rotting-page<\/loc>/)
    assert.equal((xml.match(/<loc>/g) || []).length, 3)

    // A second pass must be a no-op, or --check can never be trusted in CI.
    const again = run('sitemap-sync.mjs', ['--check'], { env })
    assert.match(again + '', /(?:)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sitemap-sync --check fails on drift', () => {
  const dir = sandbox()
  try {
    const { status, stderr } = runExpectingFailure('sitemap-sync.mjs', ['--check'], { env: baseEnv(dir) })
    assert.equal(status, 1)
    assert.match(stderr, /OUT OF SYNC/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unconfigured site fails with a sentence, not a stack trace', () => {
  const { status, stderr } = runExpectingFailure('sitemap-sync.mjs', ['--check'])
  assert.equal(status, 1)
  assert.match(stderr, /no site configured/)
  assert.doesNotMatch(stderr, /at \w+ \(/) // no stack frames
})

test('a missing content directory names the setting that is wrong', () => {
  const { status, stderr } = runExpectingFailure('staleness.mjs', [], {
    env: { SEO_SIGNAL_SITE: 'https://example.com', SEO_SIGNAL_CONTENT_DIR: '/definitely/not/here' },
  })
  assert.equal(status, 1)
  assert.match(stderr, /contentDir/)
  assert.match(stderr, /SEO_SIGNAL_CONTENT_DIR/)
})

test('every script prints usage and exits non-zero for --help', () => {
  for (const s of ['crawl.mjs', 'keyword-mine.mjs', 'ping-index.mjs', 'psi.mjs', 'sitemap-sync.mjs', 'staleness.mjs']) {
    const { status, stderr } = runExpectingFailure(s, ['--help'], {
      env: { SEO_SIGNAL_SITE: 'https://example.com' },
    })
    assert.equal(status, 1, `${s} exit status`)
    assert.match(stderr, /usage:/, `${s} usage text`)
  }
})

test('an unknown argument is rejected rather than ignored', () => {
  const { stderr } = runExpectingFailure('staleness.mjs', ['--nope'], {
    env: { SEO_SIGNAL_SITE: 'https://example.com' },
  })
  assert.match(stderr, /unknown argument/)
})

test('an empty staleness result says why, instead of just "0 pages"', () => {
  const dir = sandbox()
  try {
    // A first run that prints "0 pages scored" and exits 0 tells the user
    // nothing and reads as a broken tool. Found by running the published
    // package against a stub page.
    const { stderr } = runCapturingStderr('staleness.mjs', ['--min-bytes', '100000'], { env: baseEnv(dir) })
    assert.match(stderr, /0 pages scored/)
    assert.match(stderr, /under 100000 bytes/)
    assert.match(stderr, /--min-bytes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a genuinely empty content directory is named as such', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-signal-empty-'))
  try {
    const { stderr } = runCapturingStderr('staleness.mjs', [], {
      env: { SEO_SIGNAL_SITE: 'https://example.com', SEO_SIGNAL_CONTENT_DIR: dir },
    })
    assert.match(stderr, /is empty/)
    assert.match(stderr, /contentDir/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// staleness exits 0 even when it has nothing to report, and execFileSync
// returns only stdout on success — these diagnostics go to stderr, so use
// spawnSync, which hands back both regardless of exit code.
function runCapturingStderr(script, args = [], opts = {}) {
  const res = spawnSync('node', [path.join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    env: { ...process.env, SEO_SIGNAL_CONFIG: 'no-such-config.json', ...(opts.env || {}) },
  })
  return { stderr: res.stderr || '', status: res.status }
}

// --- the bin wrapper -------------------------------------------------------

function runBin(args = [], { env = {}, cwd = ROOT } = {}) {
  return execFileSync('node', [path.join(ROOT, 'bin', 'seo-signal.mjs'), ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, SEO_SIGNAL_CONFIG: 'no-such-config.json', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('the bin lists every command it can dispatch', () => {
  let out = ''
  try {
    runBin()
  } catch (err) {
    out = String(err.stderr || '')
  }
  for (const c of ['keywords', 'staleness', 'sitemap', 'ping', 'crawl', 'psi', 'gsc', 'init']) {
    assert.match(out, new RegExp(`\\b${c}\\b`), `${c} missing from usage`)
  }
})

test('help text names the command as the user typed it', () => {
  // Running `seo-signal staleness --help` must not answer with a path into
  // scripts/ — that is the wrapper leaking.
  try {
    runBin(['staleness', '--help'], { env: { SEO_SIGNAL_SITE: 'https://example.com' } })
    assert.fail('expected --help to exit non-zero')
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    assert.match(String(err.stderr), /usage: seo-signal staleness/)
  }
})

test('init writes a config once and refuses to clobber it', () => {
  const dir = sandbox()
  try {
    const first = (() => {
      try { return runBin(['init'], { cwd: dir }) } catch (err) { return String(err.stderr) }
    })()
    assert.match(first + '', /(?:)/)
    const written = JSON.parse(readFileSync(path.join(dir, 'seo-signal.config.json'), 'utf8'))
    assert.ok('site' in written && 'contentDir' in written)

    try {
      runBin(['init'], { cwd: dir })
      assert.fail('second init should exit non-zero')
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err
      assert.match(String(err.stderr), /already exists/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init detects a content directory that actually has pages', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-signal-init-'))
  try {
    cpSync(FIXTURE_SITE, path.join(dir, 'dist'), { recursive: true })
    const res = spawnSync('node', [path.join(ROOT, 'bin', 'seo-signal.mjs'), 'init'], {
      encoding: 'utf8', cwd: dir, env: { ...process.env },
    })
    assert.match(res.stderr, /contentDir: dist\//)
    const cfg = JSON.parse(readFileSync(path.join(dir, 'seo-signal.config.json'), 'utf8'))
    assert.equal(cfg.contentDir, 'dist')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init does not promise a command that will fail when there is no HTML', () => {
  // The published one-liner `seo-signal init && seo-signal staleness` errored
  // in an empty directory because init wrote contentDir "public" regardless
  // and then told you to run staleness. It must say what is wrong instead.
  const dir = mkdtempSync(path.join(tmpdir(), 'seo-signal-bare-'))
  try {
    const res = spawnSync('node', [path.join(ROOT, 'bin', 'seo-signal.mjs'), 'init'], {
      encoding: 'utf8', cwd: dir, env: { ...process.env },
    })
    assert.match(res.stderr, /No HTML found/)
    assert.match(res.stderr, /placeholder/)
    assert.doesNotMatch(res.stderr, /Try this now/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown command exits non-zero and shows usage', () => {
  try {
    runBin(['nope'])
    assert.fail('expected non-zero exit')
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err
    assert.equal(err.status, 1)
    assert.match(String(err.stderr), /unknown command: nope/)
  }
})
