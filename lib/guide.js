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
    '| `export VAR=1` | `$env.VAR = 1`; per-command: `with-env { VAR: "1" } { ... }` |',
    '| `$(cmd)`, `` `cmd` `` | `(cmd)` for a value; a bare word or `^cmd` to run an external |',
    '| `a > f`, `a 2>&1` | `a o> f` (stdout), `a e> f` (stderr), `a o+e> f` (both) |',
    '| `cat f` | `open --raw f` |',
    '| `head -5 f` / `tail -5 f` | `open --raw f \\| lines \\| first 5` / `… \\| last 5` |',
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
    '| `rm -rf d` | `rm -r -f d` |',
    '| `echo $?` | `(do { cmd } \\| complete).exit_code`, or `$env.LAST_EXIT_CODE?` |',
    '| PowerShell `$env:NAME` | `$env.NAME` |',
    '| PowerShell `Get-ChildItem` / `Where-Object` / `Select-String` | `ls` / `where` / `where { \\|l\\| $l =~ \'pat\' }` |',
    '| PowerShell `Test-Path p` / `Join-Path a b` | `\'p\' \\| path exists` / `["a" "b"] \\| path join` |',
    '| PowerShell `Set-Content f x` / `Get-Content f` | `"x" \\| save -f f` / `open --raw f` |',
  ].join('\n')
}

function gotchaSection() {
  return [
    '### Traps worth knowing',
    '',
    '- `ls **/*.md` errors with "No matches found" when the glob matches nothing; `glob **/*.md` returns an empty list, so prefer `glob` when empty is a valid outcome.',
    '- In Nushell `>` is comparison, not redirection. Redirect with `o>` / `e>` / `o+e>` or `save`.',
    '- `open notes.txt` may hand back a structured text value (Nushell ≥ 0.110); `open --raw notes.txt` is the text you pipe into `lines` / `str` commands.',
    '- Builtins shadow external programs of the same name — for example `ls`, `ps`, `du`, `glob`, `to json`. `^name` forces the external binary.',
    '- `sort-by` needs a column when sorting tables; use `sort` for a plain list.',
    '- A bare word in a filter is a column reference (`where size > 1kb`); quote strings (`where name == "a.md"`) and use `$env.X?` for optional environment reads.',
    '- Sizes and durations are typed values: `1kb`, `2mb`, `5sec`, `1day`. Compare with them directly (`where size > 1mb`).',
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
      'Not Nushell: `&&`, `||`, `$VAR`, `export X=1`, `$(...)`, `a > f`, `2>&1`, `for f in *.txt; do … done`. Each call is a new process — use the tool\'s `workdir` instead of `cd`.',
    ].join('\n')
  }
  return [header, '', essentialsSection(), '', dataSection(), '', externalSection(), '', textSection(), '', environmentSection(), '', translationSection(), '', gotchaSection()].join('\n')
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
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
    + (options.guide === false ? '' : ' The system prompt carries the full Nushell guide (`shell: nushell-guide`).')
  if (options.escalation !== true) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'
}

/** The description for the shell tool's `command` parameter. */
export const NUSHELL_COMMAND_PARAM_DESCRIPTION = 'The Nushell command to execute (Nushell syntax; not bash or PowerShell).'
