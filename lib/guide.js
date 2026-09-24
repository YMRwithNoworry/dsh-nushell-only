/**
 * The teaching layer's text: the mandatory shell rules, the Nushell syntax
 * guide, and the Nushell-dialect shell-tool description.
 *
 * Every ```nu block in {@link buildGuide} is executed by
 * `test/guide.test.mjs` against the Nushell installed on the machine, so the
 * guide teaches syntax that is known to work rather than syntax that merely
 * looks right.
 *
 * @module dsh-nushell-only/guide
 */

/** Fence language of the runnable examples inside the guide. */
export const GUIDE_FENCE = 'nu'

/**
 * The short, high-salience rules section. Prompt sections are prepended to every
 * request, so this states only what changes behavior: the dialect, the
 * freshness contract, the refusal rule, and where the data model differs.
 * @returns the rules text.
 */
export function buildShellRules() {
  return [
    '## Shell: Nushell only',
    '',
    'Every shell command in this deployment runs through Nushell (`nu --no-config-file -c "<command>"`). Write Nushell syntax: bash and PowerShell syntax are not translated and fail at parse time.',
    '',
    '- Each call runs in a fresh Nushell process. `cd`, `let`, `mut`, `def`, and `$env` changes do NOT persist; use the shell tool\'s `workdir` parameter instead of `cd`.',
    '- `config.nu` / `env.nu` are not loaded, so the user\'s interactive shell settings do not apply; set environment per command (`$env.NAME = "value"` or `with-env`).',
    '- Handing a command to another shell (`bash -c`, `sh -c`, `cmd /c`, `pwsh -Command`, `wsl …`) is refused: there is no fallback shell.',
    '- Foreign-dialect habits are also refused before anything runs (`2>&1`, `$env:VAR`, `$x = 1`, `foreach`, `@(…)`, `Get-Content`, `glob a b`, `mkdir -p`). The refusal names the Nushell spelling — fix the command and call again.',
    '- A failed call appends a `Nushell hint (…)` line to stderr naming the fix for the error Nushell reported (missing path, absent column, wrong input type, unknown flag). Read it before retrying.',
    '- Nushell parses a whole command before running it, so a syntax or type mistake fails the entire call; `try` cannot catch a parse error.',
    '- Only the **last** statement\'s value is displayed by `nu -c`: `print` the intermediate values you need to see (`ls | length; print "done"` shows only `done`).',
    '- A failing external command **aborts the rest of the command and prints nothing** — you just see `[exit code: N]`. Capture with `| complete`, ignore with `do -i { … }`, or handle with `try { … } catch { … }`.',
    '- Pipelines carry structured values (records, lists, tables), not text. Filter with `where` / `select` / `get` / `sort-by` instead of parsing text; use `to json` / `to csv` / `str join` when an exact serialized form is required.',
    '- Read a plain file with `open --raw <path>` (`open <path>` auto-parses JSON/TOML/YAML/CSV by extension).',
    '- The `shell: nushell-guide` section below has the syntax cheat sheet and the bash/PowerShell translation table.',
  ].join('\n')
}

function essentialsSection() {
  return [
    '### Language essentials',
    '',
    '```nu',
    'let name = "dsh"                        # immutable binding; read it as $name',
    'mut count = 0                           # mutable binding',
    '$count = $count + 1',
    '$env.DSH_DEMO = "1"                     # environment variable (there is no `export VAR=1`)',
    'print $"hello ($name), count=($count)"  # interpolation: expressions need parentheses',
    'if $count == 1 { "one" } else { "many" }',
    'match $count { 0 => "zero", _ => "other" }',
    'def add [a: int, b: int] { $a + $b }',
    'add 2 3',
    'try { error make {msg: "boom"} } catch { |err| $err.msg }',
    'for x in [1 2 3] { print $x }',
    '```',
    '',
    'Rules of thumb: bind once with `let`, read with `$name`; subexpressions are `( ... )`; string interpolation is `$"text (expr)"`; blocks take a closure `{ |item| ... }`; a missing environment variable errors, so read optional ones as `$env.NAME?`.',
  ].join('\n')
}

