/**
 * 真太阳时换算。
 *
 * 背景：紫微斗数传统上按「当地真太阳时」定时辰，而现代人报的是北京时间
 * （东八区标准时，以东经 120° 为准）。两者有两处系统偏差：
 *
 *   1. **经度差**：每偏离 120° 一度，差 4 分钟。乌鲁木齐（东经 87.6°）
 *      比北京时间慢 129.5 分钟——足以跨过两个时辰。
 *   2. **均时差（EoT）**：地球轨道偏心 + 黄赤交角导致的季节性能量差，
 *      全年在 -14.4 ~ +16.5 分钟之间摆动。
 *
 * 所以：真太阳时 = 北京时间 + (当地经度 − 120°) × 4 分钟 + EoT。
 *
 * 为什么必须认真处理跨日：经度修正可能让「00:30」变成「前一天 22:36」。
 * 时辰会从早子时变成亥时，**日期也要退一天**——否则农历月都可能算错。
 */

/* ==================================================================
   均时差 EoT
   ================================================================== */

/**
 * 均时差（双正弦近似），单位分钟。
 *
 * 严格按给定规格实现，不改常数、不改符号、不做角度转换：
 *   D = 6.24004077 + 0.01720197 × (365.25 × (year − 2000) + dayOfYear)
 *   EoT = −7.659·sin(D) + 9.863·sin(2D + 3.5932)
 *
 * `D` 本身就是弧度，直接喂给 Math.sin，**不要**再转成角度。
 * `D` 数值可以很大（175 弧度量级），不取模——Math.sin 自己处理周期。
 *
 * @param {number} year 公历年份，如 2026
 * @param {number} dayOfYear 年积日，1 月 1 日 = 1
 * @returns {number} 分钟；正值表示真太阳时快于平太阳时
 */
export function equationOfTimeMinutes(year, dayOfYear) {
  const D = 6.24004077 + 0.01720197 * (365.25 * (year - 2000) + dayOfYear)
  return -7.659 * Math.sin(D) + 9.863 * Math.sin(2 * D + 3.5932)
}

/** 闰年判断（纯公历，不掺时区/夏令时）。 */
export function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** 某年天数。 */
export function daysInYear(year) {
  return isLeapYear(year) ? 366 : 365
}

/**
 * 从公历年月日算年积日（1 月 1 日 = 1）。
 *
 * 只做日历算术，不碰时区——这里的日期来自用户填写的生辰，
 * 已经是我们想要的「哪一天」，不需要再做任何时区换算。
 *
 * @param {number} year
 * @param {number} month 1~12
 * @param {number} day 1~31
 * @returns {number}
 */
export function dayOfYear(year, month, day) {
  const cumulative = isLeapYear(year)
    ? [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
    : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  return cumulative[month - 1] + day
}

/* ==================================================================
   经度修正
   ================================================================== */

/** 东八区标准经度。 */
export const STANDARD_MERIDIAN = 120

/** 每度经度对应的时间差（分钟）。 */
export const MINUTES_PER_DEGREE = 4

/**
 * 经度修正（分钟）：当地经度相对 120° 的时差。
 *
 * 例：乌鲁木齐 87.617° → (87.617 − 120) × 4 = −129.5 分钟
 *
 * @param {number} longitude 东经为正
 * @returns {number} 分钟；负值表示当地真太阳时慢于北京时间
 */
export function longitudeCorrectionMinutes(longitude) {
  return (longitude - STANDARD_MERIDIAN) * MINUTES_PER_DEGREE
}

/** 东经范围校验（只支持中国及周边；再远已不属于东八区常用场景）。 */
export function isValidLongitude(lng) {
  return Number.isFinite(lng) && lng > 70 && lng < 140
}

/* ==================================================================
   时刻 ↔ 时辰
   ================================================================== */

/**
 * 时刻（分钟，0~1439）转时辰序号 0~12。
 *
 * 与 TIME_OPTIONS 严格一致：
 *   0=早子时 00:00~01:00   1=丑时 01:00~03:00   …   11=亥时 21:00~23:00
 *   12=晚子时 23:00~24:00
 *
 * 注意早子时只有 1 小时（00:00~01:00），晚子时也是 1 小时（23:00~24:00），
 * 其余每个时辰 2 小时——这是紫微斗数的惯例，不是等分的。
 *
 * @param {number} minutes 0~1439
 * @returns {number} 0~12
 */
export function timeIndexFromMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  if (m < 60) return 0        // 00:00~00:59 早子时
  if (m >= 23 * 60) return 12 // 23:00~23:59 晚子时
  return Math.floor((m - 60) / 120) + 1
}

