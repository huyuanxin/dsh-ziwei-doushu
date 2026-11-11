/**
 * 紫微斗数工作台 · 排盘核心
 *
 * 对 iztro 的唯一封装：把「人员档案 + 可选覆盖」翻译成 iztro 的
 * `astro.withOptions(...)` 调用，产出**可 JSON 序列化**的盘面与运限数据。
 *
 * 支持两种历法（iztro 原生支持农历）：
 *   solar → withOptions({ type:'solar', dateStr: 阳历 YYYY-M-D })
 *   lunar → withOptions({ type:'lunar', dateStr: 农历 YYYY-M-D, isLeapMonth })
 *
 * 输入约定（与 UI 对齐）：
 *   calendarType 'solar' | 'lunar'
 *   dateStr      日期 `YYYY-M-D`（lunar 时是农历日期）
 *   isLeapMonth  农历是否闰月（仅 lunar 有效）
 *   timeIndex    0~12，0=早子时 1=丑时 … 11=亥时 12=晚子时
 *   gender       '男' | '女'
 *   fixLeap      是否调整闰月（默认 true）
 *   language     'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR' | 'vi-VN'
 */

import { astro } from 'iztro'
import { version as IZTRO_VERSION } from 'iztro/lib/version.js'
// lunar-lite 是 iztro 自己调用的历法层（其源码里 byLunar 就用 lunar2solar），
// 用它做换算与农历年枚举，口径与库完全一致。
import { solar2lunar, lunar2solar } from 'lunar-lite'
import { LunarYear, LunarUtil } from 'lunar-typescript'

/** 出生时辰：index 与 iztro 的 0~12 完全一致。 */
export const TIME_OPTIONS = [
  { index: 0, name: '早子时', range: '00:00~01:00' },
  { index: 1, name: '丑时', range: '01:00~03:00' },
  { index: 2, name: '寅时', range: '03:00~05:00' },
  { index: 3, name: '卯时', range: '05:00~07:00' },
  { index: 4, name: '辰时', range: '07:00~09:00' },
  { index: 5, name: '巳时', range: '09:00~11:00' },
  { index: 6, name: '午时', range: '11:00~13:00' },
  { index: 7, name: '未时', range: '13:00~15:00' },
  { index: 8, name: '申时', range: '15:00~17:00' },
  { index: 9, name: '酉时', range: '17:00~19:00' },
  { index: 10, name: '戌时', range: '19:00~21:00' },
  { index: 11, name: '亥时', range: '21:00~23:00' },
  { index: 12, name: '晚子时', range: '23:00~00:00' },
]

/** 支持的输出语言。 */
export const LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'vi-VN']

/** 统一失败信封。 */
export function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** 时辰 index → 显示名（找不到就返回原始值，不编造）。 */
export function timeLabel(index) {
  const t = TIME_OPTIONS.find((x) => x.index === index)
  return t ? `${t.name}（${t.range}）` : `时辰 ${index}`
}

/** 时辰短名（列表窄列用）。 */
export function timeShort(index) {
  const t = TIME_OPTIONS.find((x) => x.index === index)
  return t ? t.name : String(index)
}

/**
 * 归一化日期字符串为 `YYYY-M-D`。
 * 接受 YYYY-MM-DD / YYYY/M/D / YYYY.M.D / 带时间后缀；只做基本范围校验，
 * 真正的历法合法性（含农历闰月、每月天数）交给 lunar-typescript / iztro。
 * @returns {string|null}
 */
export function normalizeDate(v) {
  let s = String(v ?? '').trim()
  if (!s) return null
  s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '')
  const m = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (!Number.isInteger(y) || y < 1 || y > 9999) return null
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return null
  if (!Number.isInteger(d) || d < 1 || d > 31) return null
  // 真实日历日校验：2 月没有 30 号、平年没有 2-29。
  // 不校验的话 `1990-2-30` 会被 Date 静默溢出成 `1990-3-2`，
  // 于是「一个不存在的生日」被存成另一天，排盘也照算——错得很隐蔽。
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null
  }
  return `${y}-${mo}-${d}`
}

/** 兼容旧名（阳历归一化）。 */
export const normalizeSolarDate = normalizeDate

/**
 * 校验农历日期是否真实存在（含闰月与当月天数）。
 * 用 lunar-typescript，与 iztro 的校验口径一致，报错给可读中文。
 * @returns {{ok:true}|{ok:false, error:object}}
 */