function dataSection() {
  return [
    '### Data, files, and tables',
    '',
    '```nu',
    'ls                                                          # a table describing the working directory',
    'ls | where type == file | sort-by size | reverse | first 5 | select name size',
    'glob **/*.md | length                                       # recursive glob returns paths; empty is fine',
    'open package.json | get version                             # json/toml/yaml/csv parse by extension',
    'open --raw notes.txt | str trim                             # raw text: the reliable way to read a plain file',
    '"data" | save -f out.txt                                    # -f overwrites; no shell redirect needed',
    '[1 2 3] | each { |n| $n * 2 } | math sum',
    '[[name size]; [a 1] [b 2]] | where size > 1 | get name',
    '```',
    '',
    'Tables are values: `where` filters rows, `select` picks columns, `get` extracts a cell or column, `sort-by` orders by a column, `each` maps, `length` counts, `uniq` deduplicates, `group-by` groups, `to json` / `to csv` serialize. For a plain list use `sort`, `first`, `last`, `skip`, `take`, `math sum`, `math avg`, `math max`.',
  ].join('\n')
}

function externalSection() {
  return [
    '### External commands and exit codes',
    '',
    '```nu',
    '^git --version | str trim',
    '^git status | lines | first 1                          # capture an external command as text lines',
    'do { ^git rev-parse --is-inside-work-tree } | complete | get exit_code   # {stdout, stderr, exit_code}, no failure',
    'which git | get 0.path',
    '```',
    '',
    'A bare word runs an external program when no builtin has that name; `^prog` always forces the external. A failing external command sets the process exit code, so the tool reports `[exit code: N]`; use `complete` when you need to inspect a failure without failing the call.',
  ].join('\n')
}

function textSection() {
  return [
    '### Text and strings',
    '',
    '```nu',
    '"a,b,c" | split row ","',
    '"name=1" | parse "name={value}" | get 0.value',
    '"abc" | str contains "b"',
    '"abc" | str replace -r \'\\d\' "#"        # single quotes keep regex backslashes literal',
    '" a " | str trim',
    '"abc" | str uppercase',
    'open --raw notes.txt | lines | where { |l| $l =~ "hello" } | length',
    '```',
    '',
    'Useful commands: `split row`, `split column`, `parse`, `lines`, `str contains`, `str replace -r`, `str trim`, `str uppercase`, `str lowercase`, `str length`, `str join`, `str substring 1..3`, `str starts-with`.',
  ].join('\n')
}

function environmentSection() {
  return [
    '### Environment, paths, and quoting',
    '',
    '```nu',
    '$env.DSH_HOME?                          # optional read; `$env.DSH_HOME` errors when unset',
    '$env.DSH_DEMO = "1"; $env.DSH_DEMO',
    '["a" "b"] | path join',
    "'C:\\Users' | path exists                # single quotes keep backslashes literal",
    '"~" | path expand',
    '$nu.temp-dir                            # also: $nu.home-dir, $nu.os-info.name, $nu.current-exe',
    "'single-quoted \\n is literal' | str length",
    '"double-quoted \\n is an escape" | lines | length',
    '```',
    '',
    'Double-quoted strings process `\\` escapes (an invalid escape is a parse error), so single-quote regular expressions and Windows paths: `\'C:\\Users\\me\'`, `\'\\.md$\'`. Raw strings skip escaping entirely (`r#\'…\'#`). Prefer forward slashes in paths Nu builds itself; `path join`, `path exists`, `path type`, `path expand`, `path basename`, and `path dirname` handle both separators.',
  ].join('\n')
}

