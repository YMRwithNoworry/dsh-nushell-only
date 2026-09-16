/**
 * The dialect layer is only worth shipping if it refuses exactly the habits
 * that fail in a Nu-only deployment and nothing else.
 *
 * The refusal cases and the stderr samples below are copied from real dsh
 * session transcripts (`nu::parser::shell_outerr` for `2>&1`,
 * `nu::shell::external_command` for `grep`, `nu::shell::column_not_found` for
 * `$env.LAST_EXIT_CODE`, and so on), so this suite is a regression test against
 * the observed failure modes rather than against invented ones.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNushellDialect,
  codeView,
  dialectHint,
  DIALECT_HINT_IDS,
  DIALECT_RULE_IDS,
  findDialectIssue,
  findForeignToolName,
} from '../lib/dialect.js'

/** Real failures, with the rule that must catch each one. */
const REFUSALS = [
  ["ls 'D:/code/dsh' 2>&1 | select name type size", 'stderr-redirect'],
  ['node --test test/ 2>&1 | tail -60', 'stderr-redirect'],
  ['ls C:/Users/me/.dsh -a -e 2>$null | table', 'stderr-redirect'],
  ["$env:REF='D:/src'; node ref-search.cjs $env:REF hurt", 'powershell-env'],
  ['$candidates = ["C:/a.exe" "C:/b.exe"]; $candidates | length', 'bare-assignment'],
  ['$p="D:/x/File.java"; open --raw $p | lines | length', 'bare-assignment'],
  ['@("block/A.java","block/B.java") | length', 'array-literal'],
  ['foreach f in (ls lib/*.js | get name) { node --check $f }', 'foreach-keyword'],
  ['cd D:/code; npm run build && node dist/index.js', 'and-or-operators'],
  ['open --raw a.json || print "missing"', 'and-or-operators'],
  ['export PATH=/usr/bin', 'export-assignment'],
  ['node run.cjs; print $?', 'exit-status-sigil'],
  ['ls | where-object { $_.size -gt 1kb }', 'powershell-cmdlet'],
  ['ls | each { $_.name }', 'powershell-current-item'],
  ['if (-not (Test-Path D:/x)) { print "no" }', 'powershell-not-operator'],
  ['ls | select -First 20', 'deprecated-flags'],
  ['ls | get -i name', 'deprecated-flags'],
  ["'ABC' | str downcase", 'deprecated-flags'],
  ['mkdir -p D:/tmp/probe/x', 'mkdir-parents'],
  ['ls -R dsh-nushell-only', 'recursive-ls'],
  ['$(ls D:/code)', 'cmd-substitution'],
  ['Get-ChildItem -Path C:/x -Recurse -Depth 2', 'powershell-cmdlet'],
  ["Get-Content 'C:/Users/me/.npmrc' | Select-String authToken", 'powershell-cmdlet'],
  ['Test-Path C:/Users/me/.dsh', 'powershell-cmdlet'],
  ['Join-Path $root "src/main/java"', 'powershell-cmdlet'],
  ['glob "**/ValueInput*.java" "D:/code/MC"', 'glob-extra-positional'],
  ['glob pattern="**/*.java" path="D:/code"', 'glob-named-arguments'],
  ["ls '~/.dsh/profiles?'", 'path-optional-suffix'],
  ['TOKEN=abc node publish.cjs', 'prefix-assignment'],
]

/** Nushell that must never be refused. */
const ALLOWED = [
  'ls | where type == file | get name',
  'let x = 1; $x + 1',
  'mut count = 0; $count = $count + 1',
  '$env.DSH_DEMO = "1"; $env.DSH_DEMO',
  '$env.DSH_HOME? | describe',
  'do { ^git status --short } | complete | get exit_code',
  "open --raw notes.txt | lines | where { |l| $l =~ 'hello' } | length",
  'glob "D:/code/**/*.rs" | length',
  '[1 2 3] | each { |n| $n * 2 }',
  "if not ('D:/x' | path exists) { print 'no' }",
  "print 'a && b 2>&1 $env:FOO @(x) foreach $(y) not-a-flag'",
  'print "quoted 2>&1 and $env:HOME and @(1)"',
  "open --raw 'file with # hash and ? mark.txt'",
  "ls # 2>&1 in a comment is not a redirect",
  "^Get-ChildItem -Path C:/x",
  "^nu -c 'print \"2>&1\"'",
  "r#'raw 2>&1 $env:X'# | str length",
  'ls | where size > 1kb | sort-by size | reverse | first 5 | select name size',
  "['a' 'b'] | path join",
  'let p = (glob D:/code/*.md | get 0); if ($p | path exists) { open --raw $p | lines | last 3 }',
]