export function validateLunarDate(dateStr, isLeapMonth) {
  const parts = String(dateStr ?? '').match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/)
  if (!parts) return fail('ziwei/invalid-date', '农历日期无效，请用 YYYY-M-D（例如 2000-7-17）')
  const y = Number(parts[1]); const mo = Number(parts[2]); const d = Number(parts[3])
  try {
    const ly = LunarYear.fromYear(y)
    const leapMonth = ly.getLeapMonth()
    if (isLeapMonth && leapMonth !== mo) {
      return fail('ziwei/invalid-leap', `农历 ${y} 年的闰月是「闰${cnMonth(leapMonth)}」，不是${cnMonth(mo)}月；请取消闰月或改选正确月份`)
    }
    const month = ly.getMonth(isLeapMonth ? -mo : mo)
    if (!month) return fail('ziwei/invalid-date', `农历 ${y} 年${isLeapMonth ? '闰' : ''}${cnMonth(mo)}月不存在`)
    const days = month.getDayCount()
    if (d > days) {
      return fail('ziwei/invalid-lunar-day', `农历 ${y} 年${isLeapMonth ? '闰' : ''}${cnMonth(mo)}月只有 ${days} 天，没有 ${d} 日`)
    }
    return { ok: true }
  } catch (e) {
    return fail('ziwei/invalid-date', '农历日期校验失败：' + String(e?.message ?? e))
  }
}

/** 数字月/日 → 中文名（直接用 lunar-typescript 的官方表，不自建数组）。 */
export function cnMonth(m) {
  const n = Number(m)
  return LunarUtil.MONTH[n] ?? String(m)
}

export function cnDay(d) {
  const n = Number(d)
  return LunarUtil.DAY[n] ?? String(d)
}

/**
 * 历法换算：任一历法 → 阳历 + 农历中文 + 展示文案。
 *
 * 这是表单「实时对照预览」的后端，也用于人员详情的展示字段。
 * 不做静默兜底：非法日期返回明确错误，UI 据此提示。
 *
 * @param {object} q { calendarType, birthDate, isLeapMonth }
 * @returns {{ok:true, solarDate, lunarText, display, leapMonthOfYear} | {ok:false,error:object}}
 */
export function convertDate(q = {}) {
  const calendarType = String(q.calendarType ?? 'solar').trim() === 'lunar' ? 'lunar' : 'solar'
  const dateStr = normalizeDate(q.birthDate ?? q.dateStr)
  if (!dateStr) return fail('ziwei/invalid-date', '日期无效，请用 YYYY-M-D（例如 2000-8-16）')
  const isLeapMonth = q.isLeapMonth === true
  const p = dateStr.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/)
  const y = Number(p[1]); const mo = Number(p[2]); const d = Number(p[3])
  try {
    let solarDate
    let lunarText
    if (calendarType === 'lunar') {
      const v = validateLunarDate(dateStr, isLeapMonth)
      if (!v.ok) return v
      // 用 iztro 同款 API 做换算：lunar2solar 接受 [YYYY-M-D, isLeapMonth]。
      const solar = lunar2solar(dateStr, isLeapMonth)
      solarDate = typeof solar === 'string' ? solar : String(solar)
      const lunar = solar2lunar(solarDate)
      lunarText = `${lunar.lunarYear}年${lunar.isLeap ? '闰' : ''}${cnMonth(lunar.lunarMonth)}月${cnDay(lunar.lunarDay)}`
    } else {
      const lunar = solar2lunar(dateStr)
      const solar = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])))
      solarDate = `${solar.getUTCFullYear()}-${solar.getUTCMonth() + 1}-${solar.getUTCDate()}`
      lunarText = `${lunar.lunarYear}年${lunar.isLeap ? '闰' : ''}${cnMonth(lunar.lunarMonth)}月${cnDay(lunar.lunarDay)}`
    }
    const display = calendarType === 'lunar'
      ? `农历 ${lunarText}${isLeapMonth ? '（闰月）' : ''} ≈ 阳历 ${solarDate}`
      : `阳历 ${solarDate} ≈ 农历 ${lunarText}`
    return {
      ok: true,
      solarDate,
      lunarText,
      display,
      leapMonthOfYear: LunarYear.fromYear(y).getLeapMonth(),
    }
  } catch (e) {
    return fail('ziwei/convert-failed', '历法换算失败：' + String(e?.message ?? e))
  }
}

/**
 * 校验并净化排盘输入。
 *
 * 关键：**所有字段都在这里校验**，iztro 抛出的错误会被翻译成可读中文，
 * 不让底层异常冒到 UI。支持 solar / lunar 两种历法。
 *
 * @param {object} raw 原始输入（可能来自 UI 或 Agent 工具）
 * @param {object} defaults 插件配置默认值 { language, fixLeap }
 * @returns {{ok:true, input:object} | {ok:false, error:object}}
 */