/** 时辰序号 → 区间中点（分钟）与区间范围，用于真太阳时校正的默认基准。 */
export const TIME_MIDPOINTS = Object.freeze([
  { index: 0, mid: 30, from: 0, to: 60 },        // 早子时 00:00~01:00
  { index: 1, mid: 120, from: 60, to: 180 },     // 丑时   01:00~03:00
  { index: 2, mid: 240, from: 180, to: 300 },    // 寅时   03:00~05:00
  { index: 3, mid: 360, from: 300, to: 420 },    // 卯时   05:00~07:00
  { index: 4, mid: 480, from: 420, to: 540 },    // 辰时   07:00~09:00
  { index: 5, mid: 600, from: 540, to: 660 },    // 巳时   09:00~11:00
  { index: 6, mid: 720, from: 660, to: 780 },    // 午时   11:00~13:00
  { index: 7, mid: 840, from: 780, to: 900 },    // 未时   13:00~15:00
  { index: 8, mid: 960, from: 900, to: 1020 },   // 申时   15:00~17:00
  { index: 9, mid: 1080, from: 1020, to: 1140 }, // 酉时   17:00~19:00
  { index: 10, mid: 1200, from: 1140, to: 1260 },// 戌时   19:00~21:00
  { index: 11, mid: 1320, from: 1260, to: 1380 },// 亥时   21:00~23:00
  { index: 12, mid: 1410, from: 1380, to: 1440 },// 晚子时 23:00~24:00
])

/** 时辰序号 → 区间中点（分钟）。 */
export function midpointOfTimeIndex(timeIndex) {
  const t = TIME_MIDPOINTS[Number(timeIndex)]
  return t ? t.mid : 0
}

/** 分钟（0~1439）→ `HH:MM`。 */
export function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

/** `HH:MM` → 分钟（0~1439）；非法返回 null。 */
export function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

/** 日期字符串 `YYYY-M-D` 加 N 天。 */
function shiftDate(dateStr, days) {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr))
  if (!m) return dateStr
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  dt.setUTCDate(dt.getUTCDate() + days)
  return `${dt.getUTCFullYear()}-${dt.getUTCMonth() + 1}-${dt.getUTCDate()}`
}

/* ==================================================================
   主换算
   ================================================================== */

/**
 * 计算真太阳时。
 *
 * 真太阳时 = 北京时间 + (经度 − 120°) × 4 分钟 + EoT(当天)
 *
 * 关于跨日：结果可能落到前一天或后一天。返回的 `dayShift` 明确给出
 * 天数偏移（-1 / 0 / +1），调用方必须用它调整日期——只调时刻不调日期
 * 会让农历月都算错。
 *
 * EoT 用**原始公历日期**算：校正引入的日期偏移最多一天，而 EoT 一天
 * 内的变化不到 0.1 分钟，不值得为此做循环求解。
 *
 * @param {object} p
 * @param {string} p.solarDate 北京时间对应的阳历日期 `YYYY-M-D`
 * @param {number} p.minutes 北京时间的时刻（当天分钟数 0~1439）
 * @param {number} p.longitude 当地经度（东经为正）
 * @returns {{ok:true, ...} | {ok:false, error:object}}
 */
