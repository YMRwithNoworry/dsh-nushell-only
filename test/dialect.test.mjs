/**
 * The dialect layer is only worth shipping if it refuses exactly the habits
 * that fail in a Nu-only deployment and nothing else.
 *
 * Three sources of truth, in this order:
 *
 * 1. Real dsh session transcripts (`nu::parser::shell_outerr` for `2>&1`,
 *    `nu::shell::external_command` for `grep`, `nu::shell::column_not_found` for
 *    `$env.LAST_EXIT_CODE`, and so on).
 * 2. Probes of the installed Nushell (0.115.1): every refusal case below was
 *    run through `nu --no-config-file -c` and does fail — and every case in
 *    {@link ALLOWED} was run and does succeed, which is what makes those
 *    entries false-positive regressions rather than opinions.
 * 3. Captured stderr in `test/fixtures/nu-errors/`, so the hint regexes are
 *    checked against real Nushell output instead of remembered output.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNushellDialect,
  codeView,
  dialectHint,
  dialectMessage,
  DIALECT_HINT_IDS,
  DIALECT_RULE_IDS,
  findDialectIssue,
  findForeignToolName,
} from '../lib/dialect.js'
import { ALLOWED, REFUSALS } from './corpus.mjs'


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

test('the refusal quotes the command and states the real failure mode', () => {
  // The old message claimed every refused habit "fails at parse time". It does
  // not: `2>$null` is lexed as an ordinary word and the command runs anyway.
  assert.throws(() => assertNushellDialect('npm view x 2>$null | from json'), (error) => {
    assert.match(error.message, /Offending fragment: "2>\$null"/)
    assert.match(error.message, /Command: "npm view x 2>\$null \| from json"/)
    assert.match(error.message, /lexed as an ordinary word/)
    assert.match(error.message, /e> nul/)
    assert.doesNotMatch(error.message, /fails at parse time/)
    return true
  })
  assert.throws(() => assertNushellDialect('ls D:/x 2>&1'), (error) => {
    assert.match(error.message, /nu::parser::shell_outerr/)
    return true
  })
  // Without the command the message still stands on the fragment alone.
  const message = dialectMessage(findDialectIssue('mkdir -p a/b'))
  assert.match(message, /Offending fragment: "mkdir -p"/)
  assert.match(message, /mkdir a\/b\/c/)
  assert.doesNotMatch(message, /Command:/)
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
  shellErr: "Error: nu::parser::shell_err\n\n  x The '2>' shell operation is 'err>' in Nushell.\n",
  external: "Error: nu::shell::external_command\n\n  x External command failed\n   ,-[source:1:1]\n 1 | grep -n x f.txt\n   `----\n  help: `grep` is neither a Nushell built-in or a known external command",
  notFound: "Error: nu::shell::io::not_found\n\n  x Directory not found\n  help: 'D:\\code\\dsh插件\\profiles' does not exist",
  fileNotFound: "Error: nu::shell::io::file_not_found\n\n  x File not found\n  help: 'C:\\Users\\me\\.npmrc' does not exist",
  column: "Error: nu::shell::column_not_found\n\n  x Cannot find column 'LAST_EXIT_CODE'\n  help: If some rows have this column, try using 'LAST_EXIT_CODE?' for",
  nameNotFound: "Error: nu::shell::name_not_found\n\n  x Name not found\n   ,-[source:1:13]\n 1 | ls | select name, type\n   :             ^^|^^\n   :               `-- did you mean 'name'?",
  variable: 'Error: nu::parser::variable_not_found\n\n  x Variable not found.\n',
  envVarNotVar: 'Error: nu::parser::env_var_not_var\n\n  x Use $env.PATH instead of $PATH.\n   :         `-- use $env.PATH instead of $PATH',
  conditionNotBoolean: "Error: nu::shell::cant_convert\n\n  x Can't convert to boolean.\n   ,-[source:1:4]\n 1 | if [ -f probe1.txt ] { print 'yes' }",
  unknownFlag: 'Error: nu::parser::unknown_flag\n\n  x Command `ls` does not have flag `-R`.\n  help: Use `--help` to see available flags',
  deprecated: 'Error: nu::parser::deprecated\n\n  x Use `str lowercase` instead.\n',
  inputType: 'Error: nu::parser::input_type_mismatch\n\n  x Command does not support string input.\n',
  onlySupports: 'Error: nu::shell::only_supports_this_input_type\n\n  x Input type not supported.\n',
  extraPositional: 'Error: nu::parser::extra_positional\n\n  x Extra positional argument.\n  help: Usage: glob {flags} <glob>',
  pipelineEmpty: 'Error: nu::shell::pipeline_mismatch\n\n  x Pipeline empty.\n   ,-[source:1:1]\n 1 | str trim\n   : ^^^^|^^^\n   :     `-- no input value was piped in',
  globPattern: 'Error: nu::shell::error\n\n  x error with glob pattern\n',
  expand: 'Error: nu::shell::error\n\n  x No matches found for Expand("C:/Users/me/.dsh/sessions/**/*.jsonl")\n',
  doNotExpand: 'Error: nu::shell::error\n\n  x No matches found for DoNotExpand("D:/definitely-missing/**/*.md")\n   :                   `-- Pattern, file or folder not found',
  andand: 'Error: nu::parser::shell_andand\n\n  x The \'&&\' shell operation is \'and\' in Nushell.\n',
  immutable: 'Error: nu::parser::assignment_requires_mutable_variable\n\n  x Variable `count` is immutable.\n',
  evalBlock: 'Error: nu::shell::eval_block_with_input\n\n  x Eval block failed with pipeline input\n',
  parseMismatch: 'Error: nu::parser::parse_mismatch\n\n  x Parse mismatch: expected operator.\n',
  redirectionTarget: 'Error: nu::parser::parse_mismatch\n\n  x Parse mismatch: expected redirection target.\n   ,-[source:1:9]\n 1 | print 1 out+err>\n   :             `-- expected redirection target',
  unexpectedRedirection: 'Error: nu::parser::unexpected_redirection\n\n  x Unexpected redirection.\n   ,-[source:1:11]\n   :               `-- redirecting nothing',
  percentSigil: 'Error: nu::parser::error\n\n  x percent sigil requires a built-in command\n   :               `-- unknown built-in command\n  help: remove `%` to use normal resolution, or use `^` to run an external',
  incompatiblePathAccess: "Error: nu::shell::incompatible_path_access\n\n  x Data cannot be accessed with a cell path\n   ,-[source:1:26]\n 1 | 'abc' | str contains 'a' or 'b'",
  operatorUnsupported: "Error: nu::parser::operator_unsupported_type\n\n  x The '+' operator does not work on values of type 'list<int>'.\n",
  operatorIncompatible: "Error: nu::parser::operator_incompatible_types\n\n  x Types 'string' and 'int' are not compatible for the '+' operator.\n",
  needsPositive: 'Error: nu::shell::needs_positive_value\n\n  x Negative value passed when positive one is required\n   :             `-- use a positive value',
  unknownCommand: 'Error: nu::parser::unknown_command\n\n  x Unknown command.\n   ,-[source:1:14]\n 1 | let files = @(1, 2)\n   :                 `-- unknown command',
  recordColon: 'Error: nu::parser::assignment_requires_variable\n\n  x Assignment operations require a variable.\n   :           `-- needs to be a variable',
  keywordMissingArg: 'Error: nu::parser::keyword_missing_arg\n\n  x Missing argument to `in`.\n 1 | for f in [1 2]; do print $f',
  cannotPassList: 'Error: nu::shell::cannot_pass_list_to_external\n\n  x Lists are not automatically spread when calling external commands\n   :            `-- Spread operator (...) is necessary to spread lists',
  isADirectory: 'Error: nu::shell::io::is_a_directory\n\n  x I/O error\n   :             `-- Is a directory',
  permissionDenied: 'Error: nu::shell::io::permission_denied\n\n  x I/O error\n   :             `-- Access is denied. (os error 5)',
  httpError: 'Error: nu::shell::http_error\n\n  x HTTP error\n   :             `-- 404 Not Found',
  unexpectedEof: 'Error: nu::shell::io::unexpected_eof\n\n  x I/O error\n   :     `-- Unexpected end of file',
}

