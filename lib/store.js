/**
 * 紫微斗数工作台 · 持久化
 *
 * 把人员档案、星盘、运限查询记录落在磁盘上，重开 Harness 后数据还在。
 *
 * 设计要点（沿用 dsh-bid-workbench 验证过的三条）：
 *  1. 多候选 roots：profile → DSH_HOME → cwd，已有数据的位置优先；
 *  2. 原子写：先写 .tmp 再 rename，崩溃不会留下半截 JSON；
 *  3. 串行化写队列：两个并发读-改-写互不覆盖。
 *
 * 目录结构：
 *   <root>/ziwei-doushu/
 *     people.json                    人员索引
 *     <personId>/
 *       person.json                 人员档案（冗余一份，便于单读）
 *       charts.json                 该人员的星盘列表（含完整 astrolabe JSON）
 *       horoscopes.json             该人员的运限查询历史（含完整 horoscope JSON）
 */

import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 环境变量覆盖（测试用，避免污染用户数据）。 */
const ENV_OVERRIDE = 'DSH_ZIWEI_DOUSHU_DIR'

/** 两个路径是否指向同一个目录（Windows 下忽略大小写与末尾分隔符）。 */
function sameDir(a, b) {
  const norm = (p) => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/**
 * 数据目录候选，最具体优先。
 * `DSH_PROFILE_DIR` 只有指向本进程自己的 profile 目录时才认，
 * 否则会跨 profile 读写别人的数据。
 */
function candidates() {
  const override = process.env[ENV_OVERRIDE]
  if (override) return [override]

  const roots = []
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  const profileDir = home && profile ? join(home, 'profiles', profile) : null
  if (profileDir) roots.push(profileDir)
  if (home) roots.push(home)
  const dir = process.env.DSH_PROFILE_DIR
  if (dir && !roots.includes(dir) && (profileDir === null || sameDir(dir, profileDir))) {
    roots.push(dir)
  }
  const cwd = process.cwd()
  if (!roots.includes(cwd)) roots.push(cwd)

  return roots.map((r) => join(r, 'ziwei-doushu'))
}

/** 解析数据目录：已有数据的位置优先，都没有时用最优先的候选。 */
export function resolveDataDir() {
  for (const dir of candidates()) {
    if (existsSync(join(dir, 'people.json'))) return dir
  }
  return candidates()[0]
}

/** 串行化写队列：file → Promise 链。 */
const queues = new Map()

/** 原子写一个 JSON 文件，并保证同一路径的写是串行的。 */
export async function writeJson(file, value) {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  }).finally(() => {
    if (queues.get(file) === next) queues.delete(file)
  })
  queues.set(file, next)
  return next
}

/** 读一个 JSON 文件；不存在或损坏时返回 fallback，绝不抛（损坏时留证）。 */
export async function readJson(file, fallback = null) {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback
    try { await rename(file, file + '.corrupt-' + Date.now()) } catch { /* ignore */ }
    return fallback
  }
}

/**
 * 人员 / 星盘 / 运限存储。
 *
 * 索引只存摘要，完整 JSON 按人员目录分文件存；
 * 列表页读索引 + 各人员目录的 charts/horoscopes 摘要即可，不需要一次载入全部盘面。
 */
export class ZiweiStore {
  /** @param {string} [dataDir] 覆盖默认目录 */
  constructor(dataDir) {
    this.dir = dataDir ?? resolveDataDir()
    this.indexFile = join(this.dir, 'people.json')
  }

  /** 人员目录。 */
  personDir(id) { return join(this.dir, sanitizeId(id)) }

  /* ==================== 人员 ==================== */

  /** @returns {Promise<Array>} */
  async listPeople() {
    const data = await readJson(this.indexFile, { people: [] })
    return Array.isArray(data?.people) ? data.people : []
  }

  /** @param {Array} people */
  async savePeople(people) {
    await writeJson(this.indexFile, { schemaVersion: 1, people })
  }

  /** 新建或更新一个人员（索引 + person.json 一起写）。 */
  async upsertPerson(person) {
    const list = await this.listPeople()
    const i = list.findIndex((p) => p.id === person.id)
    if (i >= 0) list[i] = { ...list[i], ...person }
    else list.push(person)
    await this.savePeople(list)
    await writeJson(join(this.personDir(person.id), 'person.json'), person)
    return person
  }

  /** @param {string} id */
  async loadPerson(id) {
    const list = await this.listPeople()
    return list.find((p) => p.id === id) ?? null
  }

  /**
   * 删除人员及其目录。
   * 只在索引里确实存在时才写回（防止损坏索引被空表覆盖，造成全量丢失）。
   * @returns {Promise<boolean>}
   */
  async deletePerson(id) {
    const safe = sanitizeId(id)
    const list = await this.listPeople()
    const kept = list.filter((p) => p.id !== id && safeId(p.id) !== safe)
    const removed = kept.length !== list.length
    if (!removed) return false
    await this.savePeople(kept)
    await rm(this.personDir(safe), { recursive: true, force: true })
    return true
  }