export function computeTrueSolarTime({ solarDate, minutes, longitude }) {
  if (!isValidLongitude(longitude)) {
    return { ok: false, error: { code: 'ziwei/invalid-longitude', message: '经度无效：' + longitude } }
  }
  const dm = /^(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(String(solarDate ?? ''))
  if (!dm) {
    return { ok: false, error: { code: 'ziwei/invalid-date', message: '日期无效：' + solarDate } }
  }
  const year = Number(dm[1])
  const month = Number(dm[2])
  const day = Number(dm[3])

  const doy = dayOfYear(year, month, day)
  const eot = equationOfTimeMinutes(year, doy)
  const lngMin = longitudeCorrectionMinutes(longitude)
  const total = lngMin + eot

  const baseMin = ((Math.round(Number(minutes)) % 1440) + 1440) % 1440
  const absolute = baseMin + total
  const dayShift = Math.floor(absolute / 1440)
  const trueMinutes = ((absolute % 1440) + 1440) % 1440

  return {
    ok: true,
    /** 校正前的北京时间。 */
    base: { solarDate, minutes: baseMin, clock: formatClock(baseMin) },
    /** 校正后的真太阳时。 */
    trueSolar: {
      solarDate: shiftDate(solarDate, dayShift),
      minutes: trueMinutes,
      clock: formatClock(trueMinutes),
      dayShift,
      // 时辰序号在这里也放一份：界面/工具展示「校正后是几时」时
      // 直接读 trueSolar.timeIndex 即可，不必回头找顶层字段。
      timeIndex: timeIndexFromMinutes(trueMinutes),
    },
    /** 分解出的两项修正，便于界面解释。 */
    correction: {
      longitudeMinutes: round2(lngMin),
      equationOfTimeMinutes: round2(eot),
      totalMinutes: round2(total),
    },
    /** 真太阳时对应的时辰序号（排盘用这个）。 */
    timeIndex: timeIndexFromMinutes(trueMinutes),
    /** 校正前的时辰序号（若给了精确时刻则由时刻推出）。 */
    baseTimeIndex: timeIndexFromMinutes(baseMin),
    /** 农历层是否需要重新换算日期。 */
    dateChanged: dayShift !== 0,
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * 从「时辰 + 可选精确时刻 + 地区」换算真太阳时。
 *
 * 这才是 Host 各层（建档、排盘、定盘）实际调用的入口，把
 * 「用户填的东西」翻译成「排盘该用的日期与时辰」。
 *
 * 基准时刻的取法：
 *   · 给了 `clock`（HH:MM）→ 用精确时刻，最准；
 *   · 只给了时辰       → 用该时辰区间中点。这是无奈的近似，但比用
 *                        区间起点或终点都更不偏。
 *
 * @param {object} p
 * @param {string} p.solarDate 北京时间的阳历日期
 * @param {number} [p.clockMinutes] 精确时刻（分钟），可选
 * @param {number} [p.timeIndex] 时辰序号，`clockMinutes` 缺省时用中点
 * @param {object} p.region { name, longitude } 或 { name, lng }
 * @returns {{ok:true, ...} | {ok:false, error:object}}
 */
export function resolveTrueSolarTime({ solarDate, clockMinutes, timeIndex, region }) {
  const lng = Number(region?.longitude ?? region?.lng)
  if (!isValidLongitude(lng)) {
    return { ok: false, error: { code: 'ziwei/invalid-longitude', message: '地区经度无效，请重新选择地区' } }
  }
  const hasClock = Number.isFinite(clockMinutes)
  const baseMinutes = hasClock
    ? clockMinutes
    : midpointOfTimeIndex(Number.isInteger(timeIndex) ? timeIndex : 0)

  const computed = computeTrueSolarTime({ solarDate, minutes: baseMinutes, longitude: lng })
  if (!computed.ok) return computed

  return {
    ...computed,
    /** 基准时刻是怎么来的：`clock` = 用户填的精确时刻，`midpoint` = 时辰中点推定。 */
    baseSource: hasClock ? 'clock' : 'midpoint',
    /** 实际采用的基准时辰（`clock` 时有意义）。 */
    baseTimeIndex: hasClock ? timeIndexFromMinutes(computed.base.minutes) : (Number(timeIndex) || 0),
    region: { name: region?.name ?? '', province: region?.province ?? '', longitude: round2(lng) },
    /** 时辰是否因校正而改变——界面要提示用户。 */
    timeIndexChanged: (hasClock ? timeIndexFromMinutes(computed.base.minutes) : (Number(timeIndex) || 0))
      !== computed.timeIndex,
  }
}
