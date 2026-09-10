/**
 * The guide is only teaching if it is true. Every ```nu block in
 * {@link buildGuide} is executed against the Nushell installed on this machine
 * in a prepared workspace, so the examples the model is told to use are known
 * to run.
 *
 * The test is skipped (not failed) where `nu` or `git` is unavailable, so it
 * never blocks a machine that cannot run the plugin anyway.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GUIDE_FENCE, buildGuide, buildShellRules, buildToolDescription } from '../lib/guide.js'

/** Every fenced block of the given language, in order. */
function extractBlocks(markdown, fence) {
  const blocks = []
  const pattern = new RegExp('```' + fence + '\\n([\\s\\S]*?)```', 'g')
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1].trimEnd())
  return blocks
}

function has(program, args = ['--version']) {
  const result = spawnSync(program, args, { encoding: 'utf8' })
  return result.error === undefined && result.status === 0
}

const nuAvailable = has('nu')
const gitAvailable = has('git')

/** A workspace with the files the guide's examples open. */
function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-nu-guide-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2))
  writeFileSync(join(dir, 'notes.txt'), 'hello\nworld\n')
  if (gitAvailable) spawnSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

test('the full guide has runnable nu examples and a translation table', () => {
  const guide = buildGuide({ variant: 'full' })
  const blocks = extractBlocks(guide, GUIDE_FENCE)
  assert.ok(blocks.length >= 5, `expected several nu blocks, found ${blocks.length}`)
  assert.match(guide, /bash \/ PowerShell → Nushell/)
  assert.match(guide, /nu --no-config-file -c/)
  assert.match(guide, /\$env\./)
  assert.match(guide, /where \{ \|l\| \$l =~ /)
})

test('the compact guide stays short and runnable', () => {
  const compact = buildGuide({ variant: 'compact' })
  const blocks = extractBlocks(compact, GUIDE_FENCE)
  assert.equal(blocks.length, 1)
  assert.ok(compact.length < 1500, 'the compact guide must stay cheap')
})

test('guide: off produces no guide at all', () => {
  assert.equal(buildGuide({ variant: 'off' }), '')
})

test('every guide example runs on the installed Nushell', { skip: !nuAvailable }, () => {
  const workspace = makeWorkspace()
  try {
    for (const variant of ['full', 'compact']) {
      for (const block of extractBlocks(buildGuide({ variant }), GUIDE_FENCE)) {
        const result = spawnSync('nu', ['--no-config-file', '-c', block], { cwd: workspace, encoding: 'utf8' })
        assert.equal(
          result.status,
          0,
          `guide example failed (${variant}):\n${block}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        )
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('the rules section states the freshness, refusal, and data-model contracts', () => {
  const rules = buildShellRules()
  assert.match(rules, /Nushell only/)
  assert.match(rules, /do NOT persist/)
  assert.match(rules, /workdir/)
  assert.match(rules, /refused/)
  assert.match(rules, /structured values/)
})

test('the rewritten tool description describes Nushell, not bash', () => {
  const plain = buildToolDescription({ background: false, escalation: false })
  assert.match(plain, /nu --no-config-file -c/)
  assert.match(plain, /dialect is Nushell/)
  assert.match(plain, /Background execution is not available/)
  assert.doesNotMatch(plain, /bash -c/)
  assert.doesNotMatch(plain, /pwsh -Command/)

  const rich = buildToolDescription({ background: true, escalation: true })
  assert.match(rich, /run_in_background/)
  assert.match(rich, /sandbox_permissions/)
  assert.match(rich, /justification/)
})