function translationSection() {
  return [
    '### bash / PowerShell → Nushell',
    '',
    '| bash or PowerShell | Nushell |',
    '|---|---|',
    '| `cmd1 && cmd2`, `cmd1 \\|\\| cmd2` | `cmd1; cmd2` (`&&` and `\\|\\|` are parse errors) |',
    '| `$VAR` | `$env.VAR` (optional: `$env.VAR?`) |',
    '| `$x = 1`, `set x 1` | `let x = 1` (immutable) / `mut x = 1` (reassignable) — a bare `$x = 1` is a parse error |',
    '| `export VAR=1`, `VAR=1 cmd` | `$env.VAR = "1"`; per-command: `with-env { VAR: "1" } { ... }` |',
    '| `@(1,2,3)` (PowerShell array) | `[1 2 3]` — items are space-separated, commas are not separators |',
    '| `foreach ($x in $xs) { … }` | `for x in $xs { … }` (files: `for f in (glob *.txt) { … }`) |',
    '| `$?`, `$_`, `$PSItem`, `-not $x` | `(do { cmd } \\| complete).exit_code`, `$in` (or name the closure input), `not $x` |',
    '| `$(cmd)`, `` `cmd` `` | `(cmd)` for a value; a bare word or `^cmd` to run an external |',
    '| `a > f`, `a 2>&1` | `a o> f` (stdout), `a e> f` (stderr), `a o+e> f` (both) |',
    '| `a > f 2>&1` / `a 2>$null` / `a 2>/dev/null` | `a o+e> f` for both streams, `a e> f` for stderr only; to capture instead of redirect: `do { a } \\| complete` → `{stdout, stderr, exit_code}` |',
    '| `cat f` | `open --raw f` |',
    '| `head -n 40 f` / `tail -n 40 f` | `open --raw f \\| lines \\| first 40` / `… \\| last 40`; on a pipeline: `… \\| first 40` |',
    '| `wc -l f` | `open --raw f \\| lines \\| length` |',
    '| `cat f \\| grep x` | `open --raw f \\| lines \\| where { \\|l\\| $l =~ "x" }` |',
    '| `sed -n \'10,25p\' f` | `open --raw f \\| lines \\| skip 9 \\| first 16` |',
    '| `ls -la` | `ls --all --long` |',
    '| `find . -name \'*.rs\'` | `glob **/*.rs` |',
    '| `sort f \\| uniq` | `open --raw f \\| lines \\| sort \\| uniq` |',
    '| `for f in *.txt; do …; done` | `for f in (glob *.txt) { … }` |',
    '| `xargs cmd` | `… \\| each { \\|x\\| cmd $x }` |',
    '| `sleep 5` | `sleep 5sec` (`ms`, `sec`, `min`, `hr`, `day`) |',
    '| `mkdir -p a/b` | `mkdir a/b` (parents are always created) |',
    '| `ls -a`, `ls -R` | `ls --all`; recursion is a glob: `ls **/*`, `glob **/*.rs`, `glob --depth 3` |',
    '| `select -First 20` / `-Last 20` / `-Unique` | `first 20` / `last 20` / `uniq` |',
    '| `get -i col`, `str downcase`, `str upcase` | `get -o col` (`--optional`), `str lowercase`, `str uppercase` |',
    '| `ls \'~/.dsh/profiles?\'` | `?` is optional access for a *variable or column* (`$env.X?`), never a path wildcard — use `glob` or `<path> \\| path exists` |',
    '| `$env.LAST_EXIT_CODE` after a builtin | use `$env.LAST_EXIT_CODE?`, or `(do { ^cmd } \\| complete).exit_code` (only external commands set it) |',
    '| `rm -rf d` | `rm -r -f d` |',
    '| `echo $?` | `(do { cmd } \\| complete).exit_code`, or `$env.LAST_EXIT_CODE?` |',
    '| `cmd \\|\\| true`, `set +e` | `do -i { cmd }` (ignore a failure), `cmd \\| complete` (capture it), or `try { cmd } catch { \\|e\\| … }` |',
    '| `cmd1; cmd2` where `cmd1` may fail | a failing external aborts the rest of the command: `do -i { cmd1 }; cmd2`, or check `(do { cmd1 } \\| complete).exit_code` first |',
    '| `echo a; echo b` (two statements) | only the last statement\'s value is shown: `print a; print b`, or return one combined value |',
    '| PowerShell `$env:NAME` | `$env.NAME` |',
    '| PowerShell `Get-ChildItem` / `Where-Object` / `Select-String` | `ls` / `where` / `where { \\|l\\| $l =~ \'pat\' }` |',
    '| PowerShell `Test-Path p` / `Join-Path a b` | `\'p\' \\| path exists` / `["a" "b"] \\| path join` |',
    '| PowerShell `Set-Content f x` / `Get-Content f` | `"x" \\| save -f f` / `open --raw f` |',
  ].join('\n')
}

