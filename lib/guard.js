/**
 * The "only Nushell" guard: refuse a command that hands execution to another
 * shell.
 *
 * Replacing the `ctx.shell` provider already means *the harness* only ever runs
 * Nushell. This guard closes the remaining escape hatch the model controls: a
 * Nushell command that immediately delegates to `bash`, `sh`, `cmd`, `pwsh`,
 * or `wsl` would silently run a foreign shell again, and the model would get a
 * confusing dialect error instead of a rule it can follow.
 *
 * The detector is deliberately narrow: it looks at the first word of every
 * statement in the command (statements being `;`, newline, `|`, `&`, and
 * `&&`/`||` separated), after skipping command wrappers (`sudo`, `env`,
 * `busybox`, …) and `NAME=value` prefixes, and after skipping a statement whose
 * first word is quoted (that word is data — see {@link isQuotedHead}). A foreign
 * shell named anywhere else — as an argument to a program that is not a shell,
 * inside a string, or after a nested `nu -c` — is not this guard's business.
 *
 * @module dsh-nushell-only/guard
 */

/** Shells a Nu-only deployment refuses to hand a command to (basename, lowercased, no extension). */
export const FOREIGN_SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'pdksh',
  'ash',
  'fish',
  'csh',
  'tcsh',
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'gitbash',
  'git-bash',
  // Niubash/winux shell family: this deployment must not hand off to it either.
  'niu',
  'niubash',
  'winuxsh',
  'winuxcmd',
])

/** Command wrappers skipped while looking for the real program of a statement. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
  'busybox',
  'xargs',
  'npx-run',
])

/** An assignment prefix (`FOO=bar`) is a wrapper too, never the program itself. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Compile the allowlist: whole-command regular expressions that override the
 * guard (for a deployment that genuinely needs one foreign-shell call site).
 * @param patterns - regex sources from the `foreignShellAllowlist` config.
 * @returns compiled expressions.
 * @throws Error when an entry is not a string or does not compile.
 */
export function compileForeignShellAllowlist(patterns) {
  if (patterns === undefined || patterns === null) return []
  if (!Array.isArray(patterns)) throw new Error('dsh-nushell-only: foreignShellAllowlist must be an array of regular expression strings')
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string') throw new Error('dsh-nushell-only: foreignShellAllowlist entries must be strings')
    try {
      return new RegExp(pattern)
    } catch (error) {
      throw new Error(`dsh-nushell-only: foreignShellAllowlist entry ${JSON.stringify(pattern)} is not a valid regular expression: ${String(error)}`)
    }
  })
}

/**
 * Characters that end a token, and therefore let a `#` open a comment. Nushell
 * opens a comment at a token boundary only: `;#c`, `{#c`, `(#c`, `[#c` and
 * `|#c` are comments (verified on 0.115.1), while `1;#c` is a comment and
 * `print 1#c` is the bare word `1#c` — and `(1)#c` is a parse error, not a
 * comment. Missing `;`/`{`/`(`/`[`/`|` here would refuse valid Nushell that
 * merely mentions a bash habit inside a trailing comment.
 */
const COMMENT_PRECEDERS = new Set([';', '{', '(', '[', '|'])

/**
 * Whether the `#` at this offset opens a comment rather than continuing a word.
 * @param command - the Nushell source.
 * @param index - offset of the `#`.
 * @returns true when Nushell would start a comment here.
 */
export function startsComment(command, index) {
  if (index <= 0) return true
  const previous = command[index - 1] ?? ''
  return /\s/.test(previous) || COMMENT_PRECEDERS.has(previous)
}

/**
 * The end offset of a Nushell raw string opening at this offset (`r#'…'#`, with
 * any number of `#`), or undefined when this is not a raw string. Raw strings
 * are literal: an apostrophe inside one must not desynchronise the scanner, or
 * `print r#'don't; sh -c x'#` looks like a handoff to `sh`.
 * @param command - the Nushell source.
 * @param index - candidate offset of the `r`.
 * @returns the offset just past the raw string, or undefined.
 */
export function rawStringEnd(command, index) {
  const char = command[index]
  if ((char !== 'r' && char !== 'R') || command[index + 1] !== '#') return undefined
  let hashes = 0
  let cursor = index + 1
  while (command[cursor] === '#') {
    hashes++
    cursor++
  }
  const quote = command[cursor]
  if (quote !== "'" && quote !== '"') return undefined
  const terminator = `${quote}${'#'.repeat(hashes)}`
  const end = command.indexOf(terminator, cursor + 1)
  return end === -1 ? command.length : end + terminator.length
}

/**
 * Whether the `|` at this offset opens a closure parameter list — `{ |a, b| … }`
 * — rather than separating pipeline stages. A closure parameter may be named
 * `sh`, `cmd`, `bash` or `wsl`, so splitting on it made `[1 2] | each { |sh| $sh }`
 * look like a handoff to `sh`, and `['git' 'node'] | each { |cmd| ^$cmd --version }`
 * look like a handoff to `cmd`.
 * @param command - the Nushell source.
 * @param index - offset of the `|`.
 * @returns true when this bar opens a closure parameter list.
 */
function opensClosureParams(command, index) {
  let back = index - 1
  while (back >= 0 && /\s/.test(command[back] ?? '')) back--
  if (back < 0 || command[back] !== '{') return false
  return /^\s*[A-Za-z_][A-Za-z0-9_-]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_-]*)*\s*\|/.test(command.slice(index + 1))
}

/**
 * Split a command into statement segments, honoring single/double quotes, raw
 * strings, backticks, `#` comments, and closure parameter lists — so separators
 * inside any of those do not split.
 * @param command - the Nushell source.
 * @returns one string per statement.
 */