export function sanitizeChartInput(raw, defaults = {}) {
  const r = (raw && typeof raw === 'object') ? raw : {}
  const calendarType = String(r.calendarType ?? 'solar').trim() === 'lunar' ? 'lunar' : 'solar'
  const dateStr = normalizeDate(r.dateStr ?? r.birthDate ?? r.solarDate)
  if (!dateStr) return fail('ziwei/invalid-date', '出生日期无效，请用 YYYY-M-D（例如 2000-8-16）')

  const isLeapMonth = calendarType === 'lunar' && r.isLeapMonth === true
  if (calendarType === 'lunar') {
    const v = validateLunarDate(dateStr, isLeapMonth)
    if (!v.ok) return v
  } else {
    // 阳历用真实日历日校验（2 月 30 日之类）
    const p = dateStr.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/)
    const dt = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])))
    if (dt.getUTCFullYear() !== Number(p[1]) || dt.getUTCMonth() !== Number(p[2]) - 1 || dt.getUTCDate() !== Number(p[3])) {
      return fail('ziwei/invalid-solar-date', '阳历日期不存在：' + dateStr)
    }
  }

  const timeIndex = Number(r.timeIndex ?? r.birthTimeIndex)
  if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex > 12) {
    return fail('ziwei/invalid-time', '出生时辰必须是 0~12 的整数（0=早子时 … 12=晚子时）')
  }

  const gender = String(r.gender ?? '').trim()
  if (gender !== '男' && gender !== '女') {
    return fail('ziwei/invalid-gender', '性别只能是「男」或「女」')
  }

  const language = String(r.language ?? defaults.language ?? 'zh-CN').trim()
  if (!LANGUAGES.includes(language)) {
    return fail('ziwei/invalid-language', '不支持的语言：' + language + '（可用：' + LANGUAGES.join(', ') + '）')
  }

  // solarDate 始终保留换算出的阳历日期，方便展示与运限计算。
  const conv = convertDate({ calendarType, birthDate: dateStr, isLeapMonth })
  if (!conv.ok) return conv

  return {
    ok: true,
    input: {
      calendarType,
      dateStr,
      isLeapMonth,
      solarDate: conv.solarDate,
      timeIndex,
      gender,
      fixLeap: r.fixLeap === undefined ? (defaults.fixLeap !== false) : r.fixLeap === true,
      language,
    },
  }
}

/**
 * 从人员档案构造排盘输入（可被 createChart 的 input 覆盖）。
 * @param {object} person 人员档案
 * @param {object} [override] 覆盖字段
 * @param {object} defaults 插件配置
 */
export function inputFromPerson(person, override, defaults) {
  return sanitizeChartInput({
    calendarType: person?.calendarType ?? 'solar',
    dateStr: person?.birthDate,
    isLeapMonth: person?.isLeapMonth === true,
    timeIndex: person?.birthTimeIndex,
    gender: person?.gender,
    ...(override && typeof override === 'object' ? override : {}),
  }, defaults)
}

/**
 * 生成一张星盘。
 *
 * @param {object} input 已净化的排盘输入
 * @returns {{ok:true, astrolabe:object, summary:object} | {ok:false, error:object}}
 */
export function generateAstrolabe(input) {
  try {
    // 用 withOptions：把 language/fixLeap/历法绑在这一张盘上，
    // 不影响全局配置（iztro 的 config 是全局的，多人并发排盘会串味）。
    // 农历走 iztro 原生的 type:'lunar' + isLeapMonth，不是先转成阳历再排。
    const lunar = input.calendarType === 'lunar'
    const opts = {
      dateStr: input.dateStr ?? input.solarDate,
      type: lunar ? 'lunar' : 'solar',
      timeIndex: input.timeIndex,
      gender: input.gender,
      fixLeap: input.fixLeap,
      language: input.language,
    }
    if (lunar) opts.isLeapMonth = !!input.isLeapMonth
    const astrolabe = astro.withOptions(opts)
    const json = astrolabe.toJSON()
    return {
      ok: true,
      astrolabe: json,
      summary: {
        soul: json.soul ?? '',
        body: json.body ?? '',
        fiveElementsClass: json.fiveElementsClass ?? '',
        zodiac: json.zodiac ?? '',
        sign: json.sign ?? '',
        time: json.time ?? '',
        timeRange: json.timeRange ?? '',
        chineseDate: json.chineseDate ?? '',
        lunarDate: json.lunarDate ?? '',
        earthlyBranchOfSoulPalace: json.earthlyBranchOfSoulPalace ?? '',
        earthlyBranchOfBodyPalace: json.earthlyBranchOfBodyPalace ?? '',
        palaceCount: Array.isArray(json.palaces) ? json.palaces.length : 0,
      },
    }
  } catch (e) {
    return fail('ziwei/astrolabe-failed', 'iztro 排盘失败：' + String(e?.message ?? e))
  }
}