function errorSection() {
  return [
    '### When Nushell refuses: the real failures and their fixes',
    '',
    'Nushell parses a whole command before running it, so a dialect slip either fails the entire call (and `try` cannot catch it) or — for `2>$null`, `2>nul`, `2>>file` and `&>`, which Nushell lexes as ordinary words — silently hands the fragment to the program as an argument and does nothing. Both are refused before anything spawns; a failure that still gets through comes back with a `Nushell hint (…)` line.',
    '',
    '| you wrote | Nushell reported | write this instead |',
    '|---|---|---|',
    '| `cmd 2>&1`, `cmd 2> file` | `nu::parser::shell_outerr`, `shell_err` | `cmd o+e> out.txt` (both), `cmd e> err.txt`, `cmd o> out.txt`; to capture: `do { cmd } \\| complete` |',
    '| `cmd 2>$null`, `cmd 2>/dev/null`, `cmd 2>nul`, `cmd &> f` | *no error* — the fragment is a word, so the program receives it as an extra argument and stderr is never suppressed | `cmd e> nul` (Windows) / `cmd e> /dev/null` to drop stderr, `cmd o+e> out.txt`, or `do { cmd } \\| complete` |',
    '| `grep pat f`, `head -20 f`, `cat f`, `wc -l f`, `sed -n …` | `nu::shell::external_command` (not installed) | `open --raw f \\| lines \\| where { \\|l\\| $l =~ "pat" }`, `… \\| first 20`, `open --raw f`, `… \\| length` |',
    '| `Get-Content f`, `Set-Content f x`, `Get-ChildItem`, `Select-Object`, `Where-Object`, `Test-Path p`, `Join-Path a b`, `Out-String` | `nu::shell::external_command` | `open --raw f`, `"x" \\| save -f f`, `ls`, `select` / `first 20`, `where { \\|r\\| … }`, `p \\| path exists`, `["a" "b"] \\| path join`, `\\| to text` |',
    '| `select name, type`, `get 0, 1` | `nu::shell::name_not_found` ("did you mean \'name\'?") | a comma is not a column separator: `select name type` (a *list literal* does take them: `[1, 2]` is two items) |',
    '| `ls <missing>`, `open <missing>` | `nu::shell::io::not_found`, `io::file_not_found` | `<p> \\| path exists` to test, `glob <pattern>` to list (empty is valid), `try { … } catch { … }` to tolerate |',
    '| `$x = 1`, `$env:REF="d"`, `@(1,2)`, `foreach ($x in $xs) { … }` | `nu::parser::variable_not_found`, `unknown_command` | `let x = 1` / `mut x = 1`, `$env.REF = "d"`, `[1 2]`, `for x in $xs { … }` |',
    '| `ls -a` / `ls -R` / `mkdir -p a/b` | `nu::parser::unknown_flag` | `ls --all`; recursion via `ls **/*` or `glob **/*.rs`; `mkdir a/b` |',
    '| `select -First 20`, `select -Last 20`, `select -Unique` | `nu::parser::unknown_flag` / `deprecated flag` | `first 20`, `last 20`, `uniq` (as a *command*, `str downcase` and `get -i` only warn and still run: prefer `str lowercase`, `get -o`) |',
    '| `ls -ErrorAction SilentlyContinue`, `rm x -Force`, `Get-ChildItem -Recurse` | `nu::parser::unknown_flag`, `nu::shell::external_command` | PowerShell common parameters do not exist: drop them (`rm -f`, `ls --all`, `glob **/*`) and read stderr from the result |',
    '| `first -3`, `last -40` | `nu::shell::needs_positive_value` | counts are positive: `first 3`, `last 40` (`Select-Object -Last 20` → `last 20`) |',
    '| `cmd \\| o> f`, `cmd \\| out+err>` | `nu::parser::unexpected_redirection` ("redirecting nothing") | a redirection ends the command that produced the value: `cmd o> f`; after a `\\|` use `complete` instead |',
    '| `%{ … }` | `nu::parser::error` ("percent sigil") | `\\| each { \\|item\\| … }`, or `for x in $xs { … }` |',
    '| `str trim` / `where …` with nothing piped in | `nu::shell::pipeline_mismatch` ("Pipeline empty.") | a stage consumes its pipeline input: `open --raw f \\| str trim`, or feed it explicitly |',
    '| `$env.LAST_EXIT_CODE`, `$env.HOME` | `nu::shell::column_not_found` | `$env.LAST_EXIT_CODE?` (externals only), or `(do { ^cmd } \\| complete).exit_code` |',
    '| `$env \\| where name =~ "DSH"` | `nu::shell::only_supports_this_input_type` | `$env \\| transpose key value \\| where key =~ "DSH"`, or read the variable directly |',
    '| `\'text\' \\| first 3`, `… \\| str trim \\| first 200` | `nu::parser::input_type_mismatch` | a string is not a list: `str substring 0..3`, `str length` |',
    '| `glob "**/*.rs" "D:/dir"`, `glob pattern=… path=…` | `nu::parser::extra_positional` | one pattern only: `glob "D:/dir/**/*.rs"` (add `--depth N` to bound it) |',
    '| `ls \'~/.dsh/profiles?\'` | `No matches found for Expand(…)` | `?` is optional *access*, not a path wildcard: `glob`, or `<p> \\| path exists` |',
    '| `cmd1 && cmd2`, `cmd1 \\|\\| cmd2` | `nu::parser::shell_andand`, `shell_oror` | separate statements with `;`; boolean logic uses `and` / `or` |',
    '| `$(cmd)`, `` `cmd` `` | `nu::parser::variable_not_valid` | a subexpression is `(cmd)`; interpolate with `$"text (expr)"` |',
    '| unbalanced quotes or braces | `nu::parser::parse_mismatch`, `unclosed_delimiter` | regexes and Windows paths belong in single quotes (`\'\\d+\'`, `\'C:\\Users\\me\'`) — double quotes process `\\` escapes |',
    '',
    'The correct forms of the top habits, in one running command:',
    '',
    '```nu',
    'open --raw notes.txt | lines | first 2                     # not `cat notes.txt | head -2`',
    'let paths = (glob *.txt)                                    # not `ls -R` / `@(...)`',
    "if ('notes.txt' | path exists) { 'found' }                  # not `ls notes.txt` hoping for silence",
    'do { ^git status --short } | complete | get exit_code      # not `$?` / `2>&1`',
    '[1 2 3] | each { |n| $n * 2 }                               # not `foreach ($n in …)`',
    "'abcdef' | str substring 0..3                              # not `'abcdef' | first 3`",
    '```',
    '',
    'Habits worth naming: `2>&1` is `o+e>`, `2>$null` is not a redirect at all (write `e> nul`, or `| complete` to capture), `$x = 1` needs `let`, `$env:NAME` is `$env.NAME`, `@(…)` is `[…]`, `foreach` is `for … in`, `select a, b` is `select a b`, PowerShell cmdlets have one-word Nu equivalents, and `ls` / `open` fail loudly on a missing path instead of printing a shell error.',
  ].join('\n')
}

