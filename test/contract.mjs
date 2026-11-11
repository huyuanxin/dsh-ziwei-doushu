/**
 * 契约一致性静态检查：
 *   Host 的 REMOTE_METHODS 与 Client 的 CONTRIBUTION.descriptors 必须逐位一致，
 *   且每个 descriptor 的 wire 名必须等于 Host 对应方法的形参名（request）。
 *
 * 这是 dsh-bid-workbench 踩过的坑：只登记一边 / wire 名写错，
 * 表现为「按钮点了没反应」，而且报错在 Gateway 层很难关联到具体方法。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const { REMOTE_METHODS } = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
const clientSrc = await fs.readFile(path.join(root, 'lib/client.js'), 'utf8')
const hostSrc = await fs.readFile(path.join(root, 'lib/index.js'), 'utf8')

// 从 client.js 抽出 desc('name', 'wire') 序列
const descRe = /desc\(\s*'([A-Za-z0-9_]+)'\s*(?:,\s*'([A-Za-z0-9_]+)')?\s*\)/g
const clientDescs = []
for (const m of clientSrc.matchAll(descRe)) {
  clientDescs.push({ method: m[1], wire: m[2] ?? null })
}

assert.equal(clientDescs.length, REMOTE_METHODS.length,
  `descriptor 数量 ${clientDescs.length} ≠ REMOTE_METHODS ${REMOTE_METHODS.length}`)

for (let i = 0; i < REMOTE_METHODS.length; i++) {
  assert.equal(clientDescs[i].method, REMOTE_METHODS[i],
    `第 ${i + 1} 位方法名不一致：client=${clientDescs[i].method} host=${REMOTE_METHODS[i]}`)

  // Host 侧对应方法的形参名（统一约定为 request；diagnostics 无参）
  const methodName = REMOTE_METHODS[i]
  // 只匹配「方法定义」（行首缩进 + 类体内），不匹配别处的方法调用。
  // diagnostics() 是同步方法，其余是 async；两种签名都要认。
  const re = new RegExp(`^\\s{2}(?:async\\s+)?${methodName}\\s*\\(([^)]*)\\)\\s*\\{`, 'm')
  const sig = hostSrc.match(re)
  assert.ok(sig, `Host 找不到方法 ${methodName} 的签名`)
  const paramName = sig[1].trim()
  if (paramName === '') {
    assert.equal(clientDescs[i].wire, null, `${methodName} 无参，client 不该传 wire`)
  } else {
    assert.equal(paramName, 'request', `${methodName} 形参应叫 request，实际是 ${paramName}`)
    assert.equal(clientDescs[i].wire, paramName,
      `${methodName} 的 wire 名 ${clientDescs[i].wire} ≠ 形参名 ${paramName}`)
  }
}

// CONTRIBUTION 的 package / namespace / service / PANEL_ID 与 Host 对齐
assert.match(clientSrc, /package:\s*'dsh-ziweidoushu'/)
assert.match(clientSrc, /namespace:\s*'ziwei'/)
assert.match(clientSrc, /service:\s*'ziweiWorkbench'/)
assert.match(clientSrc, /PANEL_ID\s*=\s*'ziwei'/)
assert.match(clientSrc, /id:\s*`dsh-ziweidoushu#ziwei\//)
assert.match(hostSrc, /namespace:\s*'ziwei'/)
assert.match(hostSrc, /ctx\.provide\('ziweiWorkbench'\)/)

// client.js 不能含 import/export（它是浏览器模块表直接加载的脚本）
assert.ok(!/^\s*(import|export)\s/m.test(clientSrc), 'client.js 不能含 import/export 语句')
assert.match(clientSrc, /window\.__ModuleLoader__\.load\(/)
assert.match(clientSrc, /require\('react'\)/)

console.log(`契约检查通过：${REMOTE_METHODS.length} 个端点逐位一致，wire 名与形参名匹配。`)