/**
 * 计算运限（大限 / 小限 / 流年 / 流月 / 流日 / 流时）。
 *
 * 注意：要**用同一张盘的实例**调用 horoscope()，不能拿 toJSON() 后的普通对象——
 * 后者没有方法。所以这里从已存的 astrolabe JSON 重新生成一次实例
 * （withOptions 是纯函数，同样的输入必然得到同样的盘）。
 *
 * @param {object} input 该盘的排盘输入
 * @param {string} targetDate 目标阳历日期 YYYY-M-D
 * @param {number} timeIndex 目标时辰 0~12
 * @returns {{ok:true, horoscope:object, summary:object} | {ok:false, error:object}}
 */
export function generateHoroscope(input, targetDate, timeIndex) {
  const date = normalizeSolarDate(targetDate)
  if (!date) return fail('ziwei/invalid-target-date', '查询日期无效，请用 YYYY-M-D（例如 2026-3-1）')
  const ti = Number(timeIndex)
  if (!Number.isInteger(ti) || ti < 0 || ti > 12) {
    return fail('ziwei/invalid-target-time', '查询时辰必须是 0~12 的整数')
  }
  try {
    const lunar = input.calendarType === 'lunar'
    const opts = {
      dateStr: input.dateStr ?? input.solarDate,
      type: lunar ? 'lunar' : 'solar',
      timeIndex: input.timeIndex,
      gender: input.gender,
      fixLeap: input.fixLeap,
      language: input.language,
    }
    if (lunar) opts.isLeapMonth = !!input.isLeapMonth
    const astrolabe = astro.withOptions(opts)
    const h = astrolabe.horoscope(date, ti)
    const json = h.toJSON()
    const pick = (x) => (x && typeof x === 'object')
      ? {
          name: x.name ?? '',
          index: x.index ?? null,
          heavenlyStem: x.heavenlyStem ?? '',
          earthlyBranch: x.earthlyBranch ?? '',
          palaceNames: Array.isArray(x.palaceNames) ? x.palaceNames : [],
          mutagen: Array.isArray(x.mutagen) ? x.mutagen : [],
        }
      : null
    return {
      ok: true,
      horoscope: json,
      summary: {
        solarDate: json.solarDate ?? '',
        lunarDate: json.lunarDate ?? '',
        decadal: pick(json.decadal),
        age: pick(json.age),
        yearly: pick(json.yearly),
        monthly: pick(json.monthly),
        daily: pick(json.daily),
        hourly: pick(json.hourly),
      },
    }
  } catch (e) {
    return fail('ziwei/horoscope-failed', 'iztro 运限计算失败：' + String(e?.message ?? e))
  }
}

/* ==================================================================
   未来运势快捷查看
   ================================================================== */

/** 从盘输入重建一个 astrolabe 实例（decadalList/yearlyList/horoscope 都是实例方法，toJSON 后没有）。 */
function astrolabeFromInput(input) {
  const lunar = input.calendarType === 'lunar'
  const opts = {
    dateStr: input.dateStr ?? input.solarDate,
    type: lunar ? 'lunar' : 'solar',
    timeIndex: input.timeIndex,
    gender: input.gender,
    fixLeap: input.fixLeap,
    language: input.language,
  }
  if (lunar) opts.isLeapMonth = !!input.isLeapMonth
  return astro.withOptions(opts)
}

/** 本地时区的今天，归一成 YYYY-M-D。 */
export function todayString(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 日期字符串加 N 天（用 UTC 避免夏令时/时区偏移）。 */
function addDays(dateStr, n) {
  const p = String(dateStr).match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/)
  if (!p) return ''
  const dt = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])))
  dt.setUTCDate(dt.getUTCDate() + n)
  return `${dt.getUTCFullYear()}-${dt.getUTCMonth() + 1}-${dt.getUTCDate()}`
}

/** 截取宫名/干支等短字段，避免把完整 stars 数组塞进摘要对象。 */
function scopeBrief(x) {
  if (!x || typeof x !== 'object') return null
  return {
    index: x.index ?? null,
    name: x.name ?? '',
    heavenlyStem: x.heavenlyStem ?? '',
    earthlyBranch: x.earthlyBranch ?? '',
    palaceNames: Array.isArray(x.palaceNames) ? x.palaceNames : [],
    mutagen: Array.isArray(x.mutagen) ? x.mutagen : [],
    ...(Array.isArray(x.stars) ? { stars: x.stars } : {}),
  }
}

/** 大限列表的精简视图（含 yearRange，用于按年份匹配）。 */
function decadalBrief(d, i) {
  return {
    index: i,
    name: d?.name ?? '',
    palaceName: d?.palaceName ?? '',
    ageRange: Array.isArray(d?.ageRange) ? d.ageRange : [],
    yearRange: Array.isArray(d?.yearRange) ? d.yearRange : [],
    heavenlyStem: d?.heavenlyStem ?? '',
    earthlyBranch: d?.earthlyBranch ?? '',
    mutagen: Array.isArray(d?.mutagen) ? d.mutagen : [],
  }
}