export function splitStatements(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        current += char
        index++
        current += command[index] ?? ''
        continue
      }
      current += char
      if (char === quote) quote = null
      continue
    }
    const raw = rawStringEnd(command, index)
    if (raw !== undefined) {
      current += command.slice(index, raw)
      index = raw - 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      current += char
      continue
    }
    if (char === '#' && startsComment(command, index)) {
      segments.push(current)
      current = ''
      while (index < command.length && command[index] !== '\n') index++
      continue
    }
    if (char === '|' && opensClosureParams(command, index)) {
      const close = command.indexOf('|', index + 1)
      const stop = close === -1 ? command.length : close + 1
      current += command.slice(index, stop)
      index = stop - 1
      continue
    }
    // `&` is a bare-word character (`print a&sh` prints `a&sh`); it separates
    // statements only when it stands alone.
    if (char === ';' || char === '\n' || char === '|' || (char === '&' && (index === 0 || /\s/.test(command[index - 1] ?? ' ')))) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Read the whitespace-separated tokens of one statement, keeping quoted runs
 * together and dropping the quotes.
 * @param text - one statement segment.
 * @returns the token list.
 */
export function tokenize(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++
    if (index >= text.length) break
    const quote = text[index] === "'" || text[index] === '"' || text[index] === '`' ? text[index] : null
    if (quote !== null) {
      index++
      let token = ''
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\' && quote === '"') {
          token += text[index]
          index++
        }
        token += text[index] ?? ''
        index++
      }
      index++
      tokens.push(token)
      continue
    }
    let token = ''
    while (index < text.length && !/\s/.test(text[index])) {
      token += text[index]
      index++
    }
    tokens.push(token)
  }
  return tokens
}

/** Drop the Nu external-command sigils from a token. */
function stripSigil(token) {
  let value = token
  while (value.length > 0 && (value[0] === '^' || value[0] === '&' || value[0] === '\\')) value = value.slice(1)
  return value
}

/**
 * Whether a statement starts with a quoted word, which makes that word *data*
 * rather than the program: Nushell rejects a quoted command name outright
 * (`"git" --version` is `nu::parser::parse_mismatch`), while `"a=1" | str length`
 * and `'Test-Path' | str length` are ordinary pipelines over a string. The
 * tokenizer drops quotes to compare program names, so without this check a
 * quoted first word looks exactly like a bash `VAR=value` prefix, a PowerShell
 * cmdlet, or a shell handoff — and every one of those was a false refusal.
 * `^"C:\Program Files\x.exe"` is unaffected: it starts with the sigil.
 * @param statement - one statement segment.
 * @returns true when the statement's first word is quoted.
 */
export function isQuotedHead(statement) {
  const first = statement.trimStart()[0]
  return first === '"' || first === "'" || first === '`'
}

/** Basename of a program token, lowercased and extension-free (`C:\...\bash.exe` → `bash`). */
export function programName(token) {
  const cleaned = stripSigil(token).replace(/^["']|["']$/g, '')
  if (cleaned.length === 0) return ''
  const base = cleaned.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

/**
 * Find the first statement that hands execution to a foreign shell.
 * @param command - the Nushell source.
 * @returns the offending shell name, the statement, and the raw token, or undefined.
 */
export function findForeignShellHandoff(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  const statements = splitStatements(command)
  for (const statement of statements) {
    if (isQuotedHead(statement)) continue
    const tokens = tokenize(statement)
    let index = 0
    for (let wrapper = 0; wrapper <= 4 && index < tokens.length; wrapper++) {
      const token = tokens[index]
      if (programName(token) === '' || ASSIGNMENT.test(token)) {
        index++
        continue
      }
      if (WRAPPERS.has(programName(token))) {
        index++
        continue
      }
      break
    }
    const token = tokens[index]
    if (token === undefined) continue
    const name = programName(token)
    if (FOREIGN_SHELLS.has(name)) return { shell: name, statement: statement.trim(), token }
  }
  return undefined
}

/**
 * The model-facing refusal: names the shell, states the rule, and shows the
 * Nushell way, because a dead end without a translation teaches nothing.
 * @param handoff - the detected handoff.
 * @returns the error message.
 */
export function handoffMessage(handoff) {
  return [
    `Nushell-only shell: refusing to hand this command to \`${handoff.shell}\``,
    '',
    'This deployment runs every shell command through Nushell (`nu --no-config-file -c`), and there is no fallback shell. Write the command in Nushell syntax.',
    'Translations: `echo hi` → `print "hi"`; `ls -la` → `ls --all --long`; `cat f | grep x` → `open --raw f | lines | where { |l| $l =~ "x" }`; `cmd1 && cmd2` → `cmd1; cmd2`; `$VAR` → `$env.VAR`; `a > f` → `a o> f`.',
    `Offending statement: ${JSON.stringify(handoff.statement.slice(0, 200))}`,
    '',
    'If a foreign shell is genuinely required for one call site, ask the user to relax the guard (executor config `enforceNushellOnly: false` or `foreignShellAllowlist`).',
  ].join('\n')
}

/**
 * Throw unless the command is pure Nushell. Infrastructure failures are thrown,
 * never rendered as command output, so the caller sees the rule rather than a
 * Nushell parse error two steps later.
 * @param command - the Nushell source about to run.
 * @param options - compiled allowlist patterns.
 * @throws Error describing the refusal when a foreign-shell handoff is found.
 */
export function assertNushellOnly(command, options = {}) {
  const allow = options.allow ?? []
  if (allow.length > 0 && allow.some((pattern) => pattern.test(command))) return
  const handoff = findForeignShellHandoff(command)
  if (handoff !== undefined) throw new Error(handoffMessage(handoff))
}
