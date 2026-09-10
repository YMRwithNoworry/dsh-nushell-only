/**
 * Unit tests for the "only Nushell" guard: what it refuses, what it must leave
 * alone, and how it reports a refusal.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNushellOnly,
  compileForeignShellAllowlist,
  findForeignShellHandoff,
  programName,
  splitStatements,
  tokenize,
} from '../lib/guard.js'

const REFUSED = [
  ['bash -c "echo hi"', 'bash'],
  ['bash script.sh', 'bash'],
  ['/usr/bin/bash -lc "ls"', 'bash'],
  ['"C:\\Program Files\\Git\\bin\\bash.exe" -lc "ls"', 'bash'],
  ['^bash -c "echo hi"', 'bash'],
  ['&bash -c "echo hi"', 'bash'],
  ['sh -c "echo hi"', 'sh'],
  ['zsh -i', 'zsh'],
  ['fish -c "echo hi"', 'fish'],
  ['cmd /c dir', 'cmd'],
  ['cmd.exe /c dir', 'cmd'],
  ['pwsh -Command "Get-ChildItem"', 'pwsh'],
  ['powershell.exe -NoProfile -Command "ls"', 'powershell'],
  ['wsl ls -la', 'wsl'],
  ['sudo bash -c "id"', 'bash'],
  ['doas sh -c id', 'sh'],
  ['env FOO=1 bash -c "echo $FOO"', 'bash'],
  ['busybox sh -c "ls"', 'sh'],
  ['xargs bash -c echo', 'bash'],
  ['FOO=bar bash -c "echo $FOO"', 'bash'],
  ['echo hello | bash', 'bash'],
  ['ls; bash -c pwd', 'bash'],
  ['true && bash -c pwd', 'bash'],
  ['echo one || pwsh -c "ls"', 'pwsh'],
  ['printf x\nbash -c "echo hi"', 'bash'],
]

const ALLOWED = [
  'nu -c "echo hi"',
  'nu --no-config-file -c "ls"',
  'git status',
  'git commit -m "use bash"',
  'ls | where type == file',
  'ls | where name == "bash.txt"',
  'echo "bash -c echo hi"',
  'print "run bash -c later"',
  '# bash -c "echo hi"',
  'open bash.txt',
  'python -c "print(1)"',
  'node -e "console.log(1)"',
  'bashful --version',
  'mybash -c x',
  'npm run build',
  'echo done',
  '^git --version',
  'ls | each { |f| $f.name }',
  'docker run --rm bash:latest echo hi',
]

test('refuses foreign-shell handoffs', () => {
  for (const [command, shell] of REFUSED) {
    const handoff = findForeignShellHandoff(command)
    assert.notEqual(handoff, undefined, `expected a handoff for ${JSON.stringify(command)}`)
    assert.equal(handoff.shell, shell, `wrong shell for ${JSON.stringify(command)}`)
  }
})

test('leaves ordinary Nushell, other programs, and quoted text alone', () => {
  for (const command of ALLOWED) {
    assert.equal(findForeignShellHandoff(command), undefined, `unexpected handoff for ${JSON.stringify(command)}`)
  }
})

test('assertNushellOnly throws a message that names the rule and the shell', () => {
  assert.throws(() => assertNushellOnly('bash -c ls'), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Nushell-only/)
    assert.match(error.message, /bash/)
    assert.match(error.message, /nu --no-config-file -c/)
    return true
  })
  assert.doesNotThrow(() => assertNushellOnly('ls | where type == file'))
})

test('an allowlist exempts exact commands and nothing else', () => {
  const allow = compileForeignShellAllowlist(['^bash -c "legacy hook"$'])
  assert.doesNotThrow(() => assertNushellOnly('bash -c "legacy hook"', { allow }))
  assert.throws(() => assertNushellOnly('bash -c "other"', { allow }))
})

test('allowlist validation fails loud', () => {
  assert.throws(() => compileForeignShellAllowlist('not-an-array'), /must be an array/)
  assert.throws(() => compileForeignShellAllowlist([42]), /must be strings/)
  assert.throws(() => compileForeignShellAllowlist(['(']), /valid regular expression/)
})

test('program names normalize paths, sigils, and Windows extensions', () => {
  assert.equal(programName('^bash'), 'bash')
  assert.equal(programName('/bin/sh'), 'sh')
  assert.equal(programName('C:\\Windows\\System32\\cmd.exe'), 'cmd')
  assert.equal(programName('"pwsh.exe"'), 'pwsh')
  assert.equal(programName('git'), 'git')
})

test('statement splitting honors quotes and comments', () => {
  assert.deepEqual(splitStatements('a; b'), ['a', ' b'])
  assert.deepEqual(splitStatements('a | b'), ['a ', ' b'])
  assert.deepEqual(splitStatements('echo "a;b"'), ['echo "a;b"'])
  assert.deepEqual(splitStatements("echo 'a|b'"), ["echo 'a|b'"])
  assert.deepEqual(splitStatements('a # b; c\nd'), ['a ', 'd'])
})

test('tokenizing keeps quoted runs together and drops the quotes', () => {
  assert.deepEqual(tokenize('bash -c "echo hi"'), ['bash', '-c', 'echo hi'])
  assert.deepEqual(tokenize("open 'a b.txt'"), ['open', 'a b.txt'])
  assert.deepEqual(tokenize('  ls   |  where  '), ['ls', '|', 'where'])
})
