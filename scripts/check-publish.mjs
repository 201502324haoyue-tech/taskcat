import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 默认检查 Git 索引中的实际内容；--candidates 用于首次暂存前检查候选文件。
const cwd = fileURLToPath(new URL('../', import.meta.url))
const candidates = process.argv.includes('--candidates')
const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
const paths = [...new Set(git('ls-files', '-z', '--cached',
  ...(candidates ? ['--others', '--exclude-standard'] : [])).toString('utf8').split('\0').filter(Boolean))]
if (!paths.length) {
  console.error('没有待检查的文件，请先暂存或使用 --candidates。')
  process.exit(1)
}
const issues = []
const allowedScripts = new Set(['taskcat-server.py', 'requirements.txt', 'check-publish.mjs'])
const secretRules = [
  ['疑似私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['疑似访问密钥', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
  ['疑似 JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['疑似硬编码凭证', /(?:api[_-]?key|app[_-]?secret|access[_-]?token|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{20,}["']/i],
  ['个人飞书标识', /\b(?:ou|oc)_[a-f0-9]{24,}\b/],
  ['个人目录路径', /[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[\w.-]+/i],
]
for (const path of paths) {
  const forbidden = /(^|\/)(node_modules|target|dist|build|\.gradle|__pycache__|\.idea|\.vscode)(\/|$)/.test(path)
    || /(?:\.env(?:\..*)?|local\.properties)$/.test(path) && path !== '.env.example'
    || /\.(?:db(?:-.*)?|sqlite3?(?:-.*)?|log|exe|apk|aab|msi|zip|7z|pem|key|pfx|p12|jks|keystore|pyc|tmp)$/i.test(path)
    || /\.(?:credentials|cookies)\.json$/i.test(path)
    || path.startsWith('android/app/src/main/assets/')
    || path.startsWith('.tools/')
    || path.startsWith('scripts/') && !allowedScripts.has(path.slice(8))
  if (forbidden) issues.push(`${path}：不应入库的路径`)
  let data
  try {
    data = candidates ? readFileSync(new URL('../' + path, import.meta.url)) : git('show', ':' + path)
  } catch {
    issues.push(`${path}：无法读取待交付内容`)
    continue
  }
  if (data.length > 5 * 1024 * 1024) issues.push(`${path}：超过 5 MiB，请单独确认产物归属`)
  if (/\.(png|ico|icns|jar)$/i.test(path)) continue
  if (data.includes(0)) {
    issues.push(`${path}：未确认的二进制文件`)
    continue
  }
  const lines = data.toString('utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const [label, pattern] of secretRules) {
      if (pattern.test(lines[i])) issues.push(`${path}:${i + 1}：${label}`)
    }
  }
}
if (issues.length) {
  console.error('入库检查未通过（仅列位置，不显示敏感值）：\n' + issues.join('\n'))
  process.exit(1)
}
console.log(`入库基础检查通过：${paths.length} 个文件。此检查不替代人工核对和安全审查。`)