/**
 * 取某农历年的官方代表日（农历六月初一，与 iztro yearlyList 同一口径）。
 * 用 iztro 同款 lunar2solar 换算（农历六月初一 = yearlyList 的官方代表日）；
 * 失败返回空串（仅展示字段，不阻断）。
 */
function representativeOfYear(year) {
  try {
    const s = lunar2solar(`${year}-6-1`)
    return typeof s === 'string' ? s : String(s)
  } catch { return '' }
}

/**
 * 定盘：对同一天的全部 13 个时辰各排一张盘，抽出「能用来判断哪个像自己」的特征。
 *
 * 背景：紫微斗数里时辰决定命宫落宫与星曜分布，两个相邻时辰可能是完全不同的
 * 两张盘。很多用户不记得出生时辰，传统做法就是把候选时辰的盘都看一遍，
 * 挑出与自己性格吻合的那张——这就是「定盘」。
 *
 * 这里只负责**取数据**，不写解读话术：每张盘给出
 *   · 命宫干支与主星（含亮度、四化）——最直观的个性线索
 *   · 身宫落宫——后天行为倾向
 *   · 命主 / 身主 / 五行局——官方盘的固定标识
 *   · 兄弟宫、夫妻宫、迁移宫、福德宫的主星——几个最容易自我对照的宫位
 *   · 盘面指纹（所有主星位置的哈希），用于快速判断是否有重复盘
 *
 * @param {{gender:string, birthDate:string, calendarType?:string, isLeapMonth?:boolean}} person
 * @param {object} [defaults] { fixLeap, language }
 * @returns {{ok:true, candidates:Array, distinct:number, note:string} | {ok:false, error:object}}
 */
export function buildTimeCandidates(person, defaults = {}) {
  if (!person || !person.birthDate) {
    return fail('ziwei/invalid-input', '缺少出生日期')
  }
  const candidates = []
  try {
    for (const opt of TIME_OPTIONS) {
      const r = inputFromPerson({ ...person, birthTimeIndex: opt.index }, {}, defaults)
      const input = r.input ?? r
      if (!input || input.ok === false) {
        candidates.push({
          timeIndex: opt.index, timeLabel: opt.name, timeRange: opt.range,
          ok: false, error: r.error ?? input.error ?? { message: '排盘输入无效' },
        })
        continue
      }
      const g = generateAstrolabe(input)
      if (!g.ok) {
        candidates.push({
          timeIndex: opt.index, timeLabel: opt.name, timeRange: opt.range,
          ok: false, error: g.error,
        })
        continue
      }
      const a = g.astrolabe.toJSON ? g.astrolabe.toJSON() : g.astrolabe
      const palaces = Array.isArray(a.palaces) ? a.palaces : []
      // iztro 的 palace.name 只有 `命宫` 带「宫」字，其余是 `兄弟`/`夫妻`…
      // 统一成带「宫」的形式，按名字查宫才不会漏。
      const palaceKey = (n) => {
        const raw = String(n ?? '')
        if (!raw) return ''
        return raw.endsWith('宫') ? raw : raw + '宫'
      }
      const byName = new Map(palaces.map((p) => [palaceKey(p.name), p]))

      /** 把某宫压成一句：`命宫 戊寅｜天机[得] 太阴[旺科]` */
      const palaceBrief = (name) => {
        const p = byName.get(name)
        if (!p) return null
        const majors = (p.majorStars ?? []).map((s) => {
          const tag = s.brightness ? `[${s.brightness}${s.mutagen ?? ''}]` : (s.mutagen ? `[${s.mutagen}]` : '')
          return `${s.name}${tag}`
        })
        return {
          palace: palaceKey(p.name) || name,
          ganzhi: `${p.heavenlyStem ?? ''}${p.earthlyBranch ?? ''}`,
          earthlyBranch: p.earthlyBranch ?? '',
          majors,
          isBodyPalace: p.isBodyPalace === true,
          empty: majors.length === 0,
        }
      }

      const soul = byName.get('命宫') ?? null
      const bodyPalace = palaces.find((p) => p.isBodyPalace) ?? null
      // 指纹：主星落宫分布。同一天里通常只有少数几个时辰会排出同一张盘。
      const fingerprint = palaces
        .slice()
        .sort((x, y) => String(x.earthlyBranch).localeCompare(String(y.earthlyBranch)))
        .map((p) => `${p.earthlyBranch}:${(p.majorStars ?? []).map((s) => s.name).sort().join(',')}`)
        .join('|')

      candidates.push({
        timeIndex: opt.index,
        timeLabel: opt.name,
        timeRange: opt.range,
        ok: true,
        fiveElementsClass: a.fiveElementsClass ?? '',
        soul: a.soul ?? '',
        body: a.body ?? '',
        chineseDate: a.chineseDate ?? '',
        soulPalace: palaceBrief('命宫'),
        bodyPalace: bodyPalace ? {
          name: palaceKey(bodyPalace.name),
          earthlyBranch: bodyPalace.earthlyBranch ?? '',
          ganzhi: `${bodyPalace.heavenlyStem ?? ''}${bodyPalace.earthlyBranch ?? ''}`,
        } : null,
        // 最容易自我对照的几个宫：个性、兄弟/母亲、伴侣、外出表现、精神面。
        keyPalaces: ['命宫', '兄弟宫', '夫妻宫', '迁移宫', '福德宫']
          .map(palaceBrief)
          .filter(Boolean),
        fingerprint,
      })
    }

    const distinct = new Set(candidates.filter((c) => c.ok).map((c) => c.fingerprint)).size
    return {
      ok: true,
      candidates,
      distinct,
      note: `同一天共有 ${candidates.length} 个时辰，排出 ${distinct} 张不同的盘。`,
    }
  } catch (e) {
    return fail('ziwei/time-candidates-failed', '定盘候选计算失败：' + String(e?.message ?? e))
  }
}