function gotchaSection() {
  return [
    '### Traps worth knowing',
    '',
    '- `ls **/*.md` errors with "No matches found" when the glob matches nothing, and `ls <missing>` errors instead of printing a shell message; `glob **/*.md` returns an empty list, so prefer `glob` when empty is a valid outcome and `path exists` when you only need a yes/no.',
    '- Only `2>&1` and `2> file` are redirections to Nushell; `2>$null` / `2>/dev/null` / `2>nul` / `2>>file` (no space) are ordinary words, so they are passed to the program as arguments and stderr is not suppressed. Use `e>` / `o+e>` / `complete`.',
    '- A comma separates items in a list literal (`[1, 2]`) but never a command\'s arguments: `select name, type` looks for a column literally named `name,`.',
    '- A redirection is not a pipeline stage: `cmd | o> f` redirects nothing. End the producing command instead (`cmd o> f`).',
    '- `#` opens a comment at a token boundary — after whitespace, `;`, `{`, `(`, `[` or `|`; elsewhere it is part of a bare word (`1#c`). A trailing comment never changes what runs.',
    '- A parse or type error is raised before the command runs, so `try { … } catch { … }` cannot rescue one — fix the syntax instead.',
    '- `$env` is a record, not a table: `$env | where …` fails on purpose. Use `$env | transpose key value | where key =~ "DSH"`, `$env | columns`, or read one variable (`$env.DSH_HOME?`).',
    '- `first` / `last` / `str …` are type-checked: a string takes `str substring 0..n` (there is no `first` on text), a list or table takes `first n`.',
    '- `complete` only wraps external commands (`do { ^git status } | complete`), not builtins; `$env.LAST_EXIT_CODE` exists only after an external ran.',
    '- In Nushell `>` is comparison, not redirection. Redirect with `o>` / `e>` / `o+e>` or `save`.',
    '- `open notes.txt` may hand back a structured text value (Nushell ≥ 0.110); `open --raw notes.txt` is the text you pipe into `lines` / `str` commands.',
    '- Builtins shadow external programs of the same name — for example `ls`, `ps`, `du`, `glob`, `to json`. `^name` forces the external binary.',
    '- `sort-by` needs a column when sorting tables; use `sort` for a plain list.',
    '- A bare word in a filter is a column reference (`where size > 1kb`); quote strings (`where name == "a.md"`) and use `$env.X?` for optional environment reads.',
    '- Sizes and durations are typed values: `1kb`, `2mb`, `5sec`, `1day`. Compare with them directly (`where size > 1mb`).',
    '- A failing external program aborts the whole command (a bare `^prog` that exits 1 stops everything after it) and prints no explanation — the call just reports `[exit code: N]`. Wrap it: `do { ^prog … } | complete`, `do -i { ^prog … }`, or `try { ^prog … } catch { |e| $e.msg }`.',
    '- `nu -c` renders only the final statement\'s value. A command like `ls | length; print "done"` prints `done` alone — `print` (or `to json`) whatever you need to see.',
    '- Inside double-quoted strings `\\` starts an escape, so JavaScript/PowerShell payloads containing `\\u`, `\\n`, or `$` belong in single quotes: `^node -e \'console.log("\\u2139")\'`.',
    '- Long output is truncated to its tail by the shell tool; the full output is saved to a spill file whose path the tool reports.',
  ].join('\n')
}

