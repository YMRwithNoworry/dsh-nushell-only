/**
 * Every failure class captured from a real dsh session must produce a hint.
 *
 * `test/fixtures/nu-errors/` holds the raw stderr of a real Nushell 0.115 run of
 * one reproducer per failure class (regenerate with
 * `node dev/capture-nu-errors.mjs`). The plugin exists to turn those failures
 * into one actionable line, so this suite is the coverage contract: a captured
 * class with no hint is a session where the model has to decode a raw Nushell
 * error by itself, which is exactly what the plugin was written to stop.
 *
 * Session evidence for the classes below (`.verify/nu-error-report.md`, 1503
 * failing calls): `nu::shell::external_command` 423, `nu::parser::unknown_flag`
 * 140, `nu::parser::variable_not_found` 137, `nu::shell::io::not_found` 128,
 * `nu::parser::shell_outerr` 85, `nu::parser::error` 70, `nu::shell::column_not_found`
 * 53, `nu::shell::error` 44, `nu::shell::incompatible_path_access` 34,
 * `nu::parser::deprecated` 29, `nu::shell::name_not_found` 17, and the long tail.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dialectHint, DIALECT_HINT_IDS } from '../lib/dialect.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nu-errors')

/** id → the command that produced that stderr. */
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))

test('every captured Nushell failure produces a hint', () => {
  const unhinted = []
  for (const [id, command] of Object.entries(manifest)) {
    const stderr = readFileSync(join(FIXTURES, `${id}.txt`), 'utf8')
    const hint = dialectHint(command, stderr)
    if (hint === undefined) {
      unhinted.push(`${id} (${/nu::[a-z_:]+/.exec(stderr)?.[0] ?? 'no code'}) :: ${command}`)
      continue
    }
    assert.match(hint, /^Nushell hint \([a-z-]+\): /, `${id} produced a malformed hint`)
    const hintId = /^Nushell hint \(([a-z-]+)\)/.exec(hint)[1]
    assert.ok(DIALECT_HINT_IDS.includes(hintId), `${id} produced an undocumented hint id ${hintId}`)
  }
  assert.deepEqual(unhinted, [], `captured failures with no hint:\n${unhinted.join('\n')}`)
})

test('the fixture set and its manifest stay in step', () => {
  const files = readdirSync(FIXTURES).filter((name) => name.endsWith('.txt')).map((name) => name.slice(0, -4)).sort()
  assert.deepEqual(files, Object.keys(manifest).sort(), 'a fixture without a reproducer, or the reverse')
  assert.ok(files.length >= 25, `only ${files.length} failure classes are pinned down`)
})

test('a hint never claims the preflight refused a command it did not refuse', () => {
  // `dialectHint` appends "(the preflight check also refuses this command…)"
  // only when the two layers agree; a class the preflight deliberately leaves
  // alone (a missing path, an absent column) must not claim otherwise.
  const stderr = readFileSync(join(FIXTURES, 'path-not-found.txt'), 'utf8')
  const hint = dialectHint("ls 'D:/definitely-missing-dir'", stderr)
  assert.match(hint, /^Nushell hint \(path-not-found\)/)
  assert.doesNotMatch(hint, /preflight check also refuses/)
})