/**
 * 未来运势快捷查看。
 *
 * 逐年数据**完全用 iztro 官方 API**，不再自造代表日：
 *   · horoscope(baseDate)  → 起算日的六层运限快照
 *   · decadalList()        → 12 个大限（起运顺序），yearRange 是农历年口径
 *   · yearlyList(i)        → 第 i 个大限那 10 年的逐年流年（库内部自选
 *                            农历六月初一作代表日，避开农历年边界）
 *
 * 关键口径：**斗数的"年"是农历年**。时间轴按农历年枚举——起算日的农历年
 * 为起点，往后取 years 个农历年；每个农历年的流年数据从 yearlyList() 里
 * 按 `item.year` 匹配。阳历 scopeLabel 里的年份区间仅作展示参考。
 * （自造"阳历周年日"代表日会跳年：起算日在阳历 1 月~2 月中时，
 * 农历新年前的周年日属于上一农历年，会漏掉一整年——已实测复现。）
 *
 * @param {object} input 已净化的排盘输入
 * @param {object} q { preset:'today'|'tomorrow'|'nYears'|'custom', targetDate?, years? }
 * @returns {{ok:true, fortune:object} | {ok:false,error:object}}
 */
export function buildFortune(input, q = {}) {
  const preset = ['today', 'tomorrow', 'nYears', 'custom'].includes(q.preset) ? q.preset : 'today'
  const today = todayString()
  let baseDate = today
  if (preset === 'tomorrow') baseDate = addDays(today, 1)
  else if (preset === 'custom') {
    const d = normalizeDate(q.targetDate)
    if (!d) return fail('ziwei/invalid-target-date', '自定义日期无效，请用 YYYY-M-D')
    const p = d.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/)
    const chk = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])))
    if (chk.getUTCFullYear() !== Number(p[1]) || chk.getUTCMonth() !== Number(p[2]) - 1 || chk.getUTCDate() !== Number(p[3])) {
      return fail('ziwei/invalid-solar-date', '阳历日期不存在：' + d)
    }
    baseDate = d
  }
  const years = Math.min(30, Math.max(1, Number(q.years ?? 10) || 10))

  try {
    const a = astrolabeFromInput(input)
    const decadals = (a.decadalList() ?? []).map(decadalBrief)

    /** 起算日：六层运限快照。 */
    const cur = a.horoscope(baseDate).toJSON()
    const current = {
      date: baseDate,
      timeIndex: input.timeIndex,
      label: (preset === 'today' ? '今天 ' : preset === 'tomorrow' ? '明天 ' : '') + baseDate,
      solarDate: cur.solarDate ?? baseDate,
      lunarDate: cur.lunarDate ?? '',
      decadal: scopeBrief(cur.decadal),
      age: scopeBrief(cur.age),
      yearly: scopeBrief(cur.yearly),
      monthly: scopeBrief(cur.monthly),
      daily: scopeBrief(cur.daily),
      hourly: scopeBrief(cur.hourly),
      nominalAge: cur.age?.nominalAge ?? null,
    }

    const gaps = []   // 个别年份缺失时如实记录，不静默丢年份
    const timeline = []

    // 起算日的农历年 = 时间轴的起点年（斗数的"年"是农历年）。
    // 用 iztro 同款 solar2lunar 换算，避免解析中文数字。
    let lunarYearNum = null
    try {
      lunarYearNum = solar2lunar(baseDate)?.lunarYear ?? null
    } catch { lunarYearNum = null }
    if (!Number.isInteger(lunarYearNum) || lunarYearNum < 1) {
      return fail('ziwei/fortune-failed', '无法确定起算日的农历年：' + baseDate)
    }

    // 官方 yearlyList(i)：第 i 个大限那 10 年的逐年流年。铺平成 year → item。
    const yearIndex = new Map()
    for (let i = 0; i < decadals.length; i++) {
      let list
      try { list = a.yearlyList(i) } catch (e) { gaps.push({ decade: i, reason: String(e?.message ?? e) }); continue }
      for (const y of (list ?? [])) {
        if (y && Number.isInteger(y.year)) yearIndex.set(y.year, y)
      }
    }

    for (let i = 0; i <= years; i++) {
      const year = lunarYearNum + i
      const y = yearIndex.get(year)
      if (!y) {
        // 该农历年不在任何大限范围内（太远/童限前）：如实记录，不编造。
        gaps.push({ year, reason: 'yearlyList 未覆盖该农历年' })
        continue
      }
      const age = Number.isInteger(y.age) ? y.age : null
      const dec = decadals.find((x) => x.yearRange.length === 2 && year >= x.yearRange[0] && year <= x.yearRange[1]) ?? null
      const gz = String(y.heavenlyStem ?? '') + String(y.earthlyBranch ?? '')
      // 流年落宫：palaceNames[y.index] === '命宫'（iztro 官方语义）。
      const palaceName = (Array.isArray(y.palaceNames) && Number.isInteger(y.index))
        ? String(y.palaceNames[y.index] ?? '')
        : (Array.isArray(y.palaceNames) && y.palaceNames.length ? String(y.palaceNames[0]) : '')
      const mutagen = Array.isArray(y.mutagen) ? y.mutagen : []
      const decGz = dec ? String(dec.heavenlyStem ?? '') + String(dec.earthlyBranch ?? '') : ''
      const summary = [
        `${year} ${gz}`,
        age !== null ? `${age} 岁` : '',
        palaceName ? `流年${palaceName}宫` : '',
        dec ? `大限${dec.palaceName}宫(${dec.yearRange.join('~')})` : '',
        mutagen.length ? `四化 ${mutagen.join('/')}` : '',
      ].filter(Boolean).join(' · ')
      timeline.push({
        year,
        /** 该农历年的官方代表日（农历六月初一），仅展示/追溯用。 */
        date: representativeOfYear(year),
        age,
        heavenlyStem: y.heavenlyStem ?? '',
        earthlyBranch: y.earthlyBranch ?? '',
        palaceName,
        palaceNames: Array.isArray(y.palaceNames) ? y.palaceNames : [],
        index: Number.isInteger(y.index) ? y.index : null,
        mutagen,
        decadal: dec ? {
          index: dec.index,
          palaceName: dec.palaceName,
          ageRange: dec.ageRange,
          yearRange: dec.yearRange,
          heavenlyStem: dec.heavenlyStem,
          earthlyBranch: dec.earthlyBranch,
          mutagen: dec.mutagen,
          ganzhi: decGz,
        } : null,
        isCurrentYear: i === 0,
        summary,
      })
    }

    // scopeLabel 用农历年口径（斗数的"年"是农历年）；起算日仍是阳历展示。
    const scopeLabel = preset === 'today' || preset === 'tomorrow'
      ? `${current.label} 起，未来 ${years} 年（农历 ${lunarYearNum}~${lunarYearNum + years} 年）`
      : preset === 'custom'
        ? `${baseDate} 起，未来 ${years} 年（农历 ${lunarYearNum}~${lunarYearNum + years} 年）`
        : `未来 ${years} 年（农历 ${lunarYearNum}~${lunarYearNum + years} 年）`

    return {
      ok: true,
      fortune: {
        baseDate,
        baseLunarYear: lunarYearNum,
        today,
        preset,
        years,
        request: { preset, targetDate: preset === 'custom' ? baseDate : '', years },
        current,
        timeline,
        decadals,
        gaps,
        scopeLabel,
      },
    }
  } catch (e) {
    return fail('ziwei/fortune-failed', '运势计算失败：' + String(e?.message ?? e))
  }
}

