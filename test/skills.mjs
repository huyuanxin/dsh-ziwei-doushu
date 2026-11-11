/**
 * 技能包测试：SKILL.md 契约 + provider 行为 + 体积预算。
 *
 * 这里守的是四件事：
 *  1. SKILL.md 的 frontmatter 必须能被 DSH 的 skill-filesystem 接受
 *     （kebab-case name、非空 description、只有白名单键）。
 *  2. 技能包文件完整且干净（无站点残留、无空文件、索引与目录一致）。
 *  3. provider 返回的候选必须满足 @deepseek-ai/dsh-skill 的 validateCandidate
 *     契约：rank 是有限数字、source 是字符串、provider 名与注册名一致。
 *  4. resourceBase 必须是存在的目录，否则模型按相对路径读 reference 会失败。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++ }

/* ---------- 1. SKILL.md frontmatter 契约 ---------- */

const SKILL_MD = path.join(ROOT, 'skills', 'ziwei-doushu', 'SKILL.md')
ok(fs.existsSync(SKILL_MD), 'skills/ziwei-doushu/SKILL.md 必须存在')

const raw = fs.readFileSync(SKILL_MD, 'utf8')
ok(raw.startsWith('---\n'), 'SKILL.md 必须以 YAML frontmatter 开头')

const fmEnd = raw.indexOf('\n---\n', 4)
ok(fmEnd > 0, 'SKILL.md frontmatter 必须闭合')

const fmLines = raw.slice(4, fmEnd).split('\n')
const fm = {}
for (const line of fmLines) {
  const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
  ok(m, `frontmatter 每行必须是 key: value，问题行：${line}`)
  fm[m[1]] = m[2].trim()
}

// DSH 的 isSkillName：/^[a-z0-9]+(?:-[a-z0-9]+)*$/
ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name), `name 必须是 kebab-case，实际：${fm.name}`)
ok(typeof fm.description === 'string' && fm.description.length > 0, 'description 不能为空')
ok(fm.description.length <= 500, 'description 应 ≤500 字符（catalog 截断长度）')

// skill-filesystem 的 parseInvocationPolicy 只认这三个键（外加 name/description/whenToUse）
const ALLOWED_KEYS = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable'])
for (const k of Object.keys(fm)) ok(ALLOWED_KEYS.has(k), `frontmatter 出现非白名单键：${k}`)
// 旧的驼峰写法会被 parseInvocationPolicy 直接拒绝
ok(!('modelInvocable' in fm), '不得使用旧键 modelInvocable')
ok(!('disableModelInvocation' in fm), '不得使用旧键 disableModelInvocation')

/* ---------- 2. 正文无站点残留 ---------- */

