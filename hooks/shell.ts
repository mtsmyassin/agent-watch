// Which files a shell command plainly writes, read as text and never run:
// redirects (`>`, `>>`, `2>`, `&>`), `tee`, PowerShell's `Out-File`,
// `Set-Content`, `Add-Content` and `Tee-Object`, and where `cp`/`copy`/
// `Copy-Item` and `mv`/`move`/`Move-Item` put things. Best effort: a target
// that cannot be read for sure (a variable, a glob, a command's output, a
// relative path after a `cd`) is left out, or kept by its name alone when
// only its folder is unsure. Every function here is pure.
import { lastFolder } from './roster'

/** How much of a command is read; a write past it is not seen. */
const SHELL_SCAN = 20_000

/** A file a command writes: its path as written, its name, and whether its folder can be judged. */
export type Target = { path: string; name: string; isFolderKnown: boolean }

/** A word of the command: its text, and where the last letter that was not literal sits (-1 for none). */
type Word = { kind: 'word'; text: string; unsureAt: number }
type Op = { kind: 'op'; text: string }
type Item = Word | Op

/** Where output goes nowhere: never a file. */
const SINKS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', 'nul', 'con', '$null'])

/** The operators that end one command and start another. */
const BREAKS: ReadonlySet<string> = new Set([';', '&', '&&', '||', '|', '|&', '\n', '(', ')', '{', '}'])

/** Letters that make a word not literal outside quotes: variables, globs, expansions, escapes. */
const UNSURE = new Set(['$', '`', '*', '?', '[', ']', '%', '{', '}', ','])

/**
 * The command cut into words and operators, quotes and escapes resolved.
 * Undefined when a quote is never closed: nothing in it can be read for sure.
 * A heredoc's body is not read: it is text, not commands.
 */
function lexed(command: string, isPowerShell: boolean): Item[] | undefined {
  const text = command.slice(0, SHELL_SCAN)
  const items: Item[] = []
  let word: Word | undefined
  let isHeredoc = false
  let at = 0

  const letter = (char: string, isSure: boolean): void => {
    word ??= { kind: 'word', text: '', unsureAt: -1 }
    word.text += char

    if (!isSure) {
      word.unsureAt = word.text.length - 1
    }
  }
  const end = (): void => {
    if (word !== undefined) {
      items.push(word)
      word = undefined
    }
  }
  const op = (value: string): void => {
    end()
    items.push({ kind: 'op', text: value })
  }

  while (at < text.length) {
    const char = text.charAt(at)
    const next = text.charAt(at + 1)

    if (char === '\n') {
      op('\n')

      // A heredoc's body follows its line: none of it is read.
      if (isHeredoc) {
        return items
      }

      at += 1
    } else if (char === ' ' || char === '\t' || char === '\r') {
      end()
      at += 1
    } else if (char === '#' && word === undefined) {
      // A comment runs to the line's end.
      const stop = text.indexOf('\n', at)

      at = stop === -1 ? text.length : stop
    } else if (char === "'") {
      const close = text.indexOf("'", at + 1)

      if (close === -1) {
        return undefined
      }

      for (const inside of text.slice(at + 1, close)) {
        letter(inside, true)
      }

      word ??= { kind: 'word', text: '', unsureAt: -1 }
      at = close + 1
    } else if (char === '"') {
      let index = at + 1

      word ??= { kind: 'word', text: '', unsureAt: -1 }

      while (index < text.length && text.charAt(index) !== '"') {
        const inside = text.charAt(index)

        if (!isPowerShell && inside === '\\' && '$`"\\'.includes(text.charAt(index + 1))) {
          letter(text.charAt(index + 1), false)
          index += 2
        } else {
          letter(inside, inside !== '$' && inside !== '`')
          index += 1
        }
      }

      if (index >= text.length) {
        return undefined
      }

      at = index + 1
    } else if ((char === '\\' && !isPowerShell) || (char === '`' && isPowerShell)) {
      // An escape: the next letter stands for itself, but a path written so is not sure.
      letter(next, false)
      at += 2
    } else if (char === ';' || char === '(' || char === ')') {
      op(char)
      at += 1
    } else if ((char === '{' || char === '}') && word === undefined && /^\s|^$/.test(text.slice(at + 1, at + 2))) {
      op(char)
      at += 1
    } else if (char === '|') {
      op(next === '|' || next === '&' ? `|${next}` : '|')
      at += next === '|' || next === '&' ? 2 : 1
    } else if (char === '&') {
      if (next === '&') {
        op('&&')
        at += 2
      } else if (next === '>') {
        const isAppend = text.charAt(at + 2) === '>'

        op(isAppend ? '>>' : '>')
        at += isAppend ? 3 : 2
      } else {
        op('&')
        at += 1
      }
    } else if (char === '<') {
      const run = text.slice(at, at + 3) === '<<<' ? '<<<' : next === '<' ? '<<' : '<'

      op(run)
      isHeredoc ||= run === '<<'
      at += run.length
    } else if (char === '>') {
      // `2>` and PowerShell's `*>`: the word before it was the stream, not a file.
      const stream = word as Word | undefined

      if (stream !== undefined && /^(?:\d|\*)$/.test(stream.text)) {
        word = undefined
      }

      end()

      if (next === '&') {
        // `>&2`, `2>&1`: a stream into another, no file.
        op('dup')
        at += 2

        while (/[\d-]/.test(text.charAt(at))) {
          at += 1
        }
      } else if (next === '>' || next === '|') {
        op(next === '>' ? '>>' : '>')
        at += 2
      } else {
        op('>')
        at += 1
      }
    } else {
      const isTilde = char === '~' && word === undefined

      letter(char, !UNSURE.has(char) && !isTilde)
      at += 1
    }
  }

  end()

  return items
}

