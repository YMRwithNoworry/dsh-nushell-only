/**
 * Regenerate `test/fixtures/nu-errors/` from the Nushell on this machine.
 *
 * Every hint in `lib/dialect.js` matches a signature it *believes* Nushell
 * prints. A regex written from memory goes stale the moment the error text
 * changes (the previous `No matches found for Expand` is the cautionary tale —
 * real 0.115 output says `No matches found for DoNotExpand("…")`). This script
 * captures the real thing: one reproducer per failure class, its raw stderr, and
 * a manifest that pairs each capture with the command that produced it, so the
 * test suite can assert that every captured failure class still produces a hint.
 *
 * Usage (from the package root): `node dev/capture-nu-errors.mjs`
 *
 * A reproducer that stops reproducing (Nushell fixed the message, the command
 * now succeeds) is reported and its stale fixture is deleted, so the fixture
 * directory never claims coverage it no longer has.
 *
 * @module dsh-nushell-only/dev/capture-nu-errors
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'test', 'fixtures', 'nu-errors')

/** Fixture id → the command that reproduces that failure class. */
const REPRODUCERS = {
  'stderr-redirect': "ls 'D:/definitely-missing' 2>&1 | select name",
  'stderr-err-op': 'print 1 2> out.txt',
  'and-or': 'print 1 && print 2',
  'bare-assignment': '$x = 1',
  'env-var-not-var': 'print $env:TEMP',
  'immutable-assignment': 'let x = 1; $x = 2',
  'assignment-requires-variable': 'let r = { a = 1 }',
  'unknown-flag': 'ls -R src',
  'deprecated-flag': 'str downcase',
  'input-type': "'abc' | first 3",
  'column-not-found': 'ls | get nope',
  'name-not-found': 'ls | select name, type',
  'path-not-found': "ls 'D:/definitely-missing-dir'",
  'glob-pattern': "ls 'D:/definitely-missing/**/*.md'",
  'glob-named-args': 'glob pattern="**/*.rs"',
  'external-command': 'grep -n x file.txt',
  'extra-positional': 'glob "**/*.rs" "D:/code"',
  'parse-mismatch': 'print (1',
  'unclosed-delimiter': "print 'abc",
  'percent-sigil': 'print 1 | %{ $in }',
  'percent-bare': 'print 1 | %',
  'incompatible-path-access': "'abc' | str contains 'a' or 'b'",
  'operator-unsupported-type': 'print (1 + [1 2])',
  'operator-incompatible-types': "print ('a' + 1)",
  'shell-operator-unsupported-type': 'print ($env + 1)',
  'unknown-command': 'let files = @(1, 2)',
  'keyword-missing-arg': 'for f in [1 2]; do print $f',
  'unexpected-redirection': 'print 1 | out+err> | str trim',
  'redirection-nothing': 'print 1 out+err>',
  'needs-positive-value': 'ls | first -3',
  'pipeline-mismatch': 'str trim',
  'cannot-pass-list-to-external': '^git add [a b]',
  'is-a-directory': 'open --raw D:/',
  'eval-block-with-input': 'ls | each { |f| open --raw $f.name }',
  'http-offline': "http get 'https://definitely-not-a-real-host.invalid/x'",
}

/** Run one command through Nushell and capture its streams. */
function runNu(command) {
  return new Promise((resolve) => {
    const child = spawn('nu', ['--no-config-file', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Strip ANSI colour, normalize newlines, and drop the trailing blank lines. */
function clean(text) {
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/g, '')
}

mkdirSync(OUT, { recursive: true })
const manifest = {}
let captured = 0
let stale = 0

for (const [id, command] of Object.entries(REPRODUCERS)) {
  const result = await runNu(command)
  const text = clean(result.stderr)
  const code = /nu::[a-z_:]+/.exec(text)?.[0]
  if (code === undefined) {
    stale++
    rmSync(join(OUT, `${id}.txt`), { force: true })
    console.log(`STALE  ${id}: no nu error any more (exit ${result.code}) :: ${command}`)
    continue
  }
  writeFileSync(join(OUT, `${id}.txt`), `${text}\n`, 'utf8')
  manifest[id] = command
  captured++
  console.log(`ok     ${id.padEnd(30)} ${code} :: ${command}`)
}

// A fixture whose reproducer is gone must not linger: coverage that is not real
// is worse than no coverage.
for (const file of readdirSync(OUT)) {
  if (!file.endsWith('.txt')) continue
  const id = file.slice(0, -4)
  if (manifest[id] === undefined) {
    rmSync(join(OUT, file), { force: true })
    console.log(`REMOVED ${file}: no reproducer`)
  }
}

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`\ncaptured ${captured} fixtures, ${stale} stale, manifest written to ${join(OUT, 'manifest.json')}`)
if (stale > 0) process.exitCode = 1
