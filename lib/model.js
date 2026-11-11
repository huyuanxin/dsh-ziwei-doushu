/**
 * 紫微斗数工作台 · 数据模型（单一事实来源）
 *
 * 星盘由「阳历生日 + 时辰 + 性别 + 闰月处理 + 语言」唯一决定，
 * 与人员档案一一对应：一个人只有一张盘，首次查看时生成一次并落盘，
 * 之后一直复用，不需要（也不应该）反复排盘。
 *
 * 本模块负责：
 *   · 从人员档案推导这张盘的 input（可覆盖，用于「重新生成」）
 *   · 存/取唯一星盘（ZiweiStore.charts 最多一项）
 *   · 保证「有盘则复用、无盘则生成」的 get-or-create 语义
 */

import { inputFromPerson, generateAstrolabe, describeEngine, convertDate } from './chart.js'
import { resolveTrueSolarTime, parseClock } from './solar-time.js'

/**
 * 把人员档案翻译成「真正用于排盘的生辰」。
 *
 * 未启用真太阳时：原样返回。
 * 启用时：按地区经度与当天均时差把北京时间校正成真太阳时，
 * 并**同时调整日期**——经度修正可能让 00:30 变成前一天 22:36，
 * 只调时刻不调日期会让农历月都算错。
 *
 * 基准时刻：填了 `birthClock` 用精确时刻；否则用时辰区间中点。
 *
 * @param {object} person 人员档案
 * @returns {{ok:true, person:object, solar:object} | {ok:false, error:object}}
 */
export function resolvePersonBirth(person) {
  const p = person ?? {}
  if (p.useTrueSolarTime !== true) {
    return { ok: true, person: p, solar: { enabled: false } }
  }

  const calendarType = p.calendarType === 'lunar' ? 'lunar' : 'solar'
  const isLeapMonth = calendarType === 'lunar' && p.isLeapMonth === true
  const conv = convertDate({ calendarType, birthDate: p.birthDate, isLeapMonth })
  if (!conv.ok) return conv

  const clockMinutes = p.birthClock ? parseClock(p.birthClock) : null
  const r = resolveTrueSolarTime({
    solarDate: conv.solarDate,
    clockMinutes: Number.isFinite(clockMinutes) ? clockMinutes : undefined,
    timeIndex: Number(p.birthTimeIndex) || 0,
    region: { name: p.regionName, province: p.regionProvince, longitude: p.regionLongitude },
  })
  if (!r.ok) return r

  // 校正后一律按「阳历 + 校正后的时辰」排盘：真太阳时已经跨过历法边界，
  // 再拿农历输入去排会让 iztro 重新做一次换算，重复且易错。
  const next = {
    ...p,
    calendarType: 'solar',
    isLeapMonth: false,
    birthDate: r.trueSolar.solarDate,
    birthTimeIndex: r.timeIndex,
  }
  return {
    ok: true,
    person: next,
    solar: {
      enabled: true,
      base: { solarDate: conv.solarDate, clock: r.base.clock, timeIndex: Number(p.birthTimeIndex) || 0 },
      region: r.region,
      baseSource: r.baseSource,
      trueSolar: r.trueSolar,
      correction: r.correction,
      timeIndexChanged: r.timeIndexChanged,
      dateChanged: r.dateChanged,
    },
  }
}

/** 星盘的对外摘要视图（不含完整 astrolabe，避免列表过重）。 */
export function chartView(c) {
  return {
    id: c.id,
    personId: c.personId,
    createdAt: c.createdAt,
    label: c.label,
    engine: c.engine,
    input: c.input,
    summary: c.summary,
  }
}

/** 构造一张新盘的记录。 */
export function buildChart(personId, person, input, opts = {}) {
  const generated = generateAstrolabe(input)
  if (!generated.ok) return generated
  const label = opts.label
    || `${person?.name ?? ''} · ${generated.summary.chineseDate || input.solarDate}`.trim()
  return {
    ok: true,
    chart: {
      id: 'chart_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      personId,
      createdAt: new Date().toISOString(),
      label,
      engine: { library: 'iztro', version: describeEngine().version },
      input,
      summary: generated.summary,
      astrolabe: generated.astrolabe,
    },
  }
}

/**
 * 取得某人的唯一星盘；没有就生成一次并落盘。
 *
 * 这是 UI 星盘页与运限查询共用的入口：
 *   · 有盘 → 直接复用（generated=false）
 *   · 无盘 → 用档案生辰生成（generated=true）
 *   · force=true → 显式重新生成（用户点了「重新生成」），覆盖旧盘
 *
 * @param {object} store ZiweiStore
 * @param {string} personId
 * @param {object} person 人员档案
 * @param {object} config 插件配置（language / fixLeap）
 * @param {object} [opts] { force?:boolean, input?:object, label?:string }
 * @returns {Promise<{ok:true, chart:object, generated:boolean} | {ok:false,error:object}>}
 */
export async function ensureChart(store, personId, person, config, opts = {}) {
  const charts = await store.listCharts(personId)
  const existing = charts[0]
  if (existing && !opts.force) {
    return { ok: true, chart: existing, generated: false }
  }

  // 真太阳时：先换算出排盘该用的日期与时辰（未启用时原样返回）。
  const resolved = resolvePersonBirth(person)
  if (!resolved.ok) return resolved

  // 注意 opts.input 是「显式覆盖」（重新生成时试算其它参数），
  // 优先级高于档案；此时不再叠加真太阳时校正，避免两次修正互相打架。
  const sanitized = opts.input
    ? inputFromPerson(person, opts.input, config)
    : inputFromPerson(resolved.person, {}, config)
  if (!sanitized.ok) return sanitized
  const built = buildChart(personId, person, sanitized.input, { label: opts.label })
  if (!built.ok) return built

  // 把校正过程记在盘上，界面可解释「这张盘是按真太阳时排的」。
  if (resolved.solar?.enabled) built.chart.solar = resolved.solar

  await store.saveCharts(personId, [built.chart])
  return { ok: true, chart: built.chart, generated: true }
}