/** True for a path that names its root: `/x`, `\x`, `C:\x`, `\\server`. */
const isRooted = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path)

/** True for a word that names a folder, so a file copied there keeps its own name. */
const isFolderLike = (path: string): boolean => /[\\/]$/.test(path) || ['.', '..'].includes(lastFolder(path))

/**
 * A word as a write target: its name must be sure; its folder is sure only
 * when no letter of it was unsure and, for a relative path, no `cd` came first.
 */
function targetOf(word: Word, isAfterCd: boolean): Target | undefined {
  const path = word.text
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(cut + 1)

  if (path === '' || SINKS.has(path.toLowerCase()) || name === '' || name === '.' || name === '..' || word.unsureAt > cut) {
    return undefined
  }

  return { path, name, isFolderKnown: word.unsureAt === -1 && !(isAfterCd && !isRooted(path)) }
}

/** Where a source lands in a folder: the folder joined with the source's own name. */
function into(folder: Word, source: Word, isPowerShell: boolean): Word | undefined {
  const name = lastFolder(source.text)
  const cut = Math.max(source.text.lastIndexOf('/'), source.text.lastIndexOf('\\'))

  if (source.unsureAt > cut || name === '' || name === '.' || name === '..') {
    return undefined
  }

  const glue = /[\\/]$/.test(folder.text) ? '' : isPowerShell ? '\\' : '/'

  return { kind: 'word', text: `${folder.text}${glue}${name}`, unsureAt: folder.unsureAt }
}

/** Where `cp`/`mv` put things: the last operand, or `-t`'s folder; a folder gets each source by name. */
function copied(args: readonly Word[], isPowerShell: boolean): Word[] {
  const operands: Word[] = []
  let folder: Word | undefined
  let isDone = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as Word

    if (!isDone && arg.text === '--') {
      isDone = true
    } else if (!isDone && /^-./.test(arg.text)) {
      if (arg.text === '-t' || arg.text === '--target-directory') {
        folder = args[index + 1]
        index += 1
      } else if (arg.text.startsWith('--target-directory=')) {
        const cut = '--target-directory='.length

        folder = { kind: 'word', text: arg.text.slice(cut), unsureAt: arg.unsureAt - cut }
      } else if (arg.text === '-S' || arg.text === '--suffix') {
        index += 1
      }
    } else {
      operands.push(arg)
    }
  }

  return landing(operands, folder, isPowerShell)
}