/**
 * fortune 时间轴的精简副本：去掉与 horoscope 重复的 current 快照，
 * 以及逐年里冗长的 palaceNames / stars，只留解读必需的字段。
 */
function slimFortune(f) {
  if (!f || typeof f !== 'object') return f
  const timeline = Array.isArray(f.timeline) ? f.timeline.map((t) => ({
    year: t.year, date: t.date, age: t.age,
    heavenlyStem: t.heavenlyStem, earthlyBranch: t.earthlyBranch,
    palaceName: t.palaceName, mutagen: t.mutagen,
    decadal: t.decadal, isCurrentYear: t.isCurrentYear, summary: t.summary,
  })) : []
  return {
    baseDate: f.baseDate, today: f.today, preset: f.preset, years: f.years,
    request: f.request, scopeLabel: f.scopeLabel,
    decadals: f.decadals, gaps: f.gaps, timeline,
  }
}

/**
 * 星盘 JSON 的精简副本：12 宫全保留，但去掉与解读无关的超长数组
 * （ages 小限岁数、changsheng12/boshi12 等神煞在 horoscope 里已有对应），
 * 让「附带原始数据」不至于把草稿撑爆、把时间轴挤掉。
 */
function slimAstrolabe(a) {
  if (!a || typeof a !== 'object') return a
  const palaces = Array.isArray(a.palaces) ? a.palaces.map((p) => ({
    index: p.index, name: p.name,
    isBodyPalace: p.isBodyPalace, isOriginalPalace: p.isOriginalPalace,
    heavenlyStem: p.heavenlyStem, earthlyBranch: p.earthlyBranch,
    majorStars: p.majorStars, minorStars: p.minorStars, adjectiveStars: p.adjectiveStars,
    decadal: p.decadal,
  })) : []
  return {
    gender: a.gender, solarDate: a.solarDate, lunarDate: a.lunarDate,
    chineseDate: a.chineseDate, time: a.time, timeRange: a.timeRange,
    sign: a.sign, zodiac: a.zodiac,
    earthlyBranchOfSoulPalace: a.earthlyBranchOfSoulPalace,
    earthlyBranchOfBodyPalace: a.earthlyBranchOfBodyPalace,
    soul: a.soul, body: a.body, fiveElementsClass: a.fiveElementsClass,
    palaces,
  }
}

