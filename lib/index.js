/**
 * 紫微斗数工作台 — Host 半区。
 *
 * 一个会话工作台：管理人员档案 → 调用 iztro 排盘 → 查看星盘 JSON → 运限查询留痕。
 *
 * 架构要点（沿用 dsh-bid-workbench 验证过的约束）：
 *  · `ZiweiWorkbench` 是唯一实现，UI（Remote）与 Agent 工具都只调它；
 *  · 不能用 #private 字段：Cordis 把 Service 实例交给调用方时套了 Proxy，
 *    Gateway 用 Reflect.apply 派发，私有字段访问会抛异常；
 *  · Remote 方法形参统一叫 `request`，descriptor 的 wire 名必须与之相同；
 *  · 业务失败是**正常返回的** `{ ok:false, error }`，不抛（Gateway 会把异常
 *    翻译成传输层错误，用户看到的就是「点了没反应」）。
 */

import crypto from 'node:crypto'

import { ZiweiStore, describeStorage } from './store.js'
import {
  LANGUAGES, fail, timeLabel, timeShort,
  normalizeDate, generateHoroscope, describeEngine,
  convertDate as convertCalendarDate, buildFortune, buildTimeCandidates,
} from './chart.js'
import { renderAnalysisBrief, renderStarterPrompt, renderTimePrompt } from './analysis.js'
import { chartView, ensureChart } from './model.js'
import { buildZiweiTools } from './tools.js'
import { describeSkills, registerSkills } from './skills.js'
import { resolveTrueSolarTime, parseClock, formatClock, midpointOfTimeIndex } from './solar-time.js'
import { findRegion, listRegions as listRegionData, describeRegions } from './regions.js'

/** 插件配置 schema（Standard Schema v1）。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-ziweidoushu',
    validate(value) {
      const v = (value && typeof value === 'object') ? { ...value } : {}
      return {
        value: {
          dataDir: typeof v.dataDir === 'string' ? v.dataDir.trim() : '',
          language: LANGUAGES.includes(String(v.language ?? '').trim()) ? String(v.language).trim() : 'zh-CN',
          fixLeap: v.fixLeap !== false,
        },
      }
    },
  },
}

/** 生成短 id（人员与运限记录用；星盘 id 由 model.js 生成）。 */
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
}

/** ISO 现在。 */
function now() { return new Date().toISOString() }

/**
 * 从分析正文自动截一段摘要（列表展示用）。
 *
 * 去掉 Markdown 标记与多余空白后按字符截断：中文按字算，100 字左右足够
 * 在列表里认出「这条记录分析讲了什么」。
 */
