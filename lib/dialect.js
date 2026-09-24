/**
 * Dialect preflight and failure hints: the part of the Nu-only contract that
 * answers *how the model actually gets it wrong*.
 *
 * The guard (`guard.js`) covers the one escape hatch that would silently run
 * another shell. This module covers the next class of failures: a command that
 * is valid bash or PowerShell, is not a shell handoff, and therefore reaches
 * `nu` as a dialect habit. Real session logs from a Nu-only deployment put those
 * at roughly one in five shell calls, and they are overwhelmingly habits:
 *
 * | observed Nushell error | count | habit |
 * |---|---|---|
 * | `nu::shell::external_command` | 423 | `grep`, `head`, `cat`, `Get-Content`, `docker` |
 * | `nu::parser::unknown_flag` | 140 | `ls -a`, `mkdir -p`, `select -First 20`, `head -40` |
 * | `nu::parser::variable_not_found` | 137 | `$x = 1`, `foreach`, `$env:VAR = …` |
 * | `nu::shell::io::not_found` | 128 | `ls <missing>`, `open <missing>` |
 * | `nu::parser::shell_outerr` | 85 | `2>&1`, `2> file` |
 * | `nu::parser::error` | 70 | `%{ … }`, `{ a = 1 }` |
 * | `nu::shell::column_not_found` | 53 | `$env.LAST_EXIT_CODE`, `$env.HOME` |
 * | `nu::shell::error` | 44 | a glob that matched nothing |
 * | `nu::shell::incompatible_path_access` | 34 | `$l \| str contains 'a' or 'b'` — a pipeline stage mixed with `or` / `and` |
 * | `nu::shell::name_not_found` | 17 | `select name, type` (a comma is not a separator) |
 *
 * Three mechanisms, all deterministic:
 *
 * 1. {@link assertNushellDialect} — refuse before spawning, naming the habit, the
 *    Nushell spelling, and the command it is refusing. A refusal that teaches
 *    beats a parse error that does not.
 * 2. {@link dialectHint} — for the failures a preflight cannot know (a missing
 *    path, an absent column, a wrong input type), append one actionable line to
 *    the captured stderr so the next attempt is informed.
 * 3. `test/fixtures/nu-errors/` + `dev/capture-nu-errors.mjs` — one captured
 *    stderr per failure class, so every hint regex is checked against what
 *    Nushell really prints. `No matches found for Expand(…)` was believed for two
 *    releases and is wrong: 0.115 prints `No matches found for DoNotExpand(…)`.
 *
 * Both layers are conservative by construction: strings, raw strings, and
 * comments are blanked before matching (at Nushell's real comment boundaries,
 * which include `;#` and `{#`), statement-level rules look at the program token
 * of a statement, a second scan catches cmdlets nested in `( … )` / `{ … }`, and
 * `^program` always stays the escape hatch. `test/nu-accepts.test.mjs` re-checks
 * the corpus against the installed `nu`, in both directions: a refusal Nushell
 * would have run fails the suite just as loudly as a false positive does.
 *
 * A refusal is therefore never a false positive on data that merely looks like
 * syntax, and never blocks a command Nushell accepts — a *deprecated but working*
 * spelling (`str downcase`, `get -i`) is deliberately left to run and taught by
 * the deprecation hint instead.
 *
 * @module dsh-nushell-only/dialect
 */

import { isQuotedHead, splitStatements, startsComment, tokenize } from './guard.js'

/**
 * Blank out strings, raw strings, and comments, preserving length and newlines
 * so a match offset still points at the original command.
 * @param command - the Nushell source.
 * @returns a same-length view with data regions replaced by spaces.
 */
export function codeView(command) {
  // Split by UTF-16 code unit so offsets line up with regex and indexOf hits.
  const chars = command.split('')
  const blank = (from, to) => {
    for (let index = from; index < to && index < chars.length; index++) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    // Raw strings: r#'…'# (any number of #).
    if ((char === 'r' || char === 'R') && chars[index + 1] === '#') {
      let hashes = 0
      let cursor = index + 1
      while (chars[cursor] === '#') {
        hashes++
        cursor++
      }
      const quote = chars[cursor]
      if (quote === "'" || quote === '"') {
        const terminator = `${quote}${'#'.repeat(hashes)}`
        const end = command.indexOf(terminator, cursor + 1)
        const stop = end === -1 ? chars.length : end + terminator.length
        blank(cursor, stop)
        index = stop
        continue
      }
    }
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1
      while (cursor < chars.length) {
        if (chars[cursor] === '\\' && char === '"') {
          cursor += 2
          continue
        }
        if (chars[cursor] === char) {
          // A doubled quote escapes itself inside single quotes.
          if (char === "'" && chars[cursor + 1] === "'") {
            cursor += 2
            continue
          }
          break
        }
        cursor++
      }
      const stop = Math.min(cursor + 1, chars.length)
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '#' && startsComment(command, index)) {
      let cursor = index
      while (cursor < chars.length && chars[cursor] !== '\n') cursor++
      blank(index, cursor)
      index = cursor
      continue
    }
    index++
  }
  return chars.join('')
}

