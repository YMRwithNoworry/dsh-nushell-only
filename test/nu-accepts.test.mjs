/**
 * Differential test: the preflight against the Nushell actually installed.
 *
 * A lint that refuses a command Nushell would have run is worse than no lint —
 * it costs a turn and teaches the wrong rule. So both corpus claims are checked
 * against a real `nu` rather than against the rule author's memory:
 *
 * - every {@link REFUSALS} command must fail in Nushell (the `stderr-as-word`
 *   family excepted, and asserted separately: those commands *run*, which is
 *   exactly why they are refused);
 * - every {@link ALLOWED} command must be valid Nushell — no `nu::parser::`
 *   error — and must not be refused.
 *
 * Skipped, with a loud message, when `nu` is not on PATH.
 *
 * @module dsh-nushell-only/test/nu-accepts
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { ALLOWED, REFUSALS, SILENT_BUT_WRONG } from './corpus.mjs'
import { findDialectIssue } from '../lib/dialect.js'

/** Run one command through Nushell in a scratch cwd. */
function runNu(command) {
  return new Promise((resolve) => {
    const child = spawn('nu', ['--no-config-file', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'], cwd: tmpdir() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ available: false, code: -1, stdout: '', stderr: String(error) }))
    child.on('close', (code) => resolve({ available: true, code, stdout, stderr }))
  })
}

const probe = await runNu('version | get version')
const skip = probe.available ? false : 'nu is not on PATH: cannot check the preflight against a real Nushell'

test('nu is available for the differential checks', { skip }, () => {
  assert.match(probe.stdout.trim(), /^\d+\.\d+/, `unexpected \`nu --version\` output: ${probe.stdout}${probe.stderr}`)
})

test('every refused habit really is broken Nushell', { skip }, async () => {
  const wrong = []
  for (const [command, rule] of REFUSALS) {
    const result = await runNu(command)
    if (result.code === 0 && !SILENT_BUT_WRONG.has(rule)) {
      wrong.push(`${rule}: Nushell accepted ${JSON.stringify(command)} (exit 0) — the refusal is a false positive`)
    }
  }
  assert.deepEqual(wrong, [], `refusals Nushell does not share:\n${wrong.join('\n')}`)
})

test('the known "runs anyway" family is exactly the one that is documented', { skip }, async () => {
  // These are the refusals where Nushell silently does the wrong thing instead
  // of failing: worth pinning down, because the temptation later is to "fix" the
  // rule by deleting it once someone notices the command exits 0. Each probe is
  // a command whose ONLY problem is the redirect, so exit 0 is meaningful.
  const probes = ['print 1 2>$null', 'print "a" 2>/dev/null', 'print 1 2>nul', 'print 1 &> out.txt', 'print 1 > out.txt', 'print 1 >> build.log']
  const wrong = []
  for (const command of probes) {
    const result = await runNu(command)
    if (result.code !== 0) wrong.push(`${JSON.stringify(command)} no longer runs in Nushell (exit ${result.code})`)
    const rule = findDialectIssue(command)?.id
    if (rule !== 'stderr-as-word' && rule !== 'stdout-redirect') {
      wrong.push(`${JSON.stringify(command)} is no longer refused as a silent redirect (got ${rule ?? 'allowed'})`)
    }
  }
  assert.deepEqual(wrong, [], `the "silently wrong" family changed:\n${wrong.join('\n')}`)
})

test('nothing Nushell accepts is refused', { skip }, async () => {
  const wrong = []
  for (const command of ALLOWED) {
    const issue = findDialectIssue(command)
    if (issue !== undefined) {
      wrong.push(`false positive (${issue.id}) on ${JSON.stringify(command)}`)
      continue
    }
    const result = await runNu(command)
    // A deprecation *warning* is still a working command; a parse *error* is not.
    const parseError = /Error: nu::parser::[a-z_]+/.exec(result.stderr)?.[0]
    if (parseError !== undefined) {
      wrong.push(`${JSON.stringify(command)} is not valid Nushell either (${parseError}) — the corpus entry is wrong`)
    }
  }
  assert.deepEqual(wrong, [], `corpus entries that need fixing:\n${wrong.join('\n')}`)
})
