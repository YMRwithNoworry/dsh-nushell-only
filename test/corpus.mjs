/**
 * The shared corpus: the commands the preflight must refuse, the commands it must
 * never refuse, and the evidence for each.
 *
 * Every entry was run through the installed Nushell (`nu --no-config-file -c`,
 * 0.115.1) while this list was written:
 *
 * - a {@link REFUSALS} command fails in Nushell — except the `stderr-as-word`
 *   family, which is worse than failing (see {@link SILENT_BUT_WRONG});
 * - an {@link ALLOWED} command is valid Nushell and must never be refused.
 *
 * `test/nu-accepts.test.mjs` re-checks both claims against the Nushell on the
 * machine running the suite, so a rule that drifts from real Nushell behaviour
 * fails loudly instead of refusing a working command.
 *
 * @module dsh-nushell-only/test/corpus
 */

/** Commands that must be refused, with the rule that must catch each one. */
export const REFUSALS = [
  // stderr redirection: a parse error in Nushell…
  ["ls 'D:/code/dsh' 2>&1 | select name type size", 'stderr-redirect'],
  ['node --test test/ 2>&1 | tail -60', 'stderr-redirect'],
  ['print 1 2> out.txt', 'stderr-redirect'],
  // …and the `2>$null` spelling, which is worse: Nushell lexes it as a word.
  ['ls C:/Users/me/.dsh -a -e 2>$null | table', 'stderr-as-word'],
  ['ls D:/x 2>/dev/null | first 5', 'stderr-as-word'],
  ['node build.cjs 2>nul', 'stderr-as-word'],
  ['print 1 &> out.txt', 'stderr-as-word'],
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
  ['if (-Not (Test-Path D:/x)) { print "no" }', 'powershell-not-operator'],
  ['ls | select -First 20', 'deprecated-flags'],
  ['mkdir -p D:/tmp/probe/x', 'mkdir-parents'],
  ['ls -R dsh-nushell-only', 'recursive-ls'],
  ['$(ls D:/code)', 'cmd-substitution'],
  // Cmdlets head a statement…
  ['Get-ChildItem -Path C:/x -Recurse -Depth 2', 'powershell-cmdlet'],
  ["Get-Content 'C:/Users/me/.npmrc' | Select-String authToken", 'powershell-cmdlet'],
  ['Test-Path C:/Users/me/.dsh', 'powershell-cmdlet'],
  ['Join-Path $root "src/main/java"', 'powershell-cmdlet'],
  // …or hide inside a subexpression or a closure, where only a nested scan sees them.
  ['print (Get-ChildItem -Path C:/x -Recurse -Directory)', 'powershell-cmdlet'],
  ['ls | each { |f| Get-Content $f.name }', 'powershell-cmdlet'],
  ['glob "**/ValueInput*.java" "D:/code/MC"', 'glob-extra-positional'],
  ['glob pattern="**/*.java" path="D:/code"', 'glob-named-arguments'],
  ["ls '~/.dsh/profiles?'", 'path-optional-suffix'],
  ['TOKEN=abc node publish.cjs', 'prefix-assignment'],
  // Habits measured in real sessions that used to reach Nushell untouched:
  // `select name, type` (name_not_found ×17), `-ErrorAction` / `-Force`,
  // `first -3` / `last -40` (needs_positive_value), `%{ … }`, `| out+err>`.
  ['ls | select name, type', 'comma-columns'],
  ['ls | reject name, type size', 'comma-columns'],
  ['ls C:/x -ErrorAction SilentlyContinue', 'powershell-parameter'],
  ['mv D:/a.txt D:/b.txt -Force', 'powershell-parameter'],
  ['ls | first -3', 'negative-count'],
  ['ls | last -40', 'negative-count'],
  ['print 1 | %{ $in }', 'percent-sigil'],
  ['node build.cjs | out+err> | str trim', 'pipe-redirect'],
  ['git diff | o> .diff.txt', 'pipe-redirect'],
]

/**
 * Refusals whose command Nushell happily *runs*: `2>$null`, `2>nul`, `&>` and
 * friends are not redirections at all in Nushell — they are ordinary words, so
 * the program receives them as extra arguments and stderr is never suppressed.
 * These are the cases where a refusal is most valuable, because the command
 * cannot fail loudly: it silently does the wrong thing.
 */
export const SILENT_BUT_WRONG = new Set(['stderr-as-word'])

/** Valid Nushell that must never be refused — a false positive costs a turn. */
export const ALLOWED = [
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
  '^Get-ChildItem -Path C:/x',
  "^powershell -NoProfile -Command \"Get-Item 'C:/x'\"",
  "^nu -c 'print \"2>&1\"'",
  "r#'raw 2>&1 $env:X'# | str length",
  'ls | where size > 1kb | sort-by size | reverse | first 5 | select name size',
  "['a' 'b'] | path join",
  'let p = (glob D:/code/*.md | get 0); if ($p | path exists) { open --raw $p | lines | last 3 }',
  '$env.PATH = "x"; $env.PATH',
  '$in | describe',
  // A comment opens at a token boundary: after `;`, `{`, `(`, `[` and `|` too,
  // not only after whitespace. Refusing these was a false positive on 0.115.1.
  'print 1;# trailing note about 2>&1',
  'ls;# 2>$null is a comment here, not a redirect',
  'ls ;# 2>/dev/null likewise',
  'if true {# 2>&1 is a comment\nprint 1}',
  'print (# 2>&1 is a comment\n1)',
  '[# 2>&1 comment\n1] | length',
  'print 1#c is a bare word',
  // Commas are separators in list literals, and `first`/`last` take real counts.
  '[1, 2] | length',
  'ls | select name type',
  'ls | get name size | length',
  'ls | where size > 1kb | first 3',
  'ls | last 3 | length',
  // A redirection ends a command (never a pipeline stage).
  'print 1 o> out.txt',
  'print 1 e> err.txt',
  'print 1 o+e> both.txt',
  // `%` as data, PowerShell words inside strings, and the documented external escapes.
  "print '50%{ done'",
  "print '-ErrorAction is PowerShell'",
  'do { ^git add -- file.txt } | complete',
  // A quoted first word is a string value, not a program: Nushell rejects a
  // quoted command name outright, so these are pipelines over text. All four
  // were refused before (as a bash `VAR=value` prefix or a PowerShell cmdlet).
  '"a=1" | str length',
  "'x=1' | str length",
  '"name=1" | parse "name={value}" | get 0.value',
  '"Get-Content" | str length',
  '"bash" | str length',
  '"grep" | str length',
  // Deprecated *by warning only* on 0.115.1: these run, so they must not be
  // refused — the `deprecated-flag` hint below the output names the replacement.
  // (Their strict replacements `select -First` / `-Last` / `-Unique` do fail.)
  "ls | get -i name",
  "'ABC' | str downcase",
  "'abc' | str upcase",
]