  /* ==================== 星盘 ==================== */

  /** @param {string} personId @returns {Promise<Array>} */
  async listCharts(personId) {
    const data = await readJson(join(this.personDir(personId), 'charts.json'), { charts: [] })
    return Array.isArray(data?.charts) ? data.charts : []
  }

  /** @param {string} personId @param {Array} charts */
  async saveCharts(personId, charts) {
    await writeJson(join(this.personDir(personId), 'charts.json'), { schemaVersion: 1, charts })
  }

  /** 追加一张盘。 @returns {Promise<object>} */
  async addChart(personId, chart) {
    const charts = await this.listCharts(personId)
    charts.push(chart)
    await this.saveCharts(personId, charts)
    return chart
  }

  /** 删除一张盘，同时把它名下的运限查询记录一并清掉（避免悬空引用）。 */
  async deleteChart(personId, chartId) {
    const charts = await this.listCharts(personId)
    const kept = charts.filter((c) => c.id !== chartId)
    if (kept.length === charts.length) return false
    await this.saveCharts(personId, kept)
    const records = await this.listHoroscopes(personId)
    const keptRecords = records.filter((r) => r.chartId !== chartId)
    if (keptRecords.length !== records.length) await this.saveHoroscopes(personId, keptRecords)
    return true
  }

  /* ==================== 运限查询历史 ==================== */

  /** @param {string} personId @returns {Promise<Array>} */
  async listHoroscopes(personId) {
    const data = await readJson(join(this.personDir(personId), 'horoscopes.json'), { records: [] })
    return Array.isArray(data?.records) ? data.records : []
  }

  /** @param {string} personId @param {Array} records */
  async saveHoroscopes(personId, records) {
    await writeJson(join(this.personDir(personId), 'horoscopes.json'), { schemaVersion: 1, records })
  }

  /** 追加一条运限查询。 */
  async addHoroscope(personId, record) {
    const records = await this.listHoroscopes(personId)
    records.push(record)
    await this.saveHoroscopes(personId, records)
    return record
  }

  /**
   * 按业务唯一键追加一条记录；命中则直接返回已有记录，不新增。
   *
   * 「今天/明天」按 (personId, kind='daily', targetDate) 去重——同一天重复点
   * 不应该在历史里堆出多条。返回 { record, deduplicated }。
   *
   * @param {string} personId
   * @param {object} record 完整记录（含 kind / targetDate）
   * @param {(r:object)=>boolean} match 唯一键判定
   */
  async addHoroscopeOnce(personId, record, match) {
    const records = await this.listHoroscopes(personId)
    const existing = records.find(match)
    if (existing) return { record: existing, deduplicated: true }
    records.push(record)
    await this.saveHoroscopes(personId, records)
    return { record, deduplicated: false }
  }

  /**
   * 就地更新一条运限记录（只合并传入字段）。
   *
   * 目前只用于回填 AI 分析结果；设计成分片更新是为了不动记录里的
   * 星盘/运限数据（那些是不可重算的历史快照，改了就失真）。
   *
   * @param {string} personId
   * @param {string} horoscopeId
   * @param {object} patch 要合并的字段（浅合并）
   * @returns {Promise<object|null>} 更新后的记录，找不到返回 null
   */
  async updateHoroscope(personId, horoscopeId, patch) {
    const records = await this.listHoroscopes(personId)
    const i = records.findIndex((r) => r.id === horoscopeId)
    if (i < 0) return null
    const next = { ...records[i], ...(patch && typeof patch === 'object' ? patch : {}) }
    next.id = records[i].id
    next.personId = personId
    records[i] = next
    await this.saveHoroscopes(personId, records)
    return next
  }

  /** 删除一条运限查询。 */
  async deleteHoroscope(personId, horoscopeId) {
    const records = await this.listHoroscopes(personId)
    const kept = records.filter((r) => r.id !== horoscopeId)
    if (kept.length === records.length) return false
    await this.saveHoroscopes(personId, kept)
    return true
  }
}

/** 防路径穿越：只允许安全字符。 */
function sanitizeId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!s || s === '.' || s === '..') throw new Error('ZIWEI_INVALID_ID: ' + id)
  return s
}

/** sanitizeId 的「不抛」版本，给比对场景用。 */
function safeId(id) {
  try { return sanitizeId(id) } catch { return null }
}

/** 供 diagnostics 用的目录探测信息。 */
export function describeStorage() {
  const dir = resolveDataDir()
  let exists = false
  try { exists = statSync(dir).isDirectory() } catch { exists = false }
  return { dir, exists, source: process.env[ENV_OVERRIDE] ? 'env' : 'profile' }
}