/**
 * The full Nushell guide: mandatory rules, runnable syntax, a translation table
 * for bash/PowerShell habits, and the traps that actually bite.
 * @param options - guide options.
 * @param options.variant - `full` (default) or `compact`; `off` returns an empty string.
 * @param options.version - the probed Nushell version, when known.
 * @returns the guide text, or an empty string when the guide is off.
 */
export function buildGuide(options = {}) {
  const variant = options.variant ?? 'full'
  if (variant === 'off') return ''
  const header = [
    `## Nushell syntax guide${options.version === undefined ? '' : ` (Nushell ${options.version})`}`,
    '',
    'Shell commands are evaluated as `nu --no-config-file -c "<command>"`: a fresh, configuration-isolated Nushell process per call.',
  ].join('\n')
  if (variant === 'compact') {
    return [
      header,
      '',
      '```nu',
      'ls | where type == file | get name        # tables are values: where / select / get / sort-by / each',
      'let x = 1; $x + 1                          # bind with let, read with $x; subexpressions use ()',
      '$env.PATH | length                         # environment; a possibly-unset read is $env.NAME?',
      '"a" o> f.txt; open --raw f.txt             # redirect with o> / e> / o+e>; read text with open --raw',
      '^git status | lines                        # ^ forces an external command',
      '```',
      '',
      'Not Nushell: `&&`, `||`, `$VAR`, `$x = 1`, `export X=1`, `$(...)`, `a > f`, `2>&1`, `2>$null`, `foreach`, `@(…)`, `Get-Content`, `for f in *.txt; do … done`. Each call is a new process — use the tool\'s `workdir` instead of `cd`. Foreign-dialect habits are refused before running; a failed call appends a `Nushell hint (…)` line naming the fix.',
    ].join('\n')
  }
  return [header, '', essentialsSection(), '', dataSection(), '', externalSection(), '', textSection(), '', environmentSection(), '', translationSection(), '', errorSection(), '', gotchaSection()].join('\n')
}

