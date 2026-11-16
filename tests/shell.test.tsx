import { expect, test } from 'claude-code/testing'

import { writtenBy } from '../hooks/shell'
import { notesOf, troubleOf } from '../hooks/trouble'
import type { Call } from '../types'

// Shell commands that write files, read as text and never run: which file a
// command plainly writes, and whether that is outside the project or a file
// that may hold secrets. What it cannot read for sure, it does not flag.

const T = 1_800_000_000_000
const SHOP = 'C:\\work\\shop'
const REPO = '/repo'

/** The paths a command writes, as written; `?name` for one whose folder is not sure. */
const bash = (command: string): string[] =>
  writtenBy(command, false).map(one => (one.isFolderKnown ? one.path : `?${one.name}`))
const pwsh = (command: string): string[] =>
  writtenBy(command, true).map(one => (one.isFolderKnown ? one.path : `?${one.name}`))

test('each listed form is read', () => {
  expect(bash('echo x > /tmp/a.txt')).toEqual(['/tmp/a.txt'])
  expect(bash('echo x >> "/tmp/b c.txt"')).toEqual(['/tmp/b c.txt'])
  expect(bash('make 2> /tmp/err.log')).toEqual(['/tmp/err.log'])
  expect(bash('make &> /tmp/all.log')).toEqual(['/tmp/all.log'])
  expect(bash('ls | tee -a /tmp/t.txt')).toEqual(['/tmp/t.txt'])
  expect(bash('cp a.py /tmp/b.py')).toEqual(['/tmp/b.py'])
  expect(bash('cp a.py b.py /tmp/')).toEqual(['/tmp/a.py', '/tmp/b.py'])
  expect(bash('cp -r -t /tmp a.py')).toEqual(['/tmp/a.py'])
  expect(bash('mv a.py ../b.py')).toEqual(['../b.py'])
  expect(bash('cp src/a.py ..')).toEqual(['../a.py'])
  expect(bash("sudo cp a.conf '/etc/app.conf'")).toEqual(['/etc/app.conf'])

  expect(pwsh('"x" >> C:\\x\\log.txt')).toEqual(['C:\\x\\log.txt'])
  expect(pwsh('Get-Date | Out-File -FilePath C:\\x\\o.txt')).toEqual(['C:\\x\\o.txt'])
  expect(pwsh('Get-Date | Out-File C:\\x\\o.txt -Append -Encoding utf8')).toEqual(['C:\\x\\o.txt'])
  expect(pwsh("Set-Content C:\\x\\s.txt 'v'")).toEqual(['C:\\x\\s.txt'])
  expect(pwsh('Add-Content -Path C:\\x\\a.txt -Value v')).toEqual(['C:\\x\\a.txt'])
  expect(pwsh("Set-Content -LiteralPath 'C:\\x\\l.txt' -Value v")).toEqual(['C:\\x\\l.txt'])
  expect(pwsh('copy a.py C:\\x\\')).toEqual(['C:\\x\\a.py'])
  expect(pwsh('Copy-Item a.py -Destination C:\\x\\b.py')).toEqual(['C:\\x\\b.py'])
  expect(pwsh('Copy-Item -Path a.py -Dest C:\\x\\b.py -Force')).toEqual(['C:\\x\\b.py'])
  expect(pwsh('Move-Item a b')).toEqual(['b'])
  expect(pwsh("'x' | tee C:\\x\\t.txt")).toEqual(['C:\\x\\t.txt'])
  expect(pwsh('Get-Date | Tee-Object -Variable d')).toEqual([])
})

test('reads and targets inside are not writes outside', () => {
  const shell = (tool: 'Bash' | 'PowerShell', command: string, cwd: string) => notesOf(tool, { command }, 'run', cwd).touch

  expect(bash('cat a.txt')).toEqual([])
  expect(pwsh('Get-Content C:\\x\\a.txt')).toEqual([])
  expect(pwsh('type C:\\x\\a.txt')).toEqual([])
  expect(shell('Bash', 'cat a > b.txt', REPO)).toBeUndefined()
  expect(shell('Bash', 'ls > /repo/files.txt', REPO)).toBeUndefined()
  expect(shell('Bash', 'cp x.py src/', REPO)).toBeUndefined()
  expect(shell('PowerShell', 'Set-Content C:\\Work\\Shop\\notes.txt "x"', SHOP)).toBeUndefined()
  expect(shell('PowerShell', 'Get-Content C:\\Users\\me\\elsewhere\\notes.txt', SHOP)).toBeUndefined()
})