const body = raw.slice(fmEnd + 5)
for (const [pat, label] of [
  [/<table/i, 'HTML 表格'],
  [/<Badge/i, 'Badge 组件'],
  [/^::: /m, 'VitePress 容器'],
  [/\]\(\.\//, '相对链接'],
  [/\]\(\.\.\//, '上级相对链接'],
  [/^!\[/m, '图片引用'],
]) {
  ok(!pat.test(body), `SKILL.md 正文不得残留${label}`)
}

// 索引里提到的每个 reference 都必须真实存在
const refs = [...body.matchAll(/`reference\/([\w-]+\.md)`/g)].map((m) => m[1])
ok(refs.length >= 9, `索引应列出至少 9 个 reference，实际 ${refs.length}`)
const refDir = path.join(ROOT, 'skills', 'ziwei-doushu', 'reference')
for (const r of new Set(refs)) {
  ok(fs.existsSync(path.join(refDir, r)), `索引引用的 reference/${r} 必须存在`)
}
// 反向：磁盘上每个 reference 都必须被索引收录，否则模型根本不知道它存在
const onDisk = fs.readdirSync(refDir).filter((f) => f.endsWith('.md')).sort()
const indexed = [...new Set(refs)].sort()
eq(indexed.join(','), onDisk.join(','), 'SKILL.md 索引必须与 reference/ 目录内容完全一致')

/* ---------- 3. 文件完整性 ---------- */

const SKILL_DIR = path.join(ROOT, 'skills', 'ziwei-doushu')
const allRefs = fs.readdirSync(refDir).filter((f) => f.endsWith('.md'))
ok(allRefs.length >= 11, `reference/ 应至少 11 篇，实际 ${allRefs.length}`)
for (const f of allRefs) {
  const txt = fs.readFileSync(path.join(refDir, f), 'utf8')
  ok(txt.trim().length > 0, `reference/${f} 不能为空`)
  ok(/^# /m.test(txt), `reference/${f} 必须有 H1 标题`)
  // 每个 reference 内部不应再有二级以上的站点残留
  ok(!/<table/i.test(txt), `reference/${f} 不得残留 HTML 表格`)
  ok(!/^::: /m.test(txt), `reference/${f} 不得残留 VitePress 容器`)
  ok(!/\]\(\.\//.test(txt), `reference/${f} 不得残留相对链接`)
}

/* ---------- 4. 体积预算 ---------- */

const cjkOf = (t) => (t.match(/[\u3400-\u9fff]/g) || []).length
// SKILL.md 是「加载技能」时的即时成本，必须保持轻量（千字级）。
const skillCjk = cjkOf(body)
ok(skillCjk < 2500, `SKILL.md 汉字数 ${skillCjk} 超过 2500，加载成本过高`)

const pkgBytes = [SKILL_MD, ...allRefs.map((f) => path.join(refDir, f))]
  .reduce((a, f) => a + fs.statSync(f).size, 0)
// 绝对预算：参考文件总字节不能失控（防止有人把整本古籍正文贴回来）。
// 当前约 200KB；给 400KB 上限，超了就说明「按需读取」的拆分被破坏了。
ok(pkgBytes < 400_000, `技能包总字节 ${pkgBytes} 超过 400KB，按需拆分可能已被破坏`)

/* ---------- 5. provider 契约 ---------- */

const skillsMod = await load('lib/skills.js')
ok(typeof skillsMod.PROVIDER_NAME === 'string' && skillsMod.PROVIDER_NAME.length > 0, 'PROVIDER_NAME 必须非空')
ok(skillsMod.skillsAvailable() === true, 'skillsAvailable() 必须为 true（产物已生成）')

const provider = skillsMod.createSkillProvider()
eq(provider.name, skillsMod.PROVIDER_NAME, 'provider.name 必须等于 PROVIDER_NAME')

const candidates = await provider.list()
ok(Array.isArray(candidates) && candidates.length === 1, `候选数应为 1，实际 ${candidates.length}`)

const cand = candidates[0]
// 逐条对应 dsh-skill 的 validateCandidate
ok(typeof cand.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cand.name), `候选 name 非法：${cand.name}`)
ok(typeof cand.description === 'string' && cand.description.length > 0, '候选 description 必须非空')
ok(typeof cand.source === 'string', '候选 source 必须是字符串')
ok(typeof cand.rank === 'number' && Number.isFinite(cand.rank), '候选 rank 必须是有限数字')
ok(cand.provider === provider.name, '候选 provider 必须与注册名一致')
ok(cand.invocation && typeof cand.invocation.modelInvocable === 'boolean', '候选必须带 invocation.modelInvocable')
ok(cand.invocation && typeof cand.invocation.userInvocable === 'boolean', '候选必须带 invocation.userInvocable')
ok(cand.resourceBase && cand.resourceBase.kind === 'directory', 'resourceBase 必须是 directory')
ok(fs.existsSync(cand.resourceBase.path), `resourceBase 指向的目录必须存在：${cand.resourceBase.path}`)
ok(fs.existsSync(path.join(cand.resourceBase.path, 'reference')), 'resourceBase 下必须有 reference/ 目录')

// rank 必须比官方 bundled(600) 小（否则用户看不到），比项目/用户(100~500)大
ok(cand.rank > 500 && cand.rank < 600, `rank 应在 (500,600) 区间，实际 ${cand.rank}`)

/* ---------- 6. provider.get ---------- */

const def = await provider.get(cand)
ok(def, 'provider.get 必须返回定义')
eq(def.name, cand.name, 'get 的 name 必须与候选一致')
eq(def.provider, cand.provider, 'get 的 provider 必须与候选一致')
ok(typeof def.content === 'string' && def.content.length > 0, 'get 必须返回非空正文')
ok(!def.content.startsWith('---'), 'get 返回的正文必须已剥离 frontmatter')
ok(def.content.includes('## 解盘八步'), '正文必须包含解盘八步')
ok(def.content.includes('## 参考资料索引'), '正文必须包含参考资料索引')

// 未知 locator 必须安全返回 undefined，而不是抛
eq(await provider.get({ locator: { dir: '../etc' } }), undefined, '非法 locator 必须返回 undefined')
eq(await provider.get({}), undefined, '缺 locator 必须返回 undefined')

/* ---------- 7. 缓存：内容未变时复用，改文件后立刻生效 ---------- */

const again = await provider.list()
eq(again.length, candidates.length, '重复 list 应返回同样数量的候选')
eq(again[0].name, candidates[0].name, '重复 list 的候选名应一致')
eq(again[0].description, candidates[0].description, '重复 list 的简介应一致')

{
  // 用临时 root 验证缓存失效语义：技能是手写维护的源文件，
  // 编辑后必须无需重载插件即可生效（不能永久缓存）。
  const tmp = path.join(ROOT, '.tmp-skill-cache')
  const docDir = path.join(tmp, 'ziwei-doushu')
  fs.mkdirSync(path.join(docDir, 'reference'), { recursive: true })
  fs.writeFileSync(path.join(docDir, 'reference', 'palaces.md'), '# 占位\n', 'utf8')

  const docPath = path.join(docDir, 'SKILL.md')
  const write = (desc) => fs.writeFileSync(docPath,
    `---\nname: ziwei-doushu\ndescription: ${desc}\n---\n\n# 正文\n\n${desc}\n`, 'utf8')

  write('第一版简介')
  const p1 = skillsMod.createSkillProvider(tmp)
  const c1 = await p1.list()
  eq(c1[0].description, '第一版简介', '首次 list 应读到磁盘内容')
  eq((await p1.get(c1[0])).content.includes('第一版简介'), true, '首次 get 应读到正文')

  // 立刻改写：mtime 分辨率可能不足 1ms，显式推后 10ms
  write('第二版简介')
  const later = new Date(Date.now() + 10_000)
  fs.utimesSync(docPath, later, later)

  const c2 = await p1.list()
  eq(c2[0].description, '第二版简介', '改文件后 list 必须读到新简介（缓存要失效）')
  eq((await p1.get(c2[0])).content.includes('第二版简介'), true, '改文件后 get 必须读到新正文')

  fs.rmSync(tmp, { recursive: true, force: true })
}

/* ---------- 8. registerSkills 的降级行为 ---------- */

eq(typeof skillsMod.registerSkills({}), 'function', '没有 skills 服务时应返回 no-op disposer')
let registered = 0
const fakeCtx = {
  skills: {
    registerProvider(create) {
      registered++
      const p = create()
      ok(typeof p.list === 'function' && typeof p.get === 'function', '注册的 provider 必须实现 list/get')
      return () => {}
    },
  },
}
const dispose = skillsMod.registerSkills(fakeCtx)
eq(registered, 1, 'registerSkills 必须调用一次 registerProvider')
eq(typeof dispose, 'function', 'registerSkills 必须返回 disposer')

/* ---------- 9. diagnostics 暴露技能状态 ---------- */

const mod = await load('lib/index.js')
const svc = new mod.ZiweiWorkbench(
  { get: () => null, provide() {}, set() {}, inject() {} },
  {
    '~standard': {
      validate: () => ({ value: { dataDir: path.join(ROOT, '.tmp-test-skill-diag'), language: 'zh-CN', fixLeap: true } }),
    },
  },
)
const diag = svc.diagnostics()
ok(diag.skills, 'diagnostics 必须带 skills 段')
eq(diag.skills.provider, skillsMod.PROVIDER_NAME, 'diagnostics.skills.provider 必须正确')
eq(diag.skills.available, true, 'diagnostics.skills.available 应为 true')

/* ---------- 10. 清掉测试数据目录 ---------- */

fs.rmSync(path.join(ROOT, '.tmp-test-skill-diag'), { recursive: true, force: true })

console.log(`skills: ${checks} assertions passed`)
