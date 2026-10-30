#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  process.exit(0)
}

const input = JSON.parse(await new Promise((res) => {
  let d = ''
  process.stdin.on('data', (c) => (d += c))
  process.stdin.on('end', () => res(d || '{}'))
}))

const tool = input.tool_name || ''
const cwd = input.cwd || process.cwd()
const WS = '/Users/stef/dev/productive/work/workspaces/'
const mySlug = cwd.startsWith(WS) ? cwd.slice(WS.length).split('/')[0] : null

const otherWorkspace = (text) => {
  if (!mySlug) return undefined
  const m = [...text.matchAll(/workspaces\/([a-z0-9][a-z0-9-]*)/g)].map((x) => x[1])
  return m.find((slug) => slug !== mySlug)
}

if (tool === 'Bash') {
  const cmd = input.tool_input?.command || ''

  if (/(^|[;&|(\n]\s*)(sed|awk)\s+(-\S+\s+)*(-\w*i|--in-place)\b/.test(cmd))
    block('sed -i / awk -i is a file write. Use the Edit tool (CLAUDE.md File Tools).')

  const heredocLine = cmd.split('\n').find((l) => /<<-?\s*'?"?(EOF|EOT|PY|JS|MD|SQL|RUBY|SH)\b/.test(l))
  if (heredocLine && /(>|>>)\s*\S/.test(heredocLine))
    block('Heredoc file write. Use the Write tool so directory CLAUDE.md rules load (CLAUDE.md File Tools).')

  if (/(^|[;&|(\n]\s*)tee\s|\|\s*tee\s/.test(cmd))
    block('tee writes a file. Use the Write tool (CLAUDE.md File Tools).')

  if (/(^|[;&|(\n]\s*)(perl|ruby)\s+(-\S+\s+)*(-\w*i|--in-place)\b/.test(cmd))
    block('perl/ruby -i is a file write. Use the Edit tool (CLAUDE.md File Tools).')

  if (/(^|[;&|(\n]\s*)(patch|ed)\s/.test(cmd))
    block('patch/ed writes a file. Use the Edit tool (CLAUDE.md File Tools).')

  if (/\bnode(\s+(-e|--eval|-p)\b|\s*(-\s+)?<<)/.test(cmd) &&
      /\b(writeFile|appendFile)/.test(cmd))
    block('inline node fs write. Use the Write/Edit tool (CLAUDE.md File Tools).')

  if (/\b(ruby|perl)\s+(-\S+\s+)*-e\b/.test(cmd) &&
      /\b(File|IO)\.(bin)?write\b|\bFile\.open\s*\([^)]*["'][wa]|\bopen\s*\(?\s*[^,()]+,\s*["']\+?>/.test(cmd))
    block('inline ruby/perl file write. Use the Write/Edit tool (CLAUDE.md File Tools).')

  const SAFE = /\/(private\/)?tmp\/|\/scratchpad\/|\/output\/|\/dev\/null/
  const SRC = /\.(rb|erb|jsx?|mjs|cjs|tsx?|jsonl?|ya?ml|md|css|scss|html|sh|sql)$/
  const targets = [...cmd.matchAll(/>>?\s*(?:["']([^"']+)["']|([^\s;&|>]+))/g)].map((m) => m[1] || m[2])
  const badTarget = targets.find((t) => t && SRC.test(t) && !SAFE.test(t))
  if (badTarget)
    block(`Bash write to ${badTarget}. Use the Write/Edit tool (CLAUDE.md File Tools).`)

  if (/(^|[;&|(\n]\s*)(python|python3)\b/.test(cmd))
    block('No python. Use node, plain shell, or the Write tool (AGENTS.md Helper Scripts).')

  if (/\.envrc/.test(cmd))
    block('.envrc may contain secrets — never read or edit it (AGENTS.md Secrets).')

  const repoWrite = /(>|>>)\s*[^\s|&]*\/work\/repos\//.test(cmd) ||
    (/\/work\/repos\//.test(cmd) && /git\s+(commit|checkout\s+-b|push|merge|rebase|reset)\b/.test(cmd))
  if (repoWrite)
    block('repos/ is read-only. Use a worktree for changes (AGENTS.md Repos).')

  const NO_WORKTREE = 'Generic worktrees are not used here. Work in the current workspace\'s app checkout ' +
    '(work/workspaces/<slug>/<app>), or create a new one with `workspaces new` (CLAUDE.md Workspace System).'

  if (/\/(work|dev)\/worktrees\b/.test(cmd) || /(^|[\s"'=])(\.\.\/)*worktrees(\/|[\s"';&|)]|$)/.test(cmd))
    block(NO_WORKTREE)

  const wtAdd = cmd.match(/\bgit\s+((?:-C\s+\S+\s+)?)worktree\s+add\s+([^;&|]*)/)
  if (wtAdd) {
    const args = wtAdd[2].trim().split(/\s+/)
    let wtPath
    for (let i = 0; i < args.length; i++) {
      if (['-b', '-B', '--reason'].includes(args[i])) { i++; continue }
      if (args[i].startsWith('-')) continue
      wtPath = args[i].replace(/^["']|["']$/g, '').replace(/^~/, '/Users/stef')
      break
    }
    if (wtPath) {
      const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+(?:["']([^"']+)["']|([^\s;&|]+))/)
      let base = cd ? path.resolve(cwd, (cd[1] || cd[2]).replace(/^~/, '/Users/stef')) : cwd
      const dashC = wtAdd[1].match(/-C\s+(\S+)/)
      if (dashC) base = path.resolve(base, dashC[1].replace(/^~/, '/Users/stef'))
      try { base = realpathSync(base) } catch {}
      let target = path.resolve(base, wtPath)
      let existing = target
      while (!existsSync(existing) && existing !== '/') existing = path.dirname(existing)
      target = path.join(realpathSync(existing), path.relative(existing, target))
      if (!target.startsWith(WS)) block(`git worktree add target ${target} is outside work/workspaces/. ${NO_WORKTREE}`)
    }
  }

  if (/\bgh\s+pr\b/.test(cmd) && /--assignee/.test(cmd))
    block('We never use GitHub assignees. Use --add-reviewer (CLAUDE.md Pull Requests).')

  if (/\bgit\b/.test(cmd)) {
    const other = otherWorkspace(cmd)
    if (other) block(`HARD BOUNDARY: no git ops inside workspace "${other}". Hand off with: factory message --job ${other} "<prompt>" (CLAUDE.md Workspace System).`)
  }

  if (/\bgit\s+push\b/.test(cmd)) {
    const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+(?:["']([^"']+)["']|([^\s;&|]+))/)
    const dir = cd ? (cd[1] || cd[2]).replace(/^~/, '/Users/stef') : cwd
    let root = ''
    try {
      root = execSync('git rev-parse --show-toplevel', {
        cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch { root = '' }
    const isWork = root ? root.startsWith('/Users/stef/dev/productive/') : true

    if (isWork) {
      let target = cmd.match(/git\s+push\s+(?:-\S+\s+)*\S+\s+(?:[^:\s]+:)?([^\s:]+)/)?.[1]
      if (!target) {
        try {
          target = execSync('git branch --show-current', {
            cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
          }).trim()
        } catch { target = '' }
      }
      if (['main', 'master', 'develop'].includes(target))
        block(`Refusing to push directly to ${target}. Branch and open a PR instead.`)
      if (!target && !root)
        block(`Cannot tell which repo or branch this push targets from "${dir}". Run it from inside the repo.`)
    }
  }
}

if (['Edit', 'Write', 'Read', 'NotebookEdit'].includes(tool)) {
  const fp = input.tool_input?.file_path || ''

  if (/\.envrc$/.test(fp))
    block('.envrc may contain secrets — never read or edit it (AGENTS.md Secrets).')

  if (tool !== 'Read' && /\.rubocop.*\.yml$/.test(fp) && !/\.rubocop-test-perf\.yml$/.test(fp))
    block('.rubocop*.yml is off-limits. Use an inline rubocop:disable comment instead.')

  if (tool !== 'Read') {
    const other = otherWorkspace(fp)
    if (other) block(`HARD BOUNDARY: no file writes inside workspace "${other}". Hand off with: factory message --job ${other} "<prompt>" (CLAUDE.md Workspace System).`)
  }
}