test('what it cannot read for sure, it does not flag', () => {
  // The folder is not sure: only the name is left to judge.
  expect(bash('echo x > $HOME/x.txt')).toEqual(['?x.txt'])
  expect(bash('echo x > ${D}/a.txt')).toEqual(['?a.txt'])
  expect(bash('echo x > `pwd`/a.txt')).toEqual(['?a.txt'])
  expect(bash('echo x > ~/a.txt')).toEqual(['?a.txt'])
  expect(bash('cd /tmp && echo x > a.txt')).toEqual(['?a.txt'])
  expect(bash('cd /tmp && echo x > /repo/a.txt')).toEqual(['/repo/a.txt'])

  // Nothing sure at all.
  for (const command of [
    'echo x > "$OUT"',
    'echo x > /tmp/*.log',
    'make 2>&1',
    'echo x >&2',
    'echo x > /dev/null',
    'make 2> /dev/null',
    'bash -c "echo x > /etc/y"',
    'echo x > "/tmp/a.txt',
    'cp a.py',
  ]) {
    expect(bash(command)).toEqual([])
  }

  for (const command of ['Get-Date > $null', 'Get-Date > NUL', 'Out-File -Zork C:\\x\\o.txt', 'Set-Content $p "v"', 'Copy-Item a.py $dest']) {
    expect(pwsh(command)).toEqual([])
  }

  const shell = (command: string) => notesOf('Bash', { command }, 'run', REPO).touch

  expect(shell('echo x > $HOME/x.txt')).toBeUndefined()
  expect(shell('cd /tmp && echo x > a.txt')).toBeUndefined()
})

test('quotes and heredoc bodies are text, not writes', () => {
  expect(bash('echo "a > /etc/b"')).toEqual([])
  expect(bash("echo 'a > /etc/b'")).toEqual([])
  expect(bash("cat > /tmp/x <<'EOF'\necho y > /etc/z\nEOF")).toEqual(['/tmp/x'])
  expect(bash('grep -c ">" a.txt')).toEqual([])
  // A comment says nothing.
  expect(bash('ls # > /etc/z')).toEqual([])
})

test('a name that may hold secrets is judged even when its folder is not sure', () => {
  expect(notesOf('Bash', { command: 'echo k=v > $HOME/.env' }, 'run', REPO).touch).toEqual({
    file: '.env',
    secret: true,
    shell: true,
  })
  expect(notesOf('Bash', { command: 'echo k=v > .env.local' }, 'run', REPO).touch).toEqual({
    file: '.env.local',
    secret: true,
    shell: true,
  })
})

test('a shell write outside the folder is trouble, naming only the file', () => {
  const notes = notesOf('PowerShell', { command: "Set-Content C:\\Users\\me\\elsewhere\\notes.txt 'x'" }, 'run', SHOP)

  expect(notes.touch).toEqual({ file: 'notes.txt', outside: true, shell: true })
  expect(JSON.stringify(notes)).not.toContain('elsewhere')
  expect(notes.name).toBeUndefined()

  const call = (touch: NonNullable<Call['touch']>): Call => ({
    key: 'k1',
    doing: 'Running a command',
    did: 'Ran a command',
    at: T,
    end: T + 5,
    kind: 'run',
    touch,
  })

  expect(troubleOf([call({ file: 'notes.txt', outside: true, shell: true })], false)).toEqual([
    {
      sign: 'outside',
      evidence: 'Wrote outside this project with a command: notes.txt',
      advice: 'It wrote notes.txt outside this project with a command. Check that change before anything else.',
    },
  ])
  expect(troubleOf([call({ file: '.env', secret: true, shell: true })], false)[0]?.evidence).toBe(
    'Wrote a file that may hold secrets with a command: .env',
  )
  expect(troubleOf([call({ file: 'id_rsa', outside: true, secret: true, shell: true })], false)[0]?.evidence).toBe(
    'Wrote a file that may hold secrets, outside this project, with a command: id_rsa',
  )
  // A command that failed or was refused is not counted, as with the edit tools.
  expect(troubleOf([{ ...call({ file: 'notes.txt', outside: true, shell: true }), isFailed: true }], false)).toEqual([])
})

test('a very long command is read only so far, in bounded time', () => {
  const started = Date.now()

  expect(bash(`echo ${'a'.repeat(100_000)} > /tmp/x`)).toEqual([])
  expect(bash(`${'echo a; '.repeat(2000)}echo b > /tmp/y`)).toEqual(['/tmp/y'])
  expect(Date.now() - started).toBeLessThan(2000)
})