test('a failed call carries one hint naming the fix', () => {
  const cases = [
    ['ls | select name 2>&1', STDERR.outerr, /o\+e>/],
    ['ls | select name 2> out.txt', STDERR.shellErr, /o\+e>/],
    ["grep -n 'dsh' file.js", STDERR.external, /`grep` is not available here/],
    ['ls D:/code/dsh/profiles', STDERR.notFound, /path exists/],
    ["open --raw 'C:/Users/me/.npmrc'", STDERR.fileNotFound, /path exists/],
    ['print $env.LAST_EXIT_CODE', STDERR.column, /LAST_EXIT_CODE/],
    ['ls | select name, type', STDERR.nameNotFound, /`select name type`/],
    ['$x = 1', STDERR.variable, /let x = …/],
    ['echo $HOME', STDERR.variable, /\$env\.HOME/],
    ['print $PATH', STDERR.envVarNotVar, /\$env\.PATH/],
    ["if [ -f probe1.txt ] { print 'yes' }", STDERR.conditionNotBoolean, /path exists|is-empty/],
    ['ls -R dsh-nushell-only', STDERR.unknownFlag, /ls -a` → `ls --all`/],
    ["'ABC' | str downcase", STDERR.deprecated, /str lowercase/],
    ["'abcdef' | first 3", STDERR.inputType, /str substring 0\.\.200/],
    ["$env | where name =~ 'DSH'", STDERR.onlySupports, /transpose key value/],
    ['glob a b', STDERR.extraPositional, /fold the directory in/],
    ['str trim', STDERR.pipelineEmpty, /consumes its pipeline input/],
    ['where name like "*.md"', STDERR.pipelineEmpty, /no input/],
    ['ls D:/dir/*.md', STDERR.globPattern, /`glob <pattern>`/],
    ['ls C:/x/**/*.jsonl', STDERR.expand, /empty list/],
    ['ls D:/x/**/*.md', STDERR.doNotExpand, /empty list/],
    ['cd D:/x; make && node .', STDERR.andand, /separate statements with `;`/],
    ['let count = 0; $count = 1', STDERR.immutable, /mut x = …|mut count/],
    ['[1 2] | each { $x = 1 }', STDERR.evalBlock, /name the parameter/],
    ["print 'unbalanced", STDERR.parseMismatch, /single quotes/],
    ['print 1 out+err>', STDERR.redirectionTarget, /needs a target|redirects nothing/],
    ['node x.cjs | out+err> | str trim', STDERR.unexpectedRedirection, /redirects nothing|needs a target/],
    ['print 1 | %{ $in }', STDERR.percentSigil, /`\| each \{ \|item\| … \}`/],
    ['print 1 | %', STDERR.percentSigil, /ForEach-Object/],
    ["'abc' | str contains 'a' or 'b'", STDERR.incompatiblePathAccess, /one pipeline/],
    ['print (1 + [1 2])', STDERR.operatorUnsupported, /does not coerce/],
    ["print ('a' + 1)", STDERR.operatorIncompatible, /does not coerce/],
    ['ls | first -3', STDERR.needsPositive, /first 3/],
    ['let files = @(1, 2)', STDERR.unknownCommand, /PowerShell array/],
    ['let r = { a = 1 }', STDERR.recordColon, /colon/],
    ['for f in [1 2]; do print $f', STDERR.keywordMissingArg, /takes a block/],
    ['^git add [a b]', STDERR.cannotPassList, /spread operator/],
    ['open --raw D:/', STDERR.isADirectory, /directory/],
    ['rm -f D:/locked/x.txt', STDERR.permissionDenied, /sandbox/],
    ["http get 'https://x/404'", STDERR.httpError, /http get --full/],
    ["http get 'https://offline.invalid/x'", STDERR.unexpectedEof, /http get --full/],
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