/** The words written by a copy or move of `sources` (all but the last operand) to `folder` or the last. */
function landing(operands: readonly Word[], folder: Word | undefined, isPowerShell: boolean): Word[] {
  if (folder !== undefined) {
    return operands.flatMap(source => into(folder, source, isPowerShell) ?? [])
  }

  if (operands.length < 2) {
    return []
  }

  const to = operands[operands.length - 1] as Word
  const sources = operands.slice(0, -1)

  return sources.length > 1 || isFolderLike(to.text)
    ? sources.flatMap(source => into(to, source, isPowerShell) ?? [])
    : [to]
}

/** A PowerShell command's parameters: those that take a value, the switches, and the order positionals bind in. */
type Cmdlet = { valued: readonly string[]; switches: readonly string[]; positional: readonly string[]; targets: readonly string[] }

const CONTENT: Cmdlet = {
  valued: ['Path', 'LiteralPath', 'Value', 'Encoding', 'Filter', 'Include', 'Exclude', 'Stream', 'Credential'],
  switches: ['Force', 'NoNewline', 'PassThru', 'WhatIf', 'Confirm', 'AsByteStream'],
  positional: ['Path', 'Value'],
  targets: ['Path', 'LiteralPath'],
}
const ITEM: Cmdlet = {
  valued: ['Path', 'LiteralPath', 'Destination', 'Filter', 'Include', 'Exclude', 'Credential', 'FromSession', 'ToSession'],
  switches: ['Container', 'Force', 'Recurse', 'PassThru', 'WhatIf', 'Confirm'],
  positional: ['Path', 'Destination'],
  targets: ['Destination'],
}
const CMDLETS: Readonly<Record<string, Cmdlet>> = {
  'out-file': {
    valued: ['FilePath', 'LiteralPath', 'Encoding', 'Width', 'InputObject'],
    switches: ['Append', 'Force', 'NoClobber', 'NoNewline', 'WhatIf', 'Confirm'],
    positional: ['FilePath', 'Encoding'],
    targets: ['FilePath', 'LiteralPath'],
  },
  'set-content': CONTENT,
  'add-content': CONTENT,
  'tee-object': {
    valued: ['FilePath', 'LiteralPath', 'Variable', 'InputObject', 'Encoding'],
    switches: ['Append'],
    positional: ['FilePath'],
    targets: ['FilePath', 'LiteralPath'],
  },
  'copy-item': ITEM,
  'move-item': ITEM,
}
/** PowerShell's own short names for those. */
const ALIASES: Readonly<Record<string, string>> = {
  tee: 'tee-object',
  copy: 'copy-item',
  cp: 'copy-item',
  cpi: 'copy-item',
  move: 'move-item',
  mv: 'move-item',
  mi: 'move-item',
}

/** A parameter's name from what was typed: whole, or a prefix only one name starts with. */
function paramOf(typed: string, cmdlet: Cmdlet): string | undefined {
  const lower = typed.toLowerCase()
  const names = [...cmdlet.valued, ...cmdlet.switches]
  const whole = names.find(name => name.toLowerCase() === lower)

  if (whole !== undefined) {
    return whole
  }

  const starts = names.filter(name => name.toLowerCase().startsWith(lower))

  return starts.length === 1 ? starts[0] : undefined
}

/**
 * The words a PowerShell cmdlet writes to, its arguments bound as PowerShell
 * binds them. Named targets always count; positional ones only while every
 * option before them is one this knows (an unknown one may take a value).
 */