function autoSummary(text, max = 100) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')      // 代码块
    .replace(/^#{1,6}\s+/gm, '')           // 标题号
    .replace(/^\s*[-*+]\s+/gm, '')          // 列表符号
    .replace(/^\s*>\s?/gm, '')             // 引用
    .replace(/^[-*_]{3,}\s*$/gm, ' ')      // 分隔线 --- *** ___
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ') // 表格分隔行 |---|---|
    .replace(/\*\*([^*]*)\*\*/g, '$1')     // 粗体
    .replace(/`([^`]*)`/g, '$1')            // 行内代码
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  return flat.slice(0, max) + '…'
}

/**
 * 兼容两种入参形状：`{ request: {...} }`（Remote wire）与裸对象（Agent 工具）。
 */
function unwrapArg(v, mustHave) {
  const inner = (v && typeof v === 'object' && v.request && typeof v.request === 'object')
    ? v.request
    : (v && typeof v === 'object' ? v : {})
  if (mustHave && inner[mustHave] === undefined) {
    throw new Error(`ziwei/invalid-input: 缺少 ${mustHave}`)
  }
  return inner
}

/** 截断字符串，防止超长输入撑爆 JSON 文件。 */
function str(v, max = 200) {
  return String(v ?? '').trim().slice(0, max)
}

/**
 * 紫微斗数工作台服务。公开方法即 Remote 面。
 */
export class ZiweiWorkbench {
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {object} config */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.store = new ZiweiStore(config.dataDir || undefined)
    /**
     * 绑定 Typert Remote 命名空间。
     * 没有这一行，Gateway 不会把 `ziwei/<method>` 暴露给浏览器。
     */
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'ziweiWorkbench', namespace: 'ziwei' })
  }

  /* ==================== 诊断 ==================== */

  /** 报告实际生效的配置与能力。 */
  diagnostics() {
    return {
      ok: true,
      storage: describeStorage(),
      dataDir: this.store.dir,
      defaults: { language: this.config.language, fixLeap: this.config.fixLeap },
      engine: describeEngine(),
      skills: describeSkills(),
      regions: describeRegions(),
      version: '0.1.0',
    }
  }

  /* ==================== 人员 ==================== */

  /**
   * 按人员档案算出「排盘实际使用的日期与时辰」。
   *
   * 这是真太阳时的**唯一落地点**：不管建档、编辑还是按需重排，
   * 都从这里取 use 什么日期、什么时辰去排盘。
   *
   * 返回两层信息：
   *   · `input`   —— 排盘该用的（校正后的）日期与时辰
   *   · `solar`   —— 校正过程与前后对照，供界面展示「填写 vs 校正」
   *
   * 未启用真太阳时，直接把用户填的原样返回（input 与 base 相同）。
   *
   * @param {object} person 人员档案（含 useTrueSolarTime / region* / birthClock）
   * @param {object} conv 该人员的历法换算结果（含 solarDate）
   * @returns {{ok:true, input:object, solar:object} | {ok:false, error:object}}
   */
  resolveBirthForChart(person, conv) {
    const base = {
      solarDate: conv.solarDate,
      timeIndex: Number(person.birthTimeIndex) || 0,
      clock: person.birthClock || '',
    }

    if (person.useTrueSolarTime !== true) {
      return {
        ok: true,
        input: { solarDate: base.solarDate, timeIndex: base.timeIndex },
        solar: { enabled: false, base },
      }
    }

    const clockMinutes = base.clock ? parseClock(base.clock) : null
    const r = resolveTrueSolarTime({
      solarDate: base.solarDate,
      clockMinutes: Number.isFinite(clockMinutes) ? clockMinutes : undefined,
      timeIndex: base.timeIndex,
      region: {
        name: person.regionName,
        province: person.regionProvince,
        longitude: person.regionLongitude,
      },
    })
    if (!r.ok) return r

    return {
      ok: true,
      input: {
        solarDate: r.trueSolar.solarDate,
        timeIndex: r.timeIndex,
      },
      solar: {
        enabled: true,
        base,
        region: r.region,
        baseSource: r.baseSource,
        trueSolar: r.trueSolar,
        correction: r.correction,
        timeIndexChanged: r.timeIndexChanged,
        dateChanged: r.dateChanged,
      },
    }
  }

  /** 人员档案的对外视图（补上时辰显示名、历法换算与计数）。 */
  personView(p, charts, horoscopes) {
    const calendarType = p.calendarType === 'lunar' ? 'lunar' : 'solar'
    const isLeapMonth = calendarType === 'lunar' && p.isLeapMonth === true
    // 换算失败不阻断档案读取：只少了展示文案，原始数据仍在。
    const conv = convertCalendarDate({ calendarType, birthDate: p.birthDate, isLeapMonth })
    // 真太阳时校正结果（未启用时是 {enabled:false}），供界面展示「填写 vs 校正」。
    const resolved = conv.ok ? this.resolveBirthForChart(p, conv) : null
    const solarView = resolved?.ok ? resolved.solar : { enabled: p.useTrueSolarTime === true, error: resolved?.error ?? null }
    return {
      id: p.id,
      name: p.name,
      gender: p.gender,
      calendarType,
      isLeapMonth,
      birthDate: p.birthDate,
      birthDateDisplay: conv.ok ? conv.display : p.birthDate,
      solarDate: conv.ok ? conv.solarDate : (calendarType === 'solar' ? p.birthDate : ''),
      lunarText: conv.ok ? conv.lunarText : '',
      leapMonthOfYear: conv.ok ? conv.leapMonthOfYear : 0,
      birthTimeIndex: p.birthTimeIndex,
      birthTimeLabel: timeLabel(p.birthTimeIndex),
      birthTimeShort: timeShort(p.birthTimeIndex),
      /* ---------- 真太阳时：填写值 vs 校正值都带出去 ---------- */
      useTrueSolarTime: p.useTrueSolarTime === true,
      birthClock: p.birthClock || '',
      regionName: p.regionName || '',
      regionProvince: p.regionProvince || '',
      regionLongitude: p.regionLongitude ?? null,
      regionLatitude: p.regionLatitude ?? null,
      solar: solarView,
      note: p.note ?? '',
      chartCount: charts.length,
      horoscopeCount: horoscopes.length,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }
  }

  /** 列出全部人员（列表页只读这一个接口）。 */
  async listPeople(request) {
    const people = await this.store.listPeople()
    const out = []
    for (const p of people) {
      const [charts, horoscopes] = await Promise.all([
        this.store.listCharts(p.id),
        this.store.listHoroscopes(p.id),
      ])
      out.push(this.personView(p, charts, horoscopes))
    }
    // 最近更新在前
    out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return { ok: true, people: out }
  }

  /**
   * 校验人员字段（新增/编辑共用）。
   *
   * 关键：历法（calendarType / isLeapMonth）与 birthDate 是**一个整体**——
   * 编辑时只改了历法没改日期，或只改了日期没改历法，都要按合并后的值校验，
   * 不能用旧值兜出一套自相矛盾的组合。
   */
  parsePersonFields(raw, partial = false, base = {}) {
    const r = (raw && typeof raw === 'object') ? raw : {}
    const out = {}
    if (!partial || r.name !== undefined) {
      const name = str(r.name, 80)
      if (!name) return fail('ziwei/invalid-name', '姓名不能为空')
      out.name = name
    }
    if (!partial || r.gender !== undefined) {
      const gender = str(r.gender, 10)
      if (gender !== '男' && gender !== '女') return fail('ziwei/invalid-gender', '性别只能是「男」或「女」')
      out.gender = gender
    }
    if (!partial || r.birthDate !== undefined || r.calendarType !== undefined || r.isLeapMonth !== undefined) {
      const calendarType = String(r.calendarType ?? base.calendarType ?? 'solar').trim() === 'lunar' ? 'lunar' : 'solar'
      const isLeapMonth = calendarType === 'lunar' && (r.isLeapMonth ?? base.isLeapMonth) === true
      const birthDate = normalizeDate(r.birthDate ?? base.birthDate)
      if (!birthDate) return fail('ziwei/invalid-date', '出生日期无效，请用 YYYY-M-D（例如 2000-8-16）')
      // 用完整排盘输入做历法校验（会检查闰月、每月天数、阳历真实日历日）
      const check = convertCalendarDate({ calendarType, birthDate, isLeapMonth })
      if (!check.ok) return check
      out.calendarType = calendarType
      out.isLeapMonth = isLeapMonth
      out.birthDate = birthDate
    }
    if (!partial || r.birthTimeIndex !== undefined) {
      const ti = Number(r.birthTimeIndex)
      if (!Number.isInteger(ti) || ti < 0 || ti > 12) {
        return fail('ziwei/invalid-time', '出生时辰必须是 0~12 的整数')
      }
      out.birthTimeIndex = ti
    }

    /* ---------- 真太阳时 ---------- */
    // 三个字段一起处理，因为它们互相依赖：开关变了地区才有意义，
    // 地区变了校正结果才成立。partial 更新时必须用 base 兜底。
    const touchesSolar = r.useTrueSolarTime !== undefined
      || r.regionName !== undefined
      || r.birthClock !== undefined
    if (!partial || touchesSolar) {
      const useTst = (r.useTrueSolarTime ?? base.useTrueSolarTime) === true
      out.useTrueSolarTime = useTst

      // 精确时刻（可选）：'HH:MM'。给了就能做分钟级校正，
      // 不给则退回「时辰中点」——精度差些但不用强迫用户填。
      const rawClock = r.birthClock !== undefined ? r.birthClock : base.birthClock
      if (rawClock === '' || rawClock === null) {
        out.birthClock = ''
      } else if (rawClock !== undefined) {
        const cm = parseClock(rawClock)
        if (cm === null) return fail('ziwei/invalid-clock', '出生时刻无效，请用 HH:MM（00:00~23:59）')
        out.birthClock = formatClock(cm)
      }

      if (useTst) {
        const regionName = str(r.regionName !== undefined ? r.regionName : base.regionName, 40)
        if (!regionName) {
          return fail('ziwei/invalid-region', '启用真太阳时后必须选择出生地区')
        }
        const found = findRegion(regionName)
        if (!found.ok) return found
        out.regionName = found.region.name
        out.regionProvince = found.region.province
        out.regionLongitude = found.region.lng
        out.regionLatitude = found.region.lat
      } else {
        // 关掉时清空地区，避免留下「开关关了但地区还在」的半状态。
        out.regionName = ''
        out.regionProvince = ''
        out.regionLongitude = null
        out.regionLatitude = null
      }
    }

    if (r.note !== undefined) out.note = str(r.note, 500)
    return { ok: true, fields: out }
  }

  /** 地区列表（真太阳时的地区选择器用；静态数据，只读）。 */
  listRegions() {
    return listRegionData()
  }

  /**
   * 真太阳时换算预览（表单实时对照用，纯计算不写盘）。
   *
   * 用户勾选「使用真太阳时」后，选地区、可选填精确时刻，
   * 这里立刻给出：校正前后的日期/时刻/时辰，以及两项修正各占多少。
   * 界面据此提示「已由 X 时校正为 Y 时」。
   *
   * @param {object} request { birthDate, calendarType?, isLeapMonth?, birthTimeIndex, birthClock?, regionName }
   */
  previewTrueSolarTime(request) {
    const q = unwrapArg(request)
    const calendarType = String(q.calendarType ?? 'solar').trim() === 'lunar' ? 'lunar' : 'solar'
    const isLeapMonth = calendarType === 'lunar' && q.isLeapMonth === true
    const birthDate = normalizeDate(q.birthDate)
    if (!birthDate) return fail('ziwei/invalid-date', '出生日期无效，请用 YYYY-M-D')

    const timeIndex = Number(q.birthTimeIndex)
    if (!Number.isInteger(timeIndex) || timeIndex < 0 || timeIndex > 12) {
      return fail('ziwei/invalid-time', '出生时辰必须是 0~12 的整数')
    }
    let birthClock = ''
    if (q.birthClock !== undefined && q.birthClock !== null && q.birthClock !== '') {
      const cm = parseClock(q.birthClock)
      if (cm === null) return fail('ziwei/invalid-clock', '出生时刻无效，请用 HH:MM')
      birthClock = formatClock(cm)
    }

    const conv = convertCalendarDate({ calendarType, birthDate, isLeapMonth })
    if (!conv.ok) return conv

    const found = findRegion(q.regionName)
    if (!found.ok) return found

    const clockMinutes = birthClock ? parseClock(birthClock) : null
    const r = resolveTrueSolarTime({
      solarDate: conv.solarDate,
      clockMinutes: Number.isFinite(clockMinutes) ? clockMinutes : undefined,
      timeIndex,
      region: { name: found.region.name, province: found.region.province, longitude: found.region.lng },
    })
    if (!r.ok) return r

    return {
      ok: true,
      region: r.region,
      // 填写值：用户报的北京时间
      written: {
        solarDate: conv.solarDate,
        lunarText: conv.lunarText,
        display: conv.display,
        timeIndex,
        timeLabel: timeLabel(timeIndex),
        clock: birthClock,
        clockLabel: birthClock || `（按${timeLabel(timeIndex)}中点 ${formatClock(midpointOfTimeIndex(timeIndex))}）`,
      },
      // 校正值：排盘实际用的
      corrected: {
        solarDate: r.trueSolar.solarDate,
        clock: r.trueSolar.clock,
        timeIndex: r.timeIndex,
        timeLabel: timeLabel(r.timeIndex),
        dayShift: r.trueSolar.dayShift,
      },
      correction: r.correction,
      baseSource: r.baseSource,
      timeIndexChanged: r.timeIndexChanged,
      dateChanged: r.dateChanged,
    }
  }

  /** 读一个人员的完整视图（档案 + 全部盘摘要）。 */
  async getPerson(request) {
    const { personId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const [charts, horoscopes] = await Promise.all([
      this.store.listCharts(personId),
      this.store.listHoroscopes(personId),
    ])
    return {
      ok: true,
      person: this.personView(p, charts, horoscopes),
      /** 一人一盘：最多一项，保留数组形状以兼容旧客户端。 */
      charts: charts.map(chartView),
    }
  }

  /** 新增人员。 */
  async addPerson(request) {
    const raw = unwrapArg(request)
    const parsed = this.parsePersonFields(raw, false)
    if (!parsed.ok) return parsed
    const t = now()
    const person = {
      id: newId('person'),
      ...parsed.fields,
      createdAt: t,
      updatedAt: t,
    }
    await this.store.upsertPerson(person)
    return { ok: true, person: this.personView(person, [], []) }
  }

  /**
   * 修改人员档案（只改传了的字段）。
   *
   * **生辰变更后自动重算星盘**：星盘由生辰唯一决定，一人一盘，
   * 所以只要影响排盘的字段（日期/时辰/性别/历法/闰月）变了，
   * 就用新档案覆盖旧的唯一盘。历史运限记录保留原样（它们记的是当时的盘）。
   */
  async updatePerson(request) {
    const { personId, patch = {} } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const parsed = this.parsePersonFields(patch, true, p)
    if (!parsed.ok) return parsed
    const next = { ...p, ...parsed.fields, updatedAt: now() }
    await this.store.upsertPerson(next)

    // 影响排盘的字段是否真的变了（只改名/备注不重算）
    // 影响排盘的字段：真太阳时的开关/地区/精确时刻也会改变最终时辰，
    // 漏掉它们会导致「勾了真太阳时但星盘还是旧盘」。
    const BIRTH_KEYS = [
      'birthDate', 'birthTimeIndex', 'gender', 'calendarType', 'isLeapMonth',
      'useTrueSolarTime', 'regionName', 'birthClock',
    ]
    const birthChanged = BIRTH_KEYS.some((k) => String(next[k]) !== String(p[k]))
    let chartRegenerated = false
    if (birthChanged) {
      const r = await ensureChart(this.store, personId, next, this.config, { force: true })
      chartRegenerated = r.ok
      // 重算失败不回滚档案：把失败原因如实带出去，用户至少知道星盘没跟上。
      if (!r.ok) {
        const [charts, horoscopes] = await Promise.all([
          this.store.listCharts(personId),
          this.store.listHoroscopes(personId),
        ])
        return {
          ok: true,
          person: this.personView(next, charts, horoscopes),
          chartRegenerated: false,
          warning: '档案已保存，但星盘重算失败：' + (r.error?.message ?? '未知错误'),
        }
      }
    }
    const [charts, horoscopes] = await Promise.all([
      this.store.listCharts(personId),
      this.store.listHoroscopes(personId),
    ])
    return { ok: true, person: this.personView(next, charts, horoscopes), chartRegenerated }
  }

  /**
   * 历法换算（表单实时对照预览用）。
   *
   * @param {object} request { calendarType, birthDate, isLeapMonth }
   * @returns {{ok:true, solarDate, lunarText, display, leapMonthOfYear} | {ok:false,error:object}}
   */
  convertDate(request) {
    const q = unwrapArg(request)
    return convertCalendarDate(q)
  }

  /**
   * 未来运势快捷查看（**会写入一条运限历史记录**）。
   *
   * preset: today | tomorrow | nYears | custom；years 为未来年数（1~30，默认 10）。
   *
   * 记录语义（用户明确要求）：
   *   · today / tomorrow → kind='daily'，按 (personId, kind='daily', targetDate)
   *     **按日期唯一去重**：同一天重复点复用已有记录，不新增。
   *   · nYears / custom  → kind='range'，每次新建一条记录，内含完整 fortune，
   *     可从历史列表点进去看时间轴详情。
   *
   * @param {object} request { personId, preset?, targetDate?, years? }
   */
  async getFortune(request) {
    const { personId, preset, targetDate, years } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const r = await ensureChart(this.store, personId, p, this.config)
    if (!r.ok) return r
    const built = buildFortune(r.chart.input, { preset, targetDate, years })
    if (!built.ok) return built
    const fortune = { ...built.fortune, personId, chartId: r.chart.id }
    const isDaily = fortune.preset === 'today' || fortune.preset === 'tomorrow'
    const kind = isDaily ? 'daily' : 'range'
    const chart = r.chart

    // 起算日的六层运限，作为这条记录的 horoscope（与手动查询记录同构）。
    const dayScope = generateHoroscope(chart.input, fortune.baseDate, chart.input.timeIndex)
    const scopeSummary = dayScope.ok ? dayScope.summary : null

    const record = {
      id: newId('horo'),
      personId,
      chartId: chart.id,
      chartLabel: chart.label ?? '',
      createdAt: now(),
      kind,
      targetDate: fortune.baseDate,
      timeIndex: chart.input.timeIndex,
      label: isDaily
        ? (fortune.preset === 'today' ? '今天' : '明天') + ' ' + fortune.baseDate
        : fortune.scopeLabel,
      input: chart.input,
      summary: scopeSummary,
      horoscope: dayScope.ok ? dayScope.horoscope : null,
      fortune: isDaily ? null : fortune,
      years: isDaily ? null : fortune.years,
      baseDate: fortune.baseDate,
      scopeLabel: isDaily ? '' : fortune.scopeLabel,
      preset: fortune.preset,
    }

    let saved
    if (isDaily) {
      saved = await this.store.addHoroscopeOnce(
        personId,
        record,
        (x) => x && x.kind === 'daily' && String(x.targetDate) === String(fortune.baseDate),
      )
    } else {
      await this.store.addHoroscope(personId, record)
      saved = { record, deduplicated: false }
    }
    const s = saved.record
    return {
      ok: true,
      fortune,
      record: {
        id: s.id, personId: s.personId, chartId: s.chartId, chartLabel: s.chartLabel ?? '',
        createdAt: s.createdAt, kind: s.kind ?? 'manual',
        targetDate: s.targetDate, timeIndex: s.timeIndex,
        timeIndexLabel: timeLabel(s.timeIndex), label: s.label,
        input: s.input, summary: s.summary,
        years: s.years ?? null, baseDate: s.baseDate ?? s.targetDate,
        scopeLabel: s.scopeLabel ?? '',
        deduplicated: saved.deduplicated,
      },
      deduplicated: saved.deduplicated,
    }
  }

  /** 删除人员（连带其全部盘与运限记录）。 */
  async deletePerson(request) {
    const { personId } = unwrapArg(request, 'personId')
    const deleted = await this.store.deletePerson(personId)
    if (!deleted) return fail('ziwei/not-found', '人员不存在：' + personId)
    return { ok: true, deleted: true, personId }
  }

  /* ==================== 星盘 ==================== */

  /**
   * 列出某人的星盘（一人一盘，最多一项；不含完整 astrolabe）。
   *
   * 与 getChart 同一套 get-or-create 语义：没盘就按档案生成一次，
   * 让列表/详情接口在用户还没打开星盘页时也能如实报出 1 张盘。
   */
  async listCharts(request) {
    const { personId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const r = await ensureChart(this.store, personId, p, this.config)
    if (!r.ok) return r
    return { ok: true, charts: r.chart ? [chartView(r.chart)] : [], generated: r.generated }
  }

  /**
   * 读该人员唯一的星盘（含 iztro 原始 JSON）。
   *
   * 关键语义：**按需生成一次并持久化**。星盘由生辰唯一决定，
   * 用户第一次打开星盘页时才生成，之后永远复用这一张，不重复排盘。
   * `generated=true` 表示本次是新生成的，UI 可据此提示一次。
   */
  async getChart(request) {
    const { personId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const r = await ensureChart(this.store, personId, p, this.config)
    if (!r.ok) return r
    return { ok: true, chart: r.chart, generated: r.generated }
  }

  /**
   * 重新生成星盘（覆盖旧的唯一盘）。
   *
   * 这是「一人一盘」模型下唯一允许的写盘入口，属于显式动作：
   * 默认拒绝（`force` 必须为 true），避免误点把已保存的盘重算掉。
   * `input` 可覆盖生辰 / 语言 / 闰月处理，用于试算其它参数。
   */
  async createChart(request) {
    const { personId, label, input, force } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    if (force !== true) {
      return fail('ziwei/force-required', '重新生成需显式传 force=true；平时查看星盘请用 getChart（自动复用）')
    }
    const r = await ensureChart(this.store, personId, p, this.config, {
      force: true, input, label: str(label, 120),
    })
    if (!r.ok) return r
    return { ok: true, chart: chartView(r.chart), chartId: r.chart.id, generated: true }
  }

  /** 删除该人员唯一的盘（连带其运限记录）。 */
  async deleteChart(request) {
    const { personId, chartId } = unwrapArg(request, 'personId')
    const charts = await this.store.listCharts(personId)
    const target = chartId ? charts.find((c) => c.id === chartId) : charts[0]
    if (!target) return fail('ziwei/not-found', '该人员还没有星盘')
    const deleted = await this.store.deleteChart(personId, target.id)
    if (!deleted) return fail('ziwei/not-found', '星盘不存在：' + target.id)
    return { ok: true, deleted: true, personId, chartId: target.id }
  }

  /* ==================== 运限查询历史 ==================== */

  /** 列出运限查询历史（可按 chartId 过滤）。 */
  async listHoroscopes(request) {
    const { personId, chartId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    let records = await this.store.listHoroscopes(personId)
    if (chartId) records = records.filter((r) => r.chartId === chartId)
    // 最新在前
    records = records.slice().sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return {
      ok: true,
      records: records.map((r) => ({
        id: r.id, personId: r.personId, chartId: r.chartId, chartLabel: r.chartLabel ?? '',
        createdAt: r.createdAt, targetDate: r.targetDate, timeIndex: r.timeIndex,
        timeIndexLabel: timeLabel(r.timeIndex), label: r.label,
        input: r.input, summary: r.summary,
        kind: r.kind ?? 'manual',
        years: r.years ?? null,
        baseDate: r.baseDate ?? r.targetDate,
        scopeLabel: r.scopeLabel ?? '',
        deduplicated: r.deduplicated ?? false,
        // 列表只带摘要：全文可能上万字，列表页不需要。
        analysisSummary: r.analysis?.summary ?? '',
        analysisUpdatedAt: r.analysis?.updatedAt ?? '',
      })),
    }
  }

  /** 读一条运限查询的完整详情（含 iztro 原始 JSON 与对应星盘）。 */
  async getHoroscope(request) {
    const { personId, horoscopeId } = unwrapArg(request, 'personId')
    const records = await this.store.listHoroscopes(personId)
    const record = records.find((r) => r.id === horoscopeId)
    if (!record) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)
    const charts = await this.store.listCharts(personId)
    const chart = charts.find((c) => c.id === record.chartId) ?? charts[0] ?? null
    return {
      ok: true,
      record,
      horoscope: record.horoscope,
      astrolabe: chart?.astrolabe ?? null,
      // kind='range'（未来 N 年）记录带完整时间轴，供详情页渲染。
      fortune: record.fortune ?? null,
      chart: chart ? {
        id: chart.id, label: chart.label, createdAt: chart.createdAt,
        input: chart.input, summary: chart.summary,
      } : null,
    }
  }

  /**
   * 「点击 AI 分析」时的轻量上下文（纯读）。
   *
   * 关键设计：**这里不返回任何数据**。返回的 `starterPrompt` 只有任务说明
   * 和两个 id（personId / horoscopeId），数据由 `ziwei_analysis` 工具在
   * 新会话里现取。理由：
   *   · 把完整 JSON 写进对话最贵——实测 30 年记录光数据就 43KB；
   *   · 对话里应当是「问题」，数据应当是工具的结果，职责不混；
   *   · 工具实时读库，分析用的永远是当前数据而不是点击那一刻的快照。
   *
   * UI 只需要 `starterPrompt`；`meta` 供诊断/排查用。
   *
   * @param {object} request { personId, horoscopeId }
   */
  async buildAnalysisContext(request) {
    const { personId, horoscopeId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const records = await this.store.listHoroscopes(personId)
    const record = records.find((r) => r.id === horoscopeId)
    if (!record) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)
    const charts = await this.store.listCharts(personId)
    const chart = charts.find((c) => c.id === record.chartId) ?? charts[0] ?? null

    const personView = this.personView(p, charts, records)
    const context = {
      person: {
        id: personView.id,
        name: personView.name,
        gender: personView.gender,
        calendarType: personView.calendarType,
        birthDate: personView.birthDate,
        birthDateDisplay: personView.birthDateDisplay,
        birthTimeLabel: personView.birthTimeLabel,
        solarDate: personView.solarDate,
      },
      chart: chart ? { id: chart.id, label: chart.label, summary: chart.summary } : null,
      record: {
        id: record.id,
        kind: record.kind ?? 'manual',
        targetDate: record.targetDate,
        timeIndex: record.timeIndex,
        timeIndexLabel: timeLabel(record.timeIndex),
        label: record.label,
        years: record.years ?? null,
        baseDate: record.baseDate ?? record.targetDate,
        scopeLabel: record.scopeLabel ?? '',
        createdAt: record.createdAt,
      },
    }
    context.starterPrompt = renderStarterPrompt(context)
    return { ok: true, context }
  }

  /**
   * 取某条运限记录的分析资料（纯读，供 `ziwei_analysis` 工具使用）。
   *
   * 返回**已经排版好的人话摘要**，不是 JSON：星曜位置、亮度、四化、
   * 落宫都已经摊平成一行一条，模型不需要解析嵌套数组。
   *
   * @param {object} request { personId, horoscopeId }
   * @returns {{ok:true, brief:string, meta:object} | {ok:false, error:object}}
   */
  async getAnalysisBrief(request) {
    const { personId, horoscopeId } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)
    const records = await this.store.listHoroscopes(personId)
    const record = records.find((r) => r.id === horoscopeId)
    if (!record) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)
    const charts = await this.store.listCharts(personId)
    const chart = charts.find((c) => c.id === record.chartId) ?? charts[0] ?? null
    if (!chart) return fail('ziwei/no-chart', '该人员还没有星盘，请先排盘')

    const personView = this.personView(p, charts, records)
    const brief = renderAnalysisBrief({
      person: personView,
      chart,
      record,
      horoscope: record.horoscope ?? null,
      fortune: record.fortune ?? null,
    })

    return {
      ok: true,
      brief,
      meta: {
        personId,
        personName: personView.name,
        horoscopeId: record.id,
        chartId: chart.id,
        kind: record.kind ?? 'manual',
        targetDate: record.targetDate,
        scopeLabel: record.scopeLabel ?? '',
        years: record.years ?? null,
        /** 摘要字符数，供测试与诊断确认「没有退化成 JSON」。 */
        length: brief.length,
        hasTimeline: Boolean(record.fortune?.timeline?.length),
      },
    }
  }

  /**
   * 定盘：给同一天的全部 13 个时辰各排一张盘，供用户对照判断。
   *
   * 场景：很多用户不记得出生时辰。传统做法是把候选时辰的盘都看一遍，
   * 挑出与自己性格吻合的那张。本方法只**取数据**，解读交给 AI。
   *
   * 不需要人员已存在：可以只给 性别 + 生日 就试算。
   *
   * @param {object} request { gender, birthDate, calendarType?, isLeapMonth? }
   */
  async listTimeCandidates(request) {
    const q = unwrapArg(request)
    // 姓名可选：填了就带进提示词，让 AI 建档时直接用，
    // 不必回头问用户「叫什么」。没填则提示词里用「本人」兜底。
    const name = str(q.name, 80)
    const gender = str(q.gender, 10)
    if (gender !== '男' && gender !== '女') {
      return fail('ziwei/invalid-gender', '性别只能是「男」或「女」')
    }
    const calendarType = String(q.calendarType ?? 'solar').trim() === 'lunar' ? 'lunar' : 'solar'
    const isLeapMonth = calendarType === 'lunar' && q.isLeapMonth === true
    const birthDate = normalizeDate(q.birthDate)
    if (!birthDate) {
      return fail('ziwei/invalid-date', '出生日期无效，请用 YYYY-M-D')
    }
    // 先验历法合法性（闰月是否存在、每月天数、是否是真实日历日）
    const check = convertCalendarDate({ calendarType, birthDate, isLeapMonth })
    if (!check.ok) return check

    const built = buildTimeCandidates(
      { gender, birthDate, calendarType, isLeapMonth },
      { fixLeap: this.config.fixLeap, language: this.config.language },
    )
    if (!built.ok) return built

    // 提示词也由 Host 生成：UI 只负责把它交给 startSession，
    // 客户端一行分析话术都不写（与运限分析同一原则）。
    const starterPrompt = renderTimePrompt({ name, gender, birthDate, calendarType, isLeapMonth })

    return {
      ok: true,
      name,
      gender,
      birthDate,
      calendarType,
      isLeapMonth,
      display: check.display,
      solarDate: check.solarDate,
      lunarText: check.lunarText,
      starterPrompt,
      ...built,
    }
  }

  /**
   * 把 AI 分析结果回填到某条运限记录（写）。
   *
   * 记录结构上新增可选字段 `analysis`：
   *   {
   *     content:  string   完整分析全文（Markdown）
   *     summary:  string   100 字内的摘要，列表展示用
   *     createdAt: ISO     首次回填时间
   *     updatedAt: ISO     最近一次回填时间
   *     revisions: number  回填次数（同一记录重复分析会累加，保留最新一版正文）
   *   }
   *
   * 为什么不存多版历史：运限记录本身是「一次查询的快照」，分析是对它的
   * 解读。用户重跑分析通常是想覆盖（模型换了个说法），保留多版反而难找。
   * 所以只留最新一版，但用 revisions 计数让人知道被覆盖过。
   *
   * @param {object} request { personId, horoscopeId, content, summary? }
   */
  async saveAnalysis(request) {
    const { personId, horoscopeId, content, summary } = unwrapArg(request, 'personId')
    if (!personId || !horoscopeId) {
      return fail('ziwei/invalid-input', '缺少 personId 或 horoscopeId')
    }
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)

    const body = String(content ?? '').trim()
    if (!body) return fail('ziwei/invalid-analysis', '分析内容不能为空')
    // 单条分析上限：够长（万字级报告）但不至于把 JSON 文件撑爆。
    const MAX = 60000
    if (body.length > MAX) {
      return fail('ziwei/analysis-too-long', `分析内容 ${body.length} 字符，超过上限 ${MAX}`)
    }

    const records = await this.store.listHoroscopes(personId)
    const existing = records.find((r) => r.id === horoscopeId)
    if (!existing) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)

    const t = now()
    const prev = existing.analysis
    // 摘要：显式传入优先，否则从正文自动截取（去掉 Markdown 标记后取前 100 字）。
    const auto = autoSummary(body)
    const brief = String(summary ?? '').trim() || auto
    const analysis = {
      content: body,
      summary: brief.slice(0, 200),
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
      revisions: (Number(prev?.revisions) || 0) + 1,
    }

    const saved = await this.store.updateHoroscope(personId, horoscopeId, { analysis })
    if (!saved) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)

    return {
      ok: true,
      horoscopeId,
      analysis: {
        summary: analysis.summary,
        createdAt: analysis.createdAt,
        updatedAt: analysis.updatedAt,
        revisions: analysis.revisions,
        length: body.length,
        /** 是否为自动截取的摘要（便于调用方判断要不要自己补一句）。 */
        summaryAuto: !String(summary ?? '').trim(),
        replaced: Boolean(prev),
      },
    }
  }

  /**
   * 新增一次运限查询（自动写入历史）。
   *
   * 一人一盘：不传 chartId 时自动取得（必要时生成）该人员唯一的星盘，
   * 所以 UI 不需要让用户「先排盘再查运限」。传了 chartId 则做存在性校验。
   *
   * @param {object} request { personId, chartId?, targetDate, timeIndex?, label? }
   */
  async createHoroscope(request) {
    const { personId, chartId, targetDate, timeIndex, label } = unwrapArg(request, 'personId')
    const p = await this.store.loadPerson(personId)
    if (!p) return fail('ziwei/not-found', '人员不存在：' + personId)

    let chart
    if (chartId) {
      chart = (await this.store.listCharts(personId)).find((c) => c.id === chartId)
      if (!chart) return fail('ziwei/not-found', '星盘不存在：' + chartId)
    } else {
      const r = await ensureChart(this.store, personId, p, this.config)
      if (!r.ok) return r
      chart = r.chart
    }

    // 默认用当前日期与该盘的出生时辰；UI 会显式传目标日期/时辰
    const date = normalizeDate(targetDate) || new Date().toISOString().slice(0, 10)
    const ti = Number.isInteger(Number(timeIndex)) && Number(timeIndex) >= 0 && Number(timeIndex) <= 12
      ? Number(timeIndex)
      : Number(chart.input?.timeIndex ?? 0)

    const generated = generateHoroscope(chart.input, date, ti)
    if (!generated.ok) return generated

    const record = {
      id: newId('horo'),
      personId,
      // 用实际使用的那张盘的 id：chartId 可省略，省略时 ensureChart 会给出唯一盘。
      chartId: chart.id,
      chartLabel: chart.label ?? '',
      createdAt: now(),
      kind: 'manual',
      targetDate: date,
      timeIndex: ti,
      label: str(label, 200) || `${date} ${timeShort(ti)} 运限`,
      input: chart.input,
      summary: generated.summary,
      horoscope: generated.horoscope,
    }
    await this.store.addHoroscope(personId, record)
    return {
      ok: true,
      record: {
        id: record.id, personId, chartId: chart.id, chartLabel: record.chartLabel,
        createdAt: record.createdAt, targetDate: record.targetDate,
        timeIndex: record.timeIndex, timeIndexLabel: timeLabel(ti),
        label: record.label, input: record.input, summary: record.summary,
        kind: 'manual', years: null, baseDate: date, scopeLabel: '',
        deduplicated: false,
      },
    }
  }

  /** 删除一条运限查询。 */
  async deleteHoroscope(request) {
    const { personId, horoscopeId } = unwrapArg(request, 'personId')
    const deleted = await this.store.deleteHoroscope(personId, horoscopeId)
    if (!deleted) return fail('ziwei/not-found', '运限记录不存在：' + horoscopeId)
    return { ok: true, deleted: true, personId, horoscopeId }
  }
}

/** 暴露给浏览器的 Remote 方法名（**必须**与 lib/client.js 的 descriptors 顺序一致）。 */
export const REMOTE_METHODS = [
  'diagnostics',
  'listPeople',
  'getPerson',
  'addPerson',
  'updatePerson',
  'deletePerson',
  'listCharts',
  'getChart',
  'createChart',
  'deleteChart',
  'listHoroscopes',
  'getHoroscope',
  'createHoroscope',
  'deleteHoroscope',
  // 历法换算、未来运势、AI 分析上下文，追加在末尾；
  // client.js 的 descriptor 顺序必须同步。
  'convertDate',
  'getFortune',
  'buildAnalysisContext',
  // 分析资料读取与回填：新增在末尾，client.js 的 descriptor 顺序必须同步。
  'getAnalysisBrief',
  'saveAnalysis',
  // 定盘：同一天 13 个时辰的候选盘。
  'listTimeCandidates',
  // 真太阳时：地区列表与换算预览。
  'listRegions',
  'previewTrueSolarTime',
]

/** Typert Remote 标记的 descriptor key。 */
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** 把方法标记为可 Remote 调用。 */
function markRemoteMethods(instance, methods) {
  const proto = Object.getPrototypeOf(instance)
  if (!proto) return
  Object.defineProperty(proto, REMOTE_METHODS_KEY, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map((m) => Object.freeze({ method: m, invocation: Object.freeze({ kind: 'direct' }) }))),
    }),
  })
}

/** 插件入口：注册服务 + Remote 面 + Agent 工具。 */
export function apply(ctx, config) {
  const svc = new ZiweiWorkbench(ctx, config)
  // Cordis 要求先 provide 再 set
  ctx.provide('ziweiWorkbench')
  ctx.set('ziweiWorkbench', svc)

  markRemoteMethods(svc, REMOTE_METHODS)

  // Agent 工具：可选注册
  ctx.inject(['tools'], (toolsCtx) => {
    const disposers = buildZiweiTools(toolsCtx, svc)
    toolsCtx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }, 'ziwei:tools')
  })

  // 技能包：可选注册。把 skills/ziwei-doushu/ 挂进 ctx.skills，
  // 模型在需要解盘时按需加载，而不是每次分析都往提示词里塞学习资料。
  ctx.inject(['skills'], (skillCtx) => {
    const dispose = registerSkills(skillCtx)
    skillCtx.effect(() => dispose, 'ziwei:skills')
  })

  return () => { /* ctx.set 由 Cordis 在 fiber 销毁时回收 */ }
}