test('refuses the dialect habits observed in real sessions', () => {
  for (const [command, expected] of REFUSALS) {
    const issue = findDialectIssue(command)
    assert.ok(issue !== undefined, `expected a refusal for ${JSON.stringify(command)}`)
    assert.equal(issue.id, expected, `wrong rule for ${JSON.stringify(command)}`)
    assert.throws(() => assertNushellDialect(command), /Nushell-only shell: refusing/)
  }
})

test('never refuses Nushell, data, or quoted syntax', () => {
  for (const command of ALLOWED) {
    const issue = findDialectIssue(command)
    assert.equal(issue, undefined, `false positive on ${JSON.stringify(command)}: ${issue?.id ?? ''}`)
    assert.doesNotThrow(() => assertNushellDialect(command))
  }
})

test('the refusal names the habit, the Nushell spelling, and the escape hatch', () => {
  assert.throws(() => assertNushellDialect('ls | select -First 5'), (error) => {
    assert.match(error.message, /select -First 20`? → `first 20`/)
    assert.match(error.message, /dialectLint: false/)
    assert.match(error.message, /nu --no-config-file -c/)
    return true
  })
})

test('an allowlist entry exempts a whole call site', () => {
  const allow = [/^Get-Content 'legacy\.txt'$/]
  assert.doesNotThrow(() => assertNushellDialect("Get-Content 'legacy.txt'", { allow }))
  assert.throws(() => assertNushellDialect("Get-Content 'other.txt'", { allow }), /Nushell-only/)
})

test('every documented rule id is reachable', () => {
  const reachable = new Set(REFUSALS.map(([, id]) => id))
  for (const id of reachable) assert.ok(DIALECT_RULE_IDS.includes(id), `${id} is not a documented rule`)
  for (const id of DIALECT_RULE_IDS) assert.ok(reachable.has(id), `${id} has no refusal case in this suite`)
})

test('codeView blanks strings, raw strings, and comments without moving offsets', () => {
  const command = "print 'a 2>&1' # b 2>&1\nprint \"c 2>&1\""
  const view = codeView(command)
  assert.equal(view.length, command.length, 'offsets must not move')
  assert.equal(view.includes('2>&1'), false, 'quoted and commented syntax must be invisible')
  const [first, second] = view.split('\n')
  assert.equal(first.startsWith('print'), true)
  assert.equal(first.trim(), 'print', 'a comment runs to the end of its line')
  assert.equal(second.startsWith('print'), true)
  assert.equal(second.trim(), 'print')
  assert.equal(codeView("ls | where size > 1kb"), 'ls | where size > 1kb', 'real code is untouched')
})

/** Real stderr samples, trimmed to the parts the hint chooser looks at. */
const STDERR = {
  outerr: "Error: nu::parser::shell_outerr\n\n  x The '2>&1' shell operation is 'out+err>' in Nushell.\n\n[exit code: 1]",
  external: "Error: nu::shell::external_command\n\n  x External command failed\n   ,-[source:1:1]\n 1 | grep -n x f.txt\n   `----\n  help: `grep` is neither a Nushell built-in or a known external command",
  notFound: "Error: nu::shell::io::not_found\n\n  x Directory not found\n  help: 'D:\\code\\dsh插件\\profiles' does not exist",
  fileNotFound: "Error: nu::shell::io::file_not_found\n\n  x File not found\n  help: 'C:\\Users\\me\\.npmrc' does not exist",
  column: "Error: nu::shell::column_not_found\n\n  x Cannot find column 'LAST_EXIT_CODE'\n  help: If some rows have this column, try using 'LAST_EXIT_CODE?' for",
  variable: 'Error: nu::parser::variable_not_found\n\n  x Variable not found.\n',
  unknownFlag: 'Error: nu::parser::unknown_flag\n\n  x Command `ls` does not have flag `-R`.\n  help: Use `--help` to see available flags',
  deprecated: 'Error: nu::parser::deprecated\n\n  x Use `str lowercase` instead.\n',
  inputType: 'Error: nu::parser::input_type_mismatch\n\n  x Command does not support string input.\n',
  onlySupports: 'Error: nu::shell::only_supports_this_input_type\n\n  x Input type not supported.\n',
  extraPositional: 'Error: nu::parser::extra_positional\n\n  x Extra positional argument.\n  help: Usage: glob {flags} <glob>',
  globPattern: 'Error: nu::shell::error\n\n  x error with glob pattern\n',
  expand: 'Error: nu::shell::error\n\n  x No matches found for Expand("C:/Users/me/.dsh/sessions/**/*.jsonl")\n',
  andand: 'Error: nu::parser::shell_andand\n\n  x The \'&&\' shell operation is \'and\' in Nushell.\n',
  immutable: 'Error: nu::parser::assignment_requires_mutable_variable\n\n  x Variable `count` is immutable.\n',
  evalBlock: 'Error: nu::shell::eval_block_with_input\n\n  x Eval block failed with pipeline input\n',
  parseMismatch: 'Error: nu::parser::parse_mismatch\n\n  x Parse mismatch: expected operator.\n',
}

test('a failed call carries one hint naming the fix', () => {
  const cases = [
    ['ls | select name 2>&1', STDERR.outerr, /o\+e>/],
    ["grep -n 'dsh' file.js", STDERR.external, /`grep` is not available here/],
    ['ls D:/code/dsh/profiles', STDERR.notFound, /path exists/],
    ["open --raw 'C:/Users/me/.npmrc'", STDERR.fileNotFound, /path exists/],
    ['print $env.LAST_EXIT_CODE', STDERR.column, /LAST_EXIT_CODE/],
    ['$x = 1', STDERR.variable, /let x = …/],
    ['ls -R dsh-nushell-only', STDERR.unknownFlag, /ls -a` → `ls --all`/],
    ["'ABC' | str downcase", STDERR.deprecated, /str lowercase/],
    ["'abcdef' | first 3", STDERR.inputType, /str substring 0\.\.200/],
    ["$env | where name =~ 'DSH'", STDERR.onlySupports, /transpose key value/],
    ['glob a b', STDERR.extraPositional, /fold the directory in/],
    ['ls D:/dir/*.md', STDERR.globPattern, /`glob <pattern>`/],
    ['ls C:/x/**/*.jsonl', STDERR.expand, /empty list/],
    ['cd D:/x; make && node .', STDERR.andand, /separate statements with `;`/],
    ['let count = 0; $count = 1', STDERR.immutable, /mut x = …|mut count/],
    ['[1 2] | each { $x = 1 }', STDERR.evalBlock, /name the parameter/],
    ["print 'unbalanced", STDERR.parseMismatch, /single quotes/],
  ]
  for (const [command, stderr, expected] of cases) {
    const hint = dialectHint(command, stderr)
    assert.ok(hint !== undefined, `no hint for ${JSON.stringify(command)}`)
    assert.match(hint, /^Nushell hint \([a-z-]+\): /)
    assert.match(hint, expected, `wrong hint for ${JSON.stringify(command)}`)
  }
})

test('clean output and unknown failures carry no hint', () => {
  assert.equal(dialectHint('ls', 'total 3\nnotes.txt\n'), undefined)
  assert.equal(dialectHint('ls', ''), undefined)
  assert.equal(dialectHint('ls', 'Error: something else entirely\n'), undefined)
  assert.equal(dialectHint('ls', '', { exitCode: 0, stdout: 'notes.txt' }), undefined)
})

test('a silent non-zero exit explains the Nushell abort semantics', () => {
  const hint = dialectHint('^node build.mjs; print done', '', { exitCode: 1, stdout: '' })
  assert.match(hint, /^Nushell hint \(silent-exit\): /)
  assert.match(hint, /aborts the rest of the command/)
  assert.match(hint, /\| complete/)
  assert.match(hint, /do -i \{ … \}/)
  assert.match(hint, /only the last statement/)
})

test('every documented hint id is reachable', () => {
  const ids = new Set(
    Object.values(STDERR).map((stderr) => /^Nushell hint \(([a-z-]+)\)/.exec(dialectHint('ls', stderr) ?? '')?.[1]),
  )
  for (const id of DIALECT_HINT_IDS) assert.ok(ids.has(id), `hint id ${id} has no sample in this suite`)
})

test('findForeignToolName names the exact Nushell replacement', () => {
  assert.deepEqual(findForeignToolName('grep -n x f.txt'), { name: 'grep', replacement: '`lines | where { |l| $l =~ "pattern" }`' })
  assert.equal(findForeignToolName('^grep -n x f.txt'), undefined, 'an explicit external is the escape hatch')
  assert.equal(findForeignToolName('ls | where type == file'), undefined)
})
