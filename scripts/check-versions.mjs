#!/usr/bin/env node
/**
 * 版本一致性门禁（v2.3.1 引入）。
 *
 * 背景：v2.3.0 发布提交声称「版本号统一为 2.3.0（package.json / tauri.conf.json /
 * Cargo.toml / Cargo.lock）」，但 package-lock.json 仍是 2.2.1 且被漏在枚举之外，
 * 导致一个发布周期内版本源漂移无人发现。此脚本把「五处版本源」变成机器可验证的门禁。
 *
 * 用法：node scripts/check-versions.mjs   （不一致时 exit 1）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 统一换行符后再解析。
 * Windows runner 默认以 CRLF 检出（无 .gitattributes），而 Cargo.lock 的块匹配用的是字面 `\n`
 * —— v2.3.1 首次带门禁的 Windows 发布构建正是因此失败（macOS/Linux 不受影响）。
 * 这里在读入时归一化，保证门禁在三平台行为一致。
 */
const read = (rel) => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
const readJson = (rel) => JSON.parse(read(rel))

/** 从 Cargo.toml 的 [package] 段取 version（不误取 [dependencies] 里的版本） */
function cargoTomlVersion(source) {
  const pkg = /^\[package\][\s\S]*?(?=^\[|\Z)/m.exec(source)
  if (!pkg) throw new Error('src-tauri/Cargo.toml 未找到 [package] 段')
  const v = /^version\s*=\s*"([^"]+)"/m.exec(pkg[0])
  if (!v) throw new Error('src-tauri/Cargo.toml 的 [package] 段未找到 version')
  return v[1]
}

/** 从 Cargo.lock 取 name = "orgcompass" 的版本 */
function cargoLockVersion(source) {
  const block = /\[\[package\]\]\r?\nname = "orgcompass"\r?\nversion = "([^"]+)"/.exec(source)
  if (!block) throw new Error('src-tauri/Cargo.lock 未找到 orgcompass 包版本')
  return block[1]
}

const pkgJson = readJson('package.json')
const pkgLock = readJson('package-lock.json')

const sources = [
  ['package.json', pkgJson.version],
  ['package-lock.json (root)', pkgLock.version],
  ['package-lock.json (packages[""])', pkgLock.packages?.['']?.version],
  ['src-tauri/tauri.conf.json', readJson('src-tauri/tauri.conf.json').version],
  ['src-tauri/Cargo.toml', cargoTomlVersion(read('src-tauri/Cargo.toml'))],
  ['src-tauri/Cargo.lock', cargoLockVersion(read('src-tauri/Cargo.lock'))],
]

const expected = pkgJson.version
const mismatched = sources.filter(([, v]) => v !== expected)

const width = Math.max(...sources.map(([n]) => n.length))
for (const [name, version] of sources) {
  const mark = version === expected ? '✓' : '✗'
  console.log(`${mark} ${name.padEnd(width)}  ${version}`)
}

if (mismatched.length > 0) {
  console.error(
    `\n版本不一致：以 package.json 的 ${expected} 为准，以下来源不符：\n` +
      mismatched.map(([n, v]) => `  - ${n}: ${v}`).join('\n') +
      '\n\n修复：把所有版本源同步到 ' + expected + '（package-lock.json 用 npm install --package-lock-only 更新）。',
  )
  process.exit(1)
}

console.log(`\n版本一致：${expected}`)