/**
 * The model-facing description that replaces the first-party bash/PowerShell
 * description. It keeps the first-party semantics (fresh process, exit markers,
 * sandbox denial, background, escalation) and states the dialect.
 * @param options - description options.
 * @param options.background - whether the tool advertises `run_in_background`.
 * @param options.escalation - whether the tool advertises `sandbox_permissions`.
 * @param options.guide - whether a guide section is registered in the prompt.
 * @returns the tool description.
 */
export function buildToolDescription(options = {}) {
  const background = options.background === true
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const base = 'Execute a command with Nushell (`nu --no-config-file -c`) and return its stdout/stderr. '
    + 'The dialect is Nushell, not bash or PowerShell: `&&`, `||`, `$VAR`, `export`, `$(...)`, and `>` redirects are parse errors. '
    + 'Each call runs in a fresh Nushell process: no state (cwd, variables, functions, environment) persists between calls — pass `workdir` instead of using `cd`. '
    + 'Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed as `$env.DSH_*` variables (read one with `$env.DSH_NAME?`); inspect them when needed. '
    + 'Nushell essentials: bind with `let x = 1` and read `$x`; subexpressions are `(cmd)`; interpolate with `$"text (expr)"`; tables are values (`ls | where size > 1mb | get name`); read a file with `open --raw <path>`; filter text with `lines | where { |l| $l =~ \'pat\' }`; redirect with `o>` / `e>` / `o+e>`. '
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Foreign-dialect habits (`2>&1`, `$env:VAR`, `$x = 1`, `foreach`, `@(…)`, `Get-Content`, `glob a b`) are refused before anything runs, with the Nushell spelling in the error; a failed call appends a `Nushell hint (…)` line naming the fix. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
    + (options.guide === false ? '' : ' The system prompt carries the full Nushell guide (`shell: nushell-guide`).')
  if (options.escalation !== true) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'
}

/** The description for the shell tool's `command` parameter. */
export const NUSHELL_COMMAND_PARAM_DESCRIPTION = 'The Nushell command to execute (Nushell syntax; not bash or PowerShell).'
