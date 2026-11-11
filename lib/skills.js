/**
 * 紫微斗数技能包 — Host 半区的 SkillProvider。
 *
 * DSH 的 skill 机制分两层：`ctx.skills` 是注册表（@deepseek-ai/dsh-skill），
 * 具体来源由 provider 决定（本地目录 / 远程 / 插件内置）。
 * 本文件就是「插件内置」这一路的实现：把 `skills/ziwei-doushu/` 挂进
 * `ctx.skills`，让模型在需要解盘时按需 `skill` 加载，而不是写进每次分析的提示词。
 *
 * 为什么不用 `ctx.skills.register(skill)`（runtime 直接注册字符串）：
 *  · 那个 API 只接受单个 skill 定义，正文必须一次性内联；
 *  · 我们要的是「一个入口 + 一堆 reference 文件按需读」，需要 resourceBase，
 *    只有 provider 的 SkillDefinition 才带得动。
 *
 * 为什么要给 rank：
 *  `validateCandidate` 强制要求 rank 是有限数字，缺了会让整个 catalog 作废。
 *  优先级：项目(100/200) > 自定义(300) > 用户(400/500) > 本插件 > 官方 bundled(600)。
 *  取 550 让用户自己的 ~/.dsh/skills 能覆盖我们，但盖不过官方包。
 */

import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

/** provider 名，出现在 skill 的 `provider` 字段上。 */
export const PROVIDER_NAME = 'ziwei-doushu'

/** 比官方 bundled(600) 略高，让用户目录能覆盖我们。 */
const RANK = 550

/** 技能包根目录（`<pkg>/skills/`）。 */
const SKILLS_ROOT = new URL('../skills/', import.meta.url)

/** 技能名 → 目录，目录内必须有 SKILL.md。 */
const SKILL_DIRS = ['ziwei-doushu']

/** 按文件 mtime 失效的技能缓存：skill 是手写维护的源文件，改了要能立刻生效。 */
const CACHE = new Map()

/** 去掉 SKILL.md 的 YAML frontmatter，正文交给 registry。 */
export function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/**
 * 解析 frontmatter 的 `key: value`。只处理单层标量，不引 yaml 依赖：
 * 技能 frontmatter 只有 name / description / whenToUse 三个键。
 *
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const out = {}
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let v = m[2].trim()
    // 只剥一层引号；值里可能含中文冒号，不能用冒号切。
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

/** 一个技能的绝对路径，供 diagnostics 与测试用。 */
export function skillPath(name) {
  return fileURLToPath(new URL(`${name}/SKILL.md`, SKILLS_ROOT))
}

/** 技能包文件是否齐全（缺文件时 provider 会静默跳过，不影响插件其余功能）。 */
export function skillsAvailable() {
  try {
    return SKILL_DIRS.every((d) => existsSync(skillPath(d)))
  } catch {
    return false
  }
}

/**
 * 读取并解析一个技能。
 *
 * 缓存键带 mtime：技能文件是手写维护的，编辑后无需重载插件即可生效。
 * 用 mtime+size 而不是内容哈希——这里每次只 stat 不读盘，开销可忽略。
 */
async function loadSkill(name, root) {
  const docUrl = new URL(`${name}/SKILL.md`, root)
  const docPath = fileURLToPath(docUrl)
  const st = await stat(docPath)
  const stamp = `${st.mtimeMs}:${st.size}`
  const cacheKey = `${docPath}@${stamp}`

  const hit = CACHE.get(docPath)
  if (hit && hit.stamp === stamp) return hit.definition

  const raw = await readFile(docUrl, 'utf8')
  const meta = parseFrontmatter(raw)
  const definition = {
    name: meta.name || name,
    description: meta.description || '',
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content: stripFrontmatter(raw),
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`${name}/`, root)) },
    path: docPath,
    metadata: Object.keys(meta).length ? meta : undefined,
  }
  CACHE.set(docPath, { stamp, definition })
  return definition
}

/**
 * 构造 provider 对象。`list` 必须给出完整候选数组（含 rank/source/locator），
 * `get` 拿回当初给的 candidate 再返回完整定义。
 *
 * @returns {{name: string, list: Function, get: Function}}
 */
export function createSkillProvider(root = SKILLS_ROOT) {
  const base = root instanceof URL ? root : pathToFileURL(path.resolve(root) + path.sep)
  return {
    name: PROVIDER_NAME,

    /**
     * 不缓存候选数组：description 来自手写 frontmatter，改了要能立刻反映到
     * catalog。每次只做一次 stat + 命中 loadSkill 的 mtime 缓存，开销可忽略。
     */
    async list() {
      const built = []
      for (const dir of SKILL_DIRS) {
        let def
        try {
          def = await loadSkill(dir, base)
        } catch {
          // 技能文件缺失时静默跳过：插件其余功能不受影响。
          continue
        }
        if (!def.name || !def.description) continue
        built.push({
          name: def.name,
          description: def.description,
          ...(def.whenToUse ? { whenToUse: def.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          rank: RANK,
          locator: { dir },
          resourceBase: def.resourceBase,
          path: def.path,
        })
      }
      return built
    },

    async get(candidate) {
      const dir = candidate?.locator?.dir
      if (typeof dir !== 'string' || !SKILL_DIRS.includes(dir)) return undefined
      const def = await loadSkill(dir, base)
      return {
        name: def.name,
        description: def.description,
        ...(def.whenToUse ? { whenToUse: def.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        content: def.content,
        resourceBase: def.resourceBase,
        path: def.path,
      }
    },
  }
}

/**
 * 注册到 `ctx.skills`。调用方负责注入 `skills` 服务并持有 disposer。
 *
 * @param {object} ctx 已注入 skills 的 Cordis context
 * @returns {() => void} disposer
 */
export function registerSkills(ctx) {
  if (!ctx?.skills || typeof ctx.skills.registerProvider !== 'function') {
    return () => {}
  }
  return ctx.skills.registerProvider(() => createSkillProvider())
}

/** 给 diagnostics 用：技能包状态摘要。 */
export function describeSkills() {
  return {
    provider: PROVIDER_NAME,
    available: skillsAvailable(),
    rank: RANK,
    skills: SKILL_DIRS.map((d) => {
      try {
        return skillPath(d)
      } catch {
        return d
      }
    }),
  }
}