function cmdletWrites(name: string, args: readonly Word[]): Word[] {
  const cmdlet = CMDLETS[name] as Cmdlet
  const named: Record<string, Word> = {}
  const positionals: Word[] = []
  let isMappable = true

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as Word
    const flag = /^-([A-Za-z][\w-]*)(?::(.*))?$/.exec(arg.text)

    if (flag === null) {
      positionals.push(arg)
      continue
    }

    const param = paramOf(flag[1] as string, cmdlet)

    if (param === undefined) {
      isMappable = false
    } else if (cmdlet.valued.includes(param)) {
      const glued = flag[2]
      const value: Word | undefined =
        glued === undefined
          ? args[(index += 1)]
          : { kind: 'word', text: glued, unsureAt: arg.unsureAt - (arg.text.length - glued.length) }

      if (value !== undefined) {
        named[param] = value
      }
    }
  }

  if (isMappable) {
    const open = cmdlet.positional.filter(param => named[param] === undefined)

    positionals.forEach((word, index) => {
      const param = open[index]

      if (param !== undefined) {
        named[param] = word
      }
    })
  }

  if (cmdlet === ITEM) {
    const destination = named.Destination
    const source = named.Path ?? named.LiteralPath

    if (destination === undefined) {
      return []
    }

    return source !== undefined && isFolderLike(destination.text)
      ? [into(destination, source, true) ?? []].flat()
      : [destination]
  }

  return cmdlet.targets.flatMap(param => (named[param] === undefined ? [] : [named[param] as Word]))
}

/** Commands that change the folder relative paths are read from. */
const MOVES: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'chdir', 'set-location', 'sl', 'push-location', 'pop-location'])
/** Words that only run the command after them. */
const PREFIXES: ReadonlySet<string> = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'env'])

/**
 * The files `command` plainly writes, as written, each with its name and
 * whether its folder can be judged. `isPowerShell` reads it as PowerShell
 * does (backslashes are letters, the backtick escapes, `cp` is `Copy-Item`);
 * otherwise as a POSIX shell does.
 */
export function writtenBy(command: string, isPowerShell: boolean): Target[] {
  const items = lexed(command, isPowerShell)

  if (items === undefined) {
    return []
  }

  const targets: Target[] = []
  let isAfterCd = false
  let args: Word[] = []
  let redirected: Word[] = []

  const close = (): void => {
    let words = args

    // Variables set for the command, and words that only run it, come first.
    while (words.length > 0) {
      const first = (words[0] as Word).text

      if ((!isPowerShell && /^[A-Za-z_]\w*=/.test(first)) || PREFIXES.has(first.toLowerCase())) {
        words = words.slice(1)
      } else {
        break
      }
    }

    const head = words[0]
    const name = head === undefined ? '' : lastFolder(head.text).toLowerCase().replace(/\.exe$/, '')
    const rest = words.slice(1)
    const cmdlet = isPowerShell ? (ALIASES[name] ?? name) : name
    let written: Word[] = [...redirected]

    if (head !== undefined && head.unsureAt === -1) {
      if (Object.prototype.hasOwnProperty.call(CMDLETS, cmdlet)) {
        written = [...written, ...cmdletWrites(cmdlet, rest)]
      } else if (name === 'tee') {
        written = [...written, ...rest.filter(word => !/^-/.test(word.text))]
      } else if (['cp', 'mv', 'copy', 'move'].includes(name)) {
        written = [...written, ...copied(rest, isPowerShell)]
      }
    }

    for (const word of written) {
      const target = targetOf(word, isAfterCd)

      if (target !== undefined) {
        targets.push(target)
      }
    }

    if (MOVES.has(name)) {
      isAfterCd = true
    }

    args = []
    redirected = []
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as Item

    if (item.kind === 'word') {
      args.push(item)
    } else if (BREAKS.has(item.text)) {
      close()
    } else if (item.text === '>' || item.text === '>>') {
      const next = items[index + 1]

      if (next?.kind === 'word') {
        redirected.push(next)
        index += 1
      }
    } else if (item.text === '<' || item.text === '<<' || item.text === '<<<') {
      // What is read from, or a heredoc's end word: not a write, and not an argument.
      index += items[index + 1]?.kind === 'word' ? 1 : 0
    }
  }

  close()

  return targets
}