/**
 * One preflight rule. `find` receives the code view (and the original command
 * for offset-preserving decisions) and returns the offending fragment, or
 * undefined when this habit is absent.
 */
const RULES = [
  {
    id: 'stderr-redirect',
    detail: '`2>&1` and `2> file` are shell redirections, and Nushell parses both as errors (`nu::parser::shell_outerr`: "The \'2>&1\' shell operation is \'out+err>\'"; `nu::parser::shell_err` for `2>` with a target). Nushell redirects a stream with `o>` (stdout), `e>` (stderr), or `o+e>` (both): `cmd o+e> out.txt`. To capture instead of redirect, `do { cmd } | complete` returns `{stdout, stderr, exit_code}`.',
    find: (view) => matchFragment(view, /(?:^|[\s;&|(])(?:2>&1|2>>?(?=\s|$))/),
  },
  {
    id: 'stderr-as-word',
    detail: 'Nushell has no `2>` redirection, so this fragment is not a redirect at all: it is lexed as an ordinary word, the program receives it as an extra argument, and stderr is NOT suppressed — the command still runs, which is worse than an error. Write `cmd e> nul` (Windows) / `cmd e> /dev/null` to drop stderr, `cmd o+e> out.txt` to keep both streams, or `do { cmd } | complete` to capture `{stdout, stderr, exit_code}`.',
    find: (view) => matchFragment(view, /(?:^|[\s;&|(])(?:[12]>&(?!1)|2>>?[^\s;&|]+|&>)/),
  },
  {
    id: 'powershell-env',
    detail: '`$env:NAME` is PowerShell. Nushell writes `$env.NAME` — read `$env.NAME`, optional read `$env.NAME?`, assign `$env.NAME = "value"`.',
    find: (view) => matchFragment(view, /\$env:[A-Za-z_]/),
  },
  {
    id: 'array-literal',
    detail: '`@( … )` is a PowerShell array. A Nushell list is `[1 2 3]` or `["a" "b"]` — spaces or newlines separate items, and commas are not separators.',
    find: (view) => matchFragment(view, /(?:^|[\s(,=])@\(/),
  },
  {
    id: 'cmd-substitution',
    detail: '`$( … )` is bash command substitution (and a Nushell parse error). A Nushell subexpression is `( … )`: `let v = (open --raw f | lines | length)`; interpolation is `$"text (expr)"`.',
    find: (view) => matchFragment(view, /\$\(/),
  },
  {
    id: 'foreach-keyword',
    detail: '`foreach` is PowerShell. Nushell loops are `for x in [1 2 3] { … }` (`for x in (glob *.txt) { … }` over files).',
    find: (view) => matchFragment(view, /\bforeach\b/i),
  },
  {
    id: 'and-or-operators',
    detail: '`&&` and `||` are not Nushell operators (they are parse errors). Put the statements on separate lines or join them with `;`; boolean logic uses `and` / `or`.',
    find: (view) => matchFragment(view, /&&|\|\|/),
  },
  {
    id: 'export-assignment',
    detail: '`export VAR=1` is bash. Set an environment variable with `$env.VAR = "1"`, or scope it to one call with `with-env { VAR: "1" } { … }`.',
    find: (view) => matchFragment(view, /\bexport\s+[A-Za-z_][A-Za-z0-9_]*\s*=/),
  },
  {
    id: 'exit-status-sigil',
    detail: '`$?` is bash. The exit status is `(do { cmd } | complete).exit_code` (or `$env.LAST_EXIT_CODE?` right after an external command).',
    find: (view) => matchFragment(view, /\$\?/),
  },
  {
    id: 'powershell-current-item',
    detail: '`$_` / `$PSItem` are PowerShell. Inside a Nushell closure the implicit input is `$in`, and naming the closure parameter is clearer: `each { |row| … }`, `where { |row| $row.size > 1kb }`.',
    find: (view) => matchFragment(view, /\$_|\$PSItem\b/),
  },
  {
    id: 'powershell-not-operator',
    detail: '`-not` is PowerShell. Nushell negates with `not`: `if not ($p | path exists) { … }`.',
    find: (view) => matchFragment(view, /(?:^|[\s(])-not\b/i),
  },
  {
    id: 'deprecated-flags',
    detail: 'A renamed Nushell flag: `select -First 20` → `first 20`, `select -Last 20` → `last 20`, `select -Unique` → `uniq`, `select -Skip 2` → `skip 2`. A flag Nushell only *warns* about (`get -i`, `str downcase`, `str upcase`) is deliberately not refused — it still runs, and the hint below the output names the replacement.',
    find: (view) => matchFragment(view, /\bselect\s+-(?:First|Last|Unique|Skip)\b/),
  },
  {
    id: 'mkdir-parents',
    detail: '`mkdir -p` is a bash flag. Nushell `mkdir a/b/c` always creates the parents; drop the flag.',
    find: (view) => matchFragment(view, /\bmkdir\s+(?:-p|--parents)\b/),
  },
  {
    id: 'recursive-ls',
    detail: '`ls -R` has no Nushell equivalent flag. Recurse with a glob: `ls **/*.md`, `glob **/*.rs`, or bound the walk with `glob --depth 3`.',
    find: (view) => matchFragment(view, /\bls\s+(?:-R|--recursive)\b/),
  },
  {
    id: 'comma-columns',
    detail: 'A comma is not a column separator in Nushell: `select name, type` asks for one column literally named `name,` (and `nu::shell::name_not_found` is the error it produces). Separate the columns with spaces or newlines: `select name type`. A *list literal* does take commas (`[1, 2] | length` is 2).',
    find: (view) => matchFragment(view, /(?:^|[\s|(])(?:select|get|reject|drop|keep|rename|move|sort-by|group-by)\s+(?:[^\s,;|(){}]+\s+)*[^\s,;|(){}]+\s*,\s*[^\s,;|(){}]+/),
  },
  {
    id: 'powershell-parameter',
    detail: 'That is a PowerShell common parameter, not a Nushell flag (Nushell rejects it as an unknown flag). Drop it: a failure is already reported on stderr, `rm -f` / `cp -f` take `-f`, `ls` has `--all` / `--long`, and recursion is a glob (`glob **/*`).',
    find: (view) => matchFragment(view, /(?:^|[\s|(])-(?:ErrorAction|ErrorVariable|WarningAction|Recurse|LiteralPath|Filter|Confirm|Force)\b/i),
  },
  {
    id: 'negative-count',
    detail: '`first -3` / `last -3` are PowerShell counts (`Select-Object -Last 20`), and Nushell requires a positive value (`nu::shell::needs_positive_value`). Take the last rows with `last 3` — pipe through `reverse | first 3` only when you need them re-ordered.',
    find: (view) => matchFragment(view, /\b(?:first|last)\s+-\d/),
  },
  {
    id: 'percent-sigil',
    detail: '`%{ … }` is PowerShell\'s ForEach-Object shorthand, never a Nushell command. Use `| each { |item| … }` (every item in turn), or `for x in $xs { … }` for a loop.',
    find: (view) => matchFragment(view, /(?:^|[\s|(])%\{/),
  },
  {
    id: 'pipe-redirect',
    detail: 'A redirection cannot be a pipeline stage: `cmd | o> out.txt` redirects nothing (`nu::parser::unexpected_redirection`). The redirection ends the command that produced the value: `cmd o> out.txt`, then read the file; to keep a value in the pipeline instead, `cmd | complete`.',
    find: (view) => matchFragment(view, /\|\s*(?:o\+e>|out\+err>|o>|out>|e>|err>)/),
  },
]

/** Statement-level habits: the program token names the foreign tool or cmdlet. */
const POWERSHELL_CMDLETS = new Map([
  ['get-content', '`open --raw <path>` (text) or `open <path>` (parsed json/toml/yaml/csv)'],
  ['set-content', '`<value> | save -f <path>`'],
  ['add-content', '`<value> | save --append <path>`'],
  ['get-childitem', '`ls` (a table: `name`, `type`, `size`, `modified`) or `glob <pattern>` for recursion'],
  ['get-item', '`ls <path> | get 0` or `<path> | path exists`'],
  ['test-path', '`<path> | path exists` (returns a bool)'],
  ['join-path', '`["a" "b"] | path join`'],
  ['split-path', '`path dirname` / `path basename` / `path expand`'],
  ['resolve-path', '`<path> | path expand`'],
  ['select-object', '`select <columns>`, `first 20`, `last 20`, or `get -o <column>`'],
  ['where-object', '`where { |row| … }` (e.g. `where { |f| $f.size > 1mb }`)'],
  ['foreach-object', '`each { |item| … }` (`$in` is the implicit item)'],
  ['sort-object', '`sort-by <column>` for tables, `sort` for plain lists'],
  ['group-object', '`group-by <column>`'],
  ['measure-object', '`length`, `math sum`, `math max`'],
  ['select-string', '`lines | where { |l| $l =~ "pattern" }`'],
  ['out-string', '`| to text` (or `| str join (char nl)`)'],
  ['out-file', '`| save -f <path>`'],
  ['write-output', '`print <value>`'],
  ['write-host', '`print <value>` (add `--no-newline` to suppress the newline)'],
  ['remove-item', '`rm <path>`, `rm -r <dir>`, `rm -f <path>`'],
  ['copy-item', '`cp <src> <dst>`'],
  ['move-item', '`mv <src> <dst>`'],
  ['new-item', '`touch <file>` or `mkdir <dir>` (parents are created automatically)'],
  ['get-command', '`which <name>` (returns a table)'],
  ['get-process', '`ps` (a table)'],
  ['stop-process', '`ps | where name =~ "x" | each { |p| kill $p.pid }`'],
  ['start-process', '`^program arg` runs the external directly; `run-external program arg` is the explicit form'],
  ['start-sleep', '`sleep 5sec` (`ms`, `sec`, `min`, `hr`, `day`)'],
  ['invoke-webrequest', '`http get <url>` (parsed) or `http get --full <url>` (status + body)'],
  ['invoke-restmethod', '`http get <url>` / `http post <url> <body>`'],
  ['convertto-json', '`| to json`'],
  ['convertfrom-json', '`| from json`'],
  ['convertto-csv', '`| to csv`'],
  ['convertfrom-csv', '`| from csv`'],
  ['get-windowsoptionalfeature', 'this is a Windows PowerShell cmdlet; run it through PowerShell only if you must (`^powershell -NoProfile -Command \'…\'`)'],
])

/**
 * Unix tools that are *not* Nushell builtins. On POSIX these exist as real
 * external programs (so a bare `grep` legitimately works inside Nushell), which
 * is why they are never refused: they only feed the `external_command` hint,
 * where "that program is not installed here" is the actual failure.
 */
const UNIX_TOOLS = new Map([
  ['grep', '`lines | where { |l| $l =~ "pattern" }`'],
  ['egrep', '`lines | where { |l| $l =~ "pattern" }`'],
  ['fgrep', '`lines | where { |l| $l =~ "pattern" }`'],
  ['rg', '`lines | where { |l| $l =~ "pattern" }` (or `glob` to find files)'],
  ['sed', '`str replace -r` / `str substring` / `lines | skip 9 | first 16`'],
  ['awk', '`parse` (named captures) or `split row` + `select`'],
  ['head', '`| first 20`'],
  ['tail', '`| last 20`'],
  ['cat', '`open --raw <path>`'],
  ['wc', '`| length` (`open --raw f | lines | length`)'],
  ['find', '`glob **/*.rs` (or `ls **/*`), filtered with `where`'],
  ['xargs', '`… | each { |item| … }`'],
  ['cut', '`split column " "` or `str substring 0..3`'],
  ['tr', '`str replace` / `str upcase`'],
  ['dirname', '`| path dirname`'],
  ['basename', '`| path basename`'],
])

/**
 * PowerShell cmdlets nested inside a subexpression or a closure. A cmdlet only
 * ever *heads* a statement when the model writes it at the top level, but the
 * observed form is usually nested — `print (Get-ChildItem -Recurse -Directory)`,
 * `each { |f| Get-Content $f }` — where the statement head is `print` or `each`
 * and the statement-level scan sees nothing. This scan looks at every command
 * position (start of input, after `;` `\n` `|` `&` `(` `{`) in the code view, so
 * quoted data stays invisible and `^program` keeps working as the escape hatch.
 * @param command - the Nushell source.
 * @returns the first nested PowerShell cmdlet, or undefined.
 */
function findNestedForeignProgram(command) {
  const view = codeView(command)
  for (const match of view.matchAll(/(?:^|[\n;|&({])\s*([A-Za-z_][A-Za-z0-9_.\\/-]*)/g)) {
    const token = match[1]
    const base = token.split(/[\\/]/).pop() ?? token
    const cmdlet = POWERSHELL_CMDLETS.get(base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, ''))
    if (cmdlet === undefined) continue
    return {
      id: 'powershell-cmdlet',
      offset: match.index + match[0].length - token.length,
      fragment: token,
      detail: `\`${token}\` is a PowerShell cmdlet, never a Nushell command. In Nushell: ${cmdlet}.`,
    }
  }
  return undefined
}

/**
 * Read-only names Nushell owns: rebinding them is an error, but not the
 * "you forgot `let`" error, so the preflight leaves them alone.
 */
const RESERVED_NAMES = new Set(['env', 'nu', 'in', 'it'])

/**
 * Foreign habits a preflight can refuse on any platform: PowerShell cmdlets (no
 * real program is ever named `Get-Content`), `glob` argument misuse, and the
 * bash `path?` reflex. Unix tools are deliberately absent — they are hint-only.
 * @param command - the Nushell source.
 * @returns the first finding, or undefined.
 */
function findForeignProgram(command) {
  let cursor = 0
  for (const statement of splitStatements(command)) {
    const start = command.indexOf(statement, cursor)
    cursor = start === -1 ? cursor : start + statement.length
    const trimmed = statement.trim()
    if (trimmed.length === 0) continue
    // A quoted first word is a string value (`"a=1" | str length`,
    // `"Get-Content" | str length`): the tokenizer drops the quotes, so without
    // this the string would be read as a program name.
    if (isQuotedHead(statement)) continue
    const tokens = tokenize(statement)
    const first = tokens[0]
    if (first === undefined) continue
    if (first.startsWith('^') || first.startsWith('&')) continue // an explicit external is the documented escape hatch
    const base = first.split(/[\\/]/).pop() ?? first
    const name = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
    const cmdlet = POWERSHELL_CMDLETS.get(name)
    if (cmdlet !== undefined) {
      return {
        id: 'powershell-cmdlet',
        offset: Math.max(start, 0),
        fragment: first,
        detail: `\`${first}\` is a PowerShell cmdlet, never a Nushell command. In Nushell: ${cmdlet}.`,
      }
    }
    if (name === 'glob') {
      const positional = tokens.slice(1).filter((token) => !token.startsWith('-'))
      const named = positional.find((token) => /^(?:pattern|path|depth)=/i.test(token))
      if (named !== undefined) {
        return {
          id: 'glob-named-arguments',
          offset: Math.max(start, 0),
          fragment: named,
          detail: '`glob` takes one positional pattern, not PowerShell-style `pattern=` / `path=` names: put the directory inside the pattern (`glob "D:/dir/**/*.rs"`) and bound the walk with `--depth N`.',
        }
      }
      if (positional.length > 1) {
        return {
          id: 'glob-extra-positional',
          offset: Math.max(start, 0),
          fragment: `${tokens[0]} ${tokens[1]} ${tokens[2] ?? ''}`.trim(),
          detail: '`glob` takes exactly one pattern: fold the directory into it (`glob "D:/dir/**/*.rs"`) and bound the walk with `--depth N`.',
        }
      }
    }
    if (name === 'ls' || name === 'open' || name === 'source' || name === 'cd') {
      const pathish = tokens.slice(1).find((token) => !token.startsWith('-') && /[\\/~][^ ]*\?$/.test(token))
      if (pathish !== undefined) {
        return {
          id: 'path-optional-suffix',
          offset: Math.max(start, 0),
          fragment: pathish,
          detail: `\`?\` is not a path wildcard — it is optional access for a possibly-missing environment variable or column (\`$env.NAME?\`). Test a path with \`<path> | path exists\` and list with \`glob <pattern>\` (an empty result is fine).`,
        }
      }
    }
  }
  return undefined
}

/**
 * The Unix tool a command starts with, when it is one this deployment is likely
 * to lack — used to make the `external_command` hint name the exact Nushell
 * replacement instead of listing possibilities.
 * @param command - the command that failed.
 * @returns the tool name and its Nushell equivalent, or undefined.
 */
export function findForeignToolName(command) {
  if (typeof command !== 'string') return undefined
  for (const statement of splitStatements(command)) {
    if (isQuotedHead(statement)) continue
    const tokens = tokenize(statement)
    const first = tokens[0]
    if (first === undefined || first.startsWith('^') || first.startsWith('&')) continue
    const base = first.split(/[\\/]/).pop() ?? first
    const name = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
    const replacement = UNIX_TOOLS.get(name)
    if (replacement !== undefined) return { name, replacement }
  }
  return undefined
}

/** Every `$name = …` that is not a declaration and not an environment write. */
function findBareAssignment(view, command) {
  const declared = new Set()
  for (const match of command.matchAll(/\b(?:let|mut)\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=/g)) declared.add(match[1])
  for (const match of view.matchAll(/\$([A-Za-z_][A-Za-z0-9_-]*)\s*=(?![=~])/g)) {
    const name = match[1]
    if (declared.has(name)) continue
    // Reserved read-only names (`$env`, `$nu`, `$in`) cannot be rebound, so
    // "use let" would be wrong guidance: leave them to Nushell's own error.
    if (RESERVED_NAMES.has(name)) continue
    return {
      id: 'bare-assignment',
      offset: match.index,
      fragment: match[0].trim(),
      detail: `\`$${name} = …\` is not a Nushell assignment. Bind with \`let ${name} = …\` (immutable) or \`mut ${name} = …\` (reassignable), and write the environment as \`$env.${name} = "value"\`. Every call is a fresh process, so bindings never persist between calls.`,
    }
  }
  return undefined
}

/** The `NAME=value cmd` prefix bash uses to run one command with an environment. */
function findPrefixAssignment(statement, offset) {
  if (isQuotedHead(statement)) return undefined
  const tokens = tokenize(statement)
  const first = tokens[0]
  if (first === undefined) return undefined
  if (!/^[A-Za-z_][A-Za-z0-9_]*=[^\s=]/.test(first)) return undefined
  return {
    id: 'prefix-assignment',
    offset,
    fragment: first,
    detail: `\`VAR=value cmd\` is bash. Nushell scopes one call with \`with-env { VAR: "value" } { cmd }\`, or sets it for the whole command with \`$env.VAR = "value"\` first.`,
  }
}

/** Locate a regex match and return it as a rule finding. */
function matchFragment(view, pattern) {
  const match = pattern.exec(view)
  if (match === null) return undefined
  return { offset: match.index, fragment: match[0].trim() }
}

/**
 * Find the first dialect habit in a command.
 * @param command - the Nushell source about to run.
 * @returns the finding (id, offset, fragment, detail), or undefined when clean.
 */
export function findDialectIssue(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  const view = codeView(command)
  const findings = []
  for (const rule of RULES) {
    const match = rule.find(view, command)
    if (match === undefined) continue
    findings.push({ id: rule.id, detail: rule.detail, offset: match.offset, fragment: match.fragment })
  }
  const assignment = findBareAssignment(view, command)
  if (assignment !== undefined) findings.push(assignment)
  let cursor = 0
  for (const statement of splitStatements(command)) {
    const start = command.indexOf(statement, cursor)
    cursor = start === -1 ? cursor : start + statement.length
    const prefix = findPrefixAssignment(statement, Math.max(start, 0))
    if (prefix !== undefined) findings.push(prefix)
  }
  const foreign = findForeignProgram(command)
  if (foreign !== undefined) findings.push(foreign)
  const nested = findNestedForeignProgram(command)
  if (nested !== undefined) findings.push(nested)
  if (findings.length === 0) return undefined
  findings.sort((a, b) => a.offset - b.offset)
  return findings[0]
}

/**
 * The model-facing refusal: names the habit, states what Nushell actually does
 * with the fragment, shows the Nushell spelling, and repeats the escape hatches.
 * It also quotes the offending command, because the model cannot re-read the
 * tool call it is being refused for.
 *
 * What the refusal must NOT say is that the command "fails at parse time":
 * `2>&1` does, but `2>$null` is happily lexed as an ordinary word, so the
 * command runs with an extra argument and no suppression at all. Each rule's
 * detail states the real failure mode instead.
 * @param issue - a finding from {@link findDialectIssue}.
 * @param command - the refused command, when the caller has it.
 * @returns the error message.
 */
export function dialectMessage(issue, command) {
  const excerpt = typeof command === 'string' && command.trim().length > 0
    ? `\nCommand: ${JSON.stringify(command.replace(/\s+/g, ' ').trim().slice(0, 180))}`
    : ''
  return [
    `Nushell-only shell: refusing a ${issue.id} command — commands run as \`nu --no-config-file -c\`, and bash/PowerShell syntax is not translated`,
    '',
    `Offending fragment: ${JSON.stringify(issue.fragment.slice(0, 200))}${excerpt}`,
    issue.detail,
    'Nothing else about the command is wrong: fix that one fragment and re-run it. If the fragment is data rather than syntax, quote it (`print "a && b"`, `open --raw "path with #"`); `^program` forces a real external binary; executor config `dialectLint: false` turns this check off.',
  ].join('\n')
}

/**
 * Throw unless the command is Nushell, or exempt by the whole-command allowlist.
 * @param command - the Nushell source about to run.
 * @param options - optional compiled allowlist patterns.
 * @throws Error describing the refusal when a dialect habit is found.
 */
export function assertNushellDialect(command, options = {}) {
  const allow = options.allow ?? []
  if (allow.length > 0 && allow.some((pattern) => pattern.test(command))) return
  const issue = findDialectIssue(command)
  if (issue !== undefined) throw new Error(dialectMessage(issue, command))
}

/**
 * The post-failure hints, keyed by the Nushell error a command produced. Order
 * matters: the first matching signature wins, so the specific ones come first.
 */
const HINTS = [
  {
    id: 'stderr-redirect',
    match: /nu::parser::shell_outerr|nu::parser::shell_err|The '2>&1' shell operation|The '2>' shell operation/,
    text: '`2>&1` / `2> file` is not Nushell. Redirect with `o>` (stdout), `e>` (stderr), or `o+e> out.txt` (both); to capture instead, `do { cmd } | complete` returns `{stdout, stderr, exit_code}`.',
  },
  {
    id: 'and-or',
    match: /nu::parser::shell_andand|nu::parser::shell_oror/,
    text: '`&&` and `||` are not Nushell: separate statements with `;` (or newlines), and use `and` / `or` for boolean logic.',
  },
  {
    id: 'bare-assignment',
    match: /nu::parser::variable_not_found|nu::parser::variable_not_valid/,
    text: 'Assignments need `let x = …` / `mut x = …` (a bare `$x = …` is invalid), `$(…)` is not a subexpression — use `(…)`, and loops are `for x in [...] { … }`, not `foreach`.',
  },
  {
    id: 'immutable-assignment',
    match: /nu::parser::assignment_requires_mutable_variable/,
    text: '`let` bindings are immutable: declare the variable with `mut x = …` when you intend to reassign it (`mut count = 0; $count = $count + 1`).',
  },
  {
    id: 'unknown-flag',
    match: /nu::parser::unknown_flag/,
    text: 'That flag does not exist: `ls -a` → `ls --all`, `ls -R` → `ls **/*` or `glob`, `mkdir -p` → `mkdir`, `select -First 20` → `first 20`, `head -n 40` → `first 40`. `<command> --help` lists the real flags.',
  },
  {
    id: 'deprecated-flag',
    match: /nu::parser::deprecated/,
    text: 'A renamed flag: `str downcase` → `str lowercase`, `str upcase` → `str uppercase`, `get -i` → `get -o` (`--optional`), `select -First N` → `first N`.',
  },
  {
    id: 'input-type',
    match: /nu::parser::input_type_mismatch|nu::shell::only_supports_this_input_type|nu::shell::unsupported_input|nu::shell::cant_convert/,
    text: 'Wrong input type (checked at parse time, so `try` cannot catch it): a string takes `str …` commands (`str substring 0..200`), a list takes `first`/`last`, and `$env` is a record — `$env | transpose key value | where key =~ "DSH"` (or read one variable directly).',
  },
  {
    id: 'column-not-found',
    match: /nu::shell::column_not_found/,
    text: 'Reading a column that is absent: use optional access (`$env.NAME?`, `$row.col?`), list the real ones with `columns`, or `get -o`. `$env.LAST_EXIT_CODE` only exists after an external command — use `(do { ^cmd } | complete).exit_code`.',
  },
  {
    id: 'path-not-found',
    match: /nu::shell::io::not_found|nu::shell::io::file_not_found|nu::shell::io::directory_not_found/,
    text: 'That path does not exist. Unlike bash, `ls`/`open` fail instead of printing an error: guard with `<path> | path exists`, list with `glob <pattern>` (an empty result is valid), or catch it with `try { … } catch { … }`.',
  },
  {
    id: 'glob-pattern',
    match: /error with glob pattern|no matches found/i,
    text: 'That pattern matched nothing (and `ls <glob>` treats that as an error). Use `glob <pattern>` — it returns an empty list — or widen the pattern (`glob "D:/dir/**/*.rs"`, `--depth N`).',
  },
  {
    id: 'incompatible-path-access',
    match: /nu::shell::incompatible_path_access/,
    text: 'A pipeline stage and `or` / `and` were mixed: `$l | str contains \'a\' or \'b\'` parses as one pipeline, so Nushell tries a cell path on the result. Wrap each comparison — `($l | str contains \'a\') or ($l | str contains \'b\')` — or use one regex: `$l =~ \'a|b\'`.',
  },
  {
    id: 'operator-types',
    match: /nu::(?:parser|shell)::operator_(?:unsupported_type|incompatible_types)/,
    text: 'Nushell does not coerce types for an operator: `\'a\' + 1`, `1 + [1 2]`, `$env + 1`, and `where size > \'a\'` all fail. Convert explicitly (`($x | into string) + \'a\'`, `[1 2] | math sum`, `$row.size > 1kb`) or interpolate (`$"($x) suffix"`).',
  },
  {
    id: 'name-not-found',
    match: /nu::shell::name_not_found/,
    text: 'A comma is not a separator in Nushell: `select name, type` asks for a column literally named `name,` (hence "did you mean \'name\'?"). Separate names with spaces or newlines — `select name type`, `get name size` — and `reject` / `drop` / `keep` / `sort-by` / `group-by` the same way.',
  },
  {
    id: 'pipeline-empty',
    match: /nu::shell::pipeline_mismatch/,
    text: 'A pipeline stage was given nothing to read: in Nushell a command consumes its pipeline input, so `str trim` / `where …` on its own has no input. Start from a value (`open --raw f | str trim`), or feed it explicitly (`$text | str trim`).',
  },
  {
    id: 'unexpected-redirection',
    match: /nu::parser::unexpected_redirection|expected redirection target/,
    text: 'A redirection ends the command that produced the value and needs a target: `cmd o> out.txt`, `cmd e> err.txt`, `cmd o+e> both.txt`. It is never a pipeline stage (`cmd | o> f` redirects nothing) — to keep a value in the pipeline, use `cmd | complete`.',
  },
  {
    id: 'percent-sigil',
    match: /percent sigil/,
    text: '`%{ … }` is PowerShell\'s ForEach-Object, which Nushell does not have: use `| each { |item| … }` to map a list, or `for x in $xs { … }` to loop.',
  },
  {
    id: 'needs-positive-value',
    match: /nu::shell::needs_positive_value/,
    text: 'Nushell counts are positive: `first 3` / `last 3`, never `first -3` (`Select-Object -Last 20` → `last 20`). To reverse the order too, `… | reverse | first 3`.',
  },
  {
    id: 'unknown-command',
    match: /nu::parser::unknown_command/,
    text: 'That is not a command here — usually a foreign sigil in command position: `@(1, 2)` is a PowerShell array (Nushell: `[1, 2]`), `%{ … }` is ForEach-Object (Nushell: `| each { |x| … }`), `foreach` / `until` are PowerShell keywords (Nushell: `for x in $xs { … }`).',
  },
  {
    id: 'record-colon',
    match: /nu::parser::assignment_requires_variable/,
    text: 'A Nushell record separates a key from its value with a colon: `{ name: "x", size: 1 }` — `{ name = "x" }` is an assignment and fails at parse time.',
  },
  {
    id: 'powershell-block',
    match: /nu::parser::keyword_missing_arg/,
    text: 'Nushell `for` takes a block, not a shell `do` / `then`: `for f in [1 2] { print $f }` (over files: `for f in (glob **/*.txt) { … }`).',
  },
  {
    id: 'cannot-pass-list-to-external',
    match: /nu::shell::cannot_pass_list_to_external/,
    text: 'A list is not spread into an external command\'s argv automatically: write the spread operator (`^prog ...$list`), or iterate — `$list | each { |item| ^prog $item }`.',
  },
  {
    id: 'is-a-directory',
    match: /nu::shell::io::is_a_directory/,
    text: 'That path is a directory and the command needed a file: list it (`ls <dir>`), find the file (`glob "<dir>/**/*"`), or open a file inside it (`open --raw <dir>/<file>`).',
  },
  {
    id: 'permission-denied',
    match: /nu::shell::io::permission_denied|os error 5/,
    text: 'Access was denied by the filesystem or the sandbox. Retry with a path inside the workspace, or raise the sandbox mode for this call (`sandbox_permissions`); a confined run cannot write outside the workspace.',
  },
  {
    id: 'http-error',
    match: /nu::shell::http_error|nu::shell::io::unexpected_eof/,
    text: 'The HTTP request did not succeed (offline/DNS/TLS, or a non-2xx status). `http get --full <url>` returns `{status, body}` without raising and `--allow-errors` keeps an error body; a bare `http get` raises `nu::shell::http_error` on 4xx/5xx.',
  },
  {
    id: 'external-command',
    match: /nu::shell::external_command/,
    text: 'That name is neither a Nushell builtin nor a known external program. Use the Nushell spelling (`grep` → `where { |l| $l =~ "x" }`, `cat` → `open --raw`, `head` → `first N`, `Get-Content` → `open --raw`, `Get-ChildItem` → `ls`), or `^program` to force a real external binary.',
  },
  {
    id: 'extra-positional',
    match: /nu::parser::extra_positional/,
    text: 'Too many positionals: `glob` takes one pattern — fold the directory in (`glob "D:/dir/**/*.rs"`) — and `each` takes one closure (`[1 2] | each { |n| $n * 2 }`), with the list arriving on the pipeline.',
  },
  {
    id: 'parse-mismatch',
    match: /nu::parser::parse_mismatch|nu::parser::unclosed_delimiter|nu::parser::unbalanced_delimiter|nu::parser::extra_token_after_closing_delimiter/,
    text: 'Parse mismatch near the caret: check quotes and balance. Regexes and Windows paths belong in single quotes (`\'\\d+\'`, `\'C:\\Users\\me\'`) because double quotes process `\\` escapes; interpolation is `$"text (expr)"`.',
  },
  {
    id: 'eval-block-with-input',
    match: /nu::shell::eval_block_with_input/,
    text: 'A closure failed on its pipeline input: inside `each` / `where` name the parameter (`{ |row| … }`) or use `$in`, and remember `where <col> …` for tables versus `where { |l| $l =~ "x" }` for text lines.',
  },
]

/**
 * One actionable line for a failed command, chosen by the Nushell error in its
 * stderr.
 * @param command - the command that ran.
 * @param stderr - the captured stderr text.
 * @param options - settled-process facts: `exitCode` and `stdout`, used for the
 *   silent-abort case, which prints no error text at all.
 * @returns the hint text, or undefined when nothing is known about this failure.
 */
export function dialectHint(command, stderr, options = {}) {
  if (typeof stderr !== 'string') return undefined
  if (stderr.length > 0 && (stderr.includes('nu::') || /no matches found/i.test(stderr))) {
    for (const hint of HINTS) {
      if (!hint.match.test(stderr)) continue
      let text = hint.text
      if (hint.id === 'external-command') {
        const tool = findForeignToolName(command)
        if (tool !== undefined) text = `\`${tool.name}\` is not available here. In Nushell: ${tool.replacement}. If the external program really is what you want, \`^${tool.name}\` forces it.`
      }
      const preflight = findDialectIssue(command)
      const extra = preflight !== undefined && preflight.id === hint.id
        ? ' (the preflight check also refuses this command, so it never ran)'
        : ''
      return `Nushell hint (${hint.id}): ${text}${extra}`
    }
    return undefined
  }
  // Silence with a non-zero status: Nushell aborts the command when an external
  // program exits non-zero, and prints nothing about it (verified on 0.115).
  const exitCode = options.exitCode
  const stdout = options.stdout ?? ''
  const quiet = stderr.trim().length === 0 && stdout.trim().length === 0
  if (quiet && typeof exitCode === 'number' && exitCode !== 0) {
    return 'Nushell hint (silent-exit): this call produced no output and exited non-zero. A failing external command aborts the rest of the command in Nushell, so nothing after it ran — use `| complete` to capture `{stdout, stderr, exit_code}` without failing, `do -i { … }` to ignore the failure, or `try { … } catch { … }` to handle it. Note that `nu -c` displays only the last statement\'s value, so `print` the intermediate results you need to see.'
  }
  return undefined
}

/** Rule ids this module can refuse, for docs and tests. */
export const DIALECT_RULE_IDS = [...RULES.map((rule) => rule.id), 'bare-assignment', 'prefix-assignment', 'powershell-cmdlet', 'glob-extra-positional', 'glob-named-arguments', 'path-optional-suffix']

/** Hint ids this module can emit, for docs and tests. */
export const DIALECT_HINT_IDS = HINTS.map((hint) => hint.id)