/**
 * 生成「发起对话」时的占位起始文本。
 *
 * ⚠️ 这是**扩展点**，不是分析话术：用户明确说提示词后面整理完资料再注入。
 * 所以这里只做两件事：一句极简的占位说明 + 把结构化数据序列化附在后面，
 * 不含任何吉凶判断、解读模板、角色设定。后续注入提示词时只需替换
 * `intro` 或改为读取 `promptTemplate`，不用动 UI 与会话创建链路。
 *
 * 数据分段序列化：若整包超过上限，优先保证 record/data（含时间轴）完整，
 * 再对星盘做精简/截断，绝不静默丢掉用户要分析的那条记录的数据。
 *
 * @param {object} context buildAnalysisContext 组装出的结构化上下文
 * @returns {string}
 */
export function renderStarterPrompt(context) {
  const head = [
    '请分析以下紫微斗数运势记录（原始数据见下方 JSON）。',
    '注：运势分析提示词模板整理中，当前仅建立对话并附带原始数据。',
  ].join('\n')
  // promptTemplate 是占位对象，排除它以免把「待补充」状态当成数据发给模型。
  const { promptTemplate, starterPrompt, ...rest } = context ?? {}
  const data = { ...rest }
  if (data.chart?.astrolabe) {
    data.chart = { ...data.chart, astrolabe: slimAstrolabe(data.chart.astrolabe) }
  }
  if (data.data?.fortune) {
    data.data = { ...data.data, fortune: slimFortune(data.data.fortune) }
  }
  let body
  try { body = JSON.stringify(data, null, 2) } catch { body = '{}' }
  // 草稿（未发送）可以稍长，用户可自行审阅删减；48KB 足够覆盖 30 年时间轴。
  const MAX = 48000
  if (body.length > MAX) {
    // 分级降级：先去掉星盘完整 JSON（只留摘要），record/data 始终完整保留。
    const essential = {
      person: data.person,
      chart: data.chart
        ? { id: data.chart.id, label: data.chart.label, summary: data.chart.summary, input: data.chart.input,
            notice: '完整星盘 JSON 过大，已省略；可用 ziwei_query(what=chart) 读取。' }
        : null,
      record: data.record,
      data: data.data,
    }
    body = JSON.stringify(essential, null, 2)
    if (body.length > MAX) body = body.slice(0, MAX) + '\n...（数据已截断）'
  }
  return `${head}\n\n\`\`\`json\n${body}\n\`\`\``
}

/** 暴露 iztro 版本与配置能力，给 diagnostics 用。 */
export function describeEngine() {
  return {
    library: 'iztro',
    version: IZTRO_VERSION ?? 'unknown',
    languages: LANGUAGES.slice(),
    calendarTypes: ['solar', 'lunar'],
    supportsLeapMonth: true,
    timeOptions: TIME_OPTIONS.map((t) => ({ ...t })),
    methods: [
      // iztro 官方 API（逐年运势全部由它们产出，不自造代表日）
      'astro.withOptions', 'astrolabe.toJSON', 'astrolabe.horoscope()',
      'astrolabe.decadalList()', 'astrolabe.yearlyList()',
      // iztro 内置历法层 lunar-lite / lunar-typescript
      'lunar2solar', 'solar2lunar', 'LunarYear.fromYear', 'LunarUtil.MONTH', 'LunarUtil.DAY',
      // 本项目封装
      'convertDate', 'buildFortune', 'renderStarterPrompt',
    ],
  }
}
