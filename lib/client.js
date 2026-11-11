/**
 * 紫微斗数工作台 — 浏览器半区（lib/client.js）。
 *
 * 布局（左列表 / 右详情）：
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ 顶部工具条：标题 + 新增人员                               │
 *   ├───────────────────────────────────┬──────────────────────┤
 *   │ 左侧：人员选择列表                │ 右侧：人员详情区（Tab）│
 *   │   点击选中 / 删除                 │   详情/星盘/运限历史  │
 *   └───────────────────────────────────┴──────────────────────┘
 *
 * 约束：
 *  · 不使用任何 Harness Client 包，React 由浏览器模块表提供；
 *  · 只用 --dsw-alias-* 主题令牌（可带 fallback），不写死大面积颜色；
 *  · 所有资源在 apply 内用 ctx.effect 登记并返回清理器；
 *  · 不写 import / export，整体包在 window.__ModuleLoader__.load 里。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ziweidoushu',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    /** 主面板 key，同时是侧栏入口 id。 */
    const PANEL_ID = 'ziwei'

    /* ================================================================
       1. Remote 描述符表
       ⚠️ 必须与 Host 的 REMOTE_METHODS 顺序**逐位一致**：
          只登记一边的后果是 api.xxx 为 undefined，一点就同步抛 TypeError，
          且没有地方接住，表现为「按钮点了没反应」。
       ================================================================ */

    /**
     * 严格 codec：Remote 载体要求对象具备 mode/typeSymbol/schema/create。
     * 纯 JS 包没有构建步骤生成这些，只能手写（形状与 Gateway 期望一致）。
     */
    function strict(kind) {
      const schema = { parse: (value) => shape(value, kind) }
      return { mode: 'strict', typeSymbol: `dsh-ziweidoushu#${kind}`, schema, create: () => schema }
    }

    /** 一个形状的校验（只支持本项目用到的形状）。 */
    function shape(value, kind) {
      if (kind === 'nullable') return value === null || value === undefined ? null : value
      if (value === undefined || value === null) throw new TypeError('expected ' + kind)
      if (kind === 'object' && (typeof value !== 'object' || Array.isArray(value))) throw new TypeError('expected object')
      if (kind === 'array' && !Array.isArray(value)) throw new TypeError('expected array')
      if (kind === 'string' && typeof value !== 'string') throw new TypeError('expected string')
      return value
    }

    /**
     * 一个 Remote 方法描述符。
     * Host 侧所有方法的形参名都是 `request`，所以 wire 名必须是 'request'；
     * diagnostics() 无参，省略 wire（**不能**传空对象，否则参数个数校验会挂）。
     */
    function desc(method, wire) {
      return {
        id: `dsh-ziweidoushu#ziwei/${method}`,
        service: 'ziweiWorkbench',
        namespace: 'ziwei',
        method,
        invocation: { kind: 'direct' },
        parameters: wire === undefined
          ? []
          : [{ name: wire, wire, source: 'json', codec: strict('object') }],
        result: strict('object'),
      }
    }

    /** 端点描述表（顺序 = Host REMOTE_METHODS 顺序）。 */
    const CONTRIBUTION = {
      package: 'dsh-ziweidoushu',
      descriptors: [
        desc('diagnostics'),
        desc('listPeople', 'request'),
        desc('getPerson', 'request'),
        desc('addPerson', 'request'),
        desc('updatePerson', 'request'),
        desc('deletePerson', 'request'),
        desc('listCharts', 'request'),
        desc('getChart', 'request'),
        desc('createChart', 'request'),
        desc('deleteChart', 'request'),
        desc('listHoroscopes', 'request'),
        desc('getHoroscope', 'request'),
        desc('createHoroscope', 'request'),
        desc('deleteHoroscope', 'request'),
        // 实时历法对照预览：Host 的 REMOTE_METHODS 末尾同步追加，顺序必须一致。
        desc('convertDate', 'request'),
        // 快捷运势（今天 / 明天 / 未来 N 年）时间轴：会写入一条运限历史记录，今天/明天按日期去重。
        desc('getFortune', 'request'),
        // 构建 AI 分析上下文：只返回一句任务说明 + 两个 id，不含数据。
        desc('buildAnalysisContext', 'request'),
        // 取某条运限记录的解盘资料（工具用的人话摘要，UI 也可复用）。
        desc('getAnalysisBrief', 'request'),
        // 把 AI 分析结果回填到记录（通常是 Agent 工具调用；UI 备用入口）。
        desc('saveAnalysis', 'request'),
        // 定盘：同一天 13 个时辰的候选盘。
        desc('listTimeCandidates', 'request'),
        // 真太阳时：地区列表（无参）与换算预览。
        desc('listRegions'),
        desc('previewTrueSolarTime', 'request'),
      ],
    }

    /* ================================================================
       2. Remote 调用辅助（unwrap / 失败翻译 / callRemote）
       ================================================================ */

    /**
     * 解包 Remote 结果。
     * Remote 调用不会 reject：成功是 {ok:true,value}，失败是 {ok:false,error}。
     * Host 的业务失败是正常返回的 {ok:false,error}，Gateway 会把它整个塞进
     * value，所以还要再解一层，否则失败会被当成成功（点了没反应）。
     */
    function unwrap(r) {
      if (!r || typeof r !== 'object') return { ok: false, error: { message: '空响应' } }
      if (r.ok === false) return { ok: false, error: r.error ?? { message: '未知错误' } }
      const value = ('value' in r ? r.value : r)
      if (value && typeof value === 'object' && value.ok === false) {
        return { ok: false, error: value.error ?? { message: '未知错误' } }
      }
      return { ok: true, value }
    }

    /** 传输层故障（请求没送达 / 响应没回来）。 */
    function isTransportError(error) {
      const msg = String(error?.message ?? '')
      if (!msg) return false
      if (error?.code === 'gateway/cancelled' || msg.includes('was aborted')) return false
      return /^client api: .+ failed: /u.test(msg)
    }

    /** 会话失效（宿主重启过，页面还是旧会话）——重试无意义。 */
    function isAuthError(error) {
      const msg = String(error?.message ?? error ?? '')
      return /HTTP (401|403)\b/u.test(msg)
    }

    /** 客户端调用形状错误（参数个数对不上）——插件自身 bug，重试无意义。 */
    function isClientShapeError(error) {
      const msg = String(error?.message ?? error ?? '')
      return /expected \d+ argument\(s\)/u.test(msg)
    }

    /** 把一次 Remote 失败翻译成可操作的中文。 */
    function describeRemoteFailure(raw, opts = {}) {
      const text = String(raw ?? '未知错误')
      const origin = opts.origin || '未知来源'
      const retries = opts.retries ?? 1
      if (isAuthError(text)) {
        return {
          auth: true,
          message: '宿主会话已失效：DSH 服务重启过，而这个页面还是重启前打开的。'
            + '重试没有意义，请按 F5 刷新页面后重试。'
            + '（当前页面来源：' + origin + '）原始错误：' + text,
        }
      }
      return {
        auth: false,
        message: '连不上宿主服务：请求没能送达，或响应没能回来。'
          + '已自动重试 ' + retries + ' 次仍失败。'
          + '常见原因：DSH 服务已退出或正在重启；'
          + '也可能是这个页面开在了一个已经停掉的实例上。'
          + '当前页面来源：' + origin
          + '——请对照 DSH 启动时打印的网址确认是不是同一个实例；'
          + '如果 DSH 重启过，请按 F5 刷新页面。原始错误：' + text,
      }
    }

    /**
     * 调用一个 Remote 方法，并把「传输层故障」与「业务失败」分开。
     * 用法：await callRemote(remoteRef.current, 'getPerson', { request: { personId } })
     */
    async function callRemote(remote, method, args, opts = {}) {
      const retries = opts.retries ?? 1
      // 无参方法必须真的不传参：Gateway 会核对参数个数，传 {} 也算 1 个参数。
      const invoke = args === undefined
        ? () => remote[method]()
        : () => remote[method](args)
      let last = null
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = unwrap(await invoke())
          if (!r.ok && (isAuthError(r.error) || isClientShapeError(r.error))) { last = r; break }
          if (!r.ok && isTransportError(r.error)) {
            last = r
            if (attempt < retries) {
              await new Promise((r2) => setTimeout(r2, 400 * (attempt + 1)))
              continue
            }
            break
          }
          return r.ok ? r : { ok: false, error: r.error, transport: false }
        } catch (e) {
          const message = String(e?.message ?? e)
          last = { ok: false, error: { code: 'gateway/internal', message } }
          if (isClientShapeError(message)) break
          if (attempt < retries) {
            await new Promise((r2) => setTimeout(r2, 400 * (attempt + 1)))
            continue
          }
          break
        }
      }
      const raw = last?.error?.message ?? '未知错误'
      console.error('[ziwei] Remote 调用失败 ' + method + '：', raw, last?.error ?? '')
      if (isClientShapeError(raw)) {
        return {
          ok: false,
          transport: false,
          error: { code: last?.error?.code ?? 'gateway/internal', message: '这是插件自身的调用错误（与你的操作无关）：' + raw },
        }
      }
      const described = describeRemoteFailure(raw, {
        origin: (typeof location !== 'undefined' && location.origin) ? location.origin : '未知来源',
        retries,
      })
      return {
        ok: false,
        transport: !described.auth,
        error: { code: last?.error?.code ?? 'gateway/internal', message: described.message },
      }
    }

    /* ================================================================
       3. 常量与小工具
       ================================================================ */

    /**
     * 出生时辰：index 必须与 iztro 的 0..12 完全一致。
     * 0 早子时，1 丑时，…，11 亥时，12 晚子时。
     */
    const TIME_OPTIONS = [
      { index: 0, label: '早子时', range: '00:00~01:00' },
      { index: 1, label: '丑时', range: '01:00~03:00' },
      { index: 2, label: '寅时', range: '03:00~05:00' },
      { index: 3, label: '卯时', range: '05:00~07:00' },
      { index: 4, label: '辰时', range: '07:00~09:00' },
      { index: 5, label: '巳时', range: '09:00~11:00' },
      { index: 6, label: '午时', range: '11:00~13:00' },
      { index: 7, label: '未时', range: '13:00~15:00' },
      { index: 8, label: '申时', range: '15:00~17:00' },
      { index: 9, label: '酉时', range: '17:00~19:00' },
      { index: 10, label: '戌时', range: '19:00~21:00' },
      { index: 11, label: '亥时', range: '21:00~23:00' },
      { index: 12, label: '晚子时', range: '23:00~00:00' },
    ]

    const GENDER_OPTIONS = [
      { value: '男', label: '男' },
      { value: '女', label: '女' },
    ]

    const TABS = [
      { k: 'person', label: '人员详情' },
      { k: 'chart', label: '星盘信息' },
      { k: 'horoscope', label: '运限历史' },
    ]

    const SCOPE_ROWS = [
      ['decadal', '大限'], ['age', '小限'], ['yearly', '流年'],
      ['monthly', '流月'], ['daily', '流日'], ['hourly', '流时'],
    ]

    /**
     * 命盘 4×4 网格的地支 → (row,col) 定位表（row/col 从 0 开始）。
     * 巳午未申 / 辰　　酉 / 卯　　戌 / 寅丑子亥，中宫占 row1..2 / col1..2。
     * 首选按 palace.earthlyBranch 定位；缺失时按 iztro 的 index 兜底。
     */
    const PALACE_SLOTS = [
      { branch: '巳', row: 0, col: 0 },
      { branch: '午', row: 0, col: 1 },
      { branch: '未', row: 0, col: 2 },
      { branch: '申', row: 0, col: 3 },
      { branch: '辰', row: 1, col: 0 },
      { branch: '酉', row: 1, col: 3 },
      { branch: '卯', row: 2, col: 0 },
      { branch: '戌', row: 2, col: 3 },
      { branch: '寅', row: 3, col: 0 },
      { branch: '丑', row: 3, col: 1 },
      { branch: '子', row: 3, col: 2 },
      { branch: '亥', row: 3, col: 3 },
    ]
    /** iztro palaces[i].index → 地支（0 寅, 1 卯, …, 11 丑）。 */
    const INDEX_BRANCH = ['寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '子', '丑']
    /** 四化徽标：禄绿 / 权紫蓝 / 科青 / 忌红。 */
    const MUTAGEN_CLASS = { 禄: 'lu', 权: 'quan', 科: 'ke', 忌: 'ji' }

    /** 从 astrolabe 的 palaces[] 生成 12 个带网格坐标的宫位。 */
    function layoutPalaces(astrolabe) {
      const palaces = Array.isArray(astrolabe?.palaces) ? astrolabe.palaces : []
      const cells = []
      PALACE_SLOTS.forEach((slot) => {
        let p = palaces.find((x) => x && String(x.earthlyBranch ?? '').trim() === slot.branch)
        if (!p) p = palaces.find((x) => x && INDEX_BRANCH[Number(x.index)] === slot.branch)
        cells.push({ ...slot, palace: p || null })
      })
      return cells
    }

    /** 主星亮度 → 中文短标（iztro brightness 本身多为中文，取不到就空）。 */
    function brightnessLabel(s) {
      const b = s?.brightness
      return (b === undefined || b === null || b === '') ? '' : String(b)
    }

    /** 星曜四化：把 mutagen（禄/权/科/忌）渲染成彩色小徽标。 */
    function MutagenTag({ text }) {
      const t = String(text ?? '').trim()
      if (!t) return null
      return h('span', { className: 'zw-mutagen ' + (MUTAGEN_CLASS[t] || ''), title: '四化 · ' + t }, t)
    }

    /** Date input(YYYY-MM-DD) / 任意 YYYY-M-D → iztro 的 YYYY-M-D。 */
    function toSolarDate(v) {
      const m = String(v ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
      if (!m) return ''
      return m[1] + '-' + Number(m[2]) + '-' + Number(m[3])
    }

    /** YYYY-M-D → date input 需要的 YYYY-MM-DD。 */
    function toDateInput(v) {
      const m = String(v ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
      if (!m) return ''
      return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0')
    }

    /** 今天的 YYYY-MM-DD（date input 用），按本地时区。 */
    function todayDateInput() {
      const d = new Date()
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    /* ---- 农历表单用的常量与纯函数（不引入任何历法库） ---- */
    const LUNAR_YEARS = (() => {
      const a = []
      for (let y = 1900; y <= 2100; y++) a.push(y)
      return a
    })()
    const LUNAR_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月']
    const LUNAR_DAYS = [
      '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
      '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
      '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
    ]
    /** 从 'YYYY-M-D' 解析年月日；解析不出用今天兜底。 */
    function parseYMD(v) {
      const m = String(v ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
      if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
      const t = new Date()
      return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }
    }
    /** 农历三下拉拼回 'YYYY-M-D'（月份数字 1..12，不带负号）。 */
    function lunarToYMD(y, m, d) {
      return String(y) + '-' + String(m) + '-' + String(d)
    }
    /** 姓名首字 → 稳定的柔和头像色（纯计算，取一组主题色相）。 */
    function avatarHue(name) {
      const s = String(name ?? '')
      let code = 0
      for (let i = 0; i < s.length; i++) code = (code * 31 + s.charCodeAt(i)) >>> 0
      return code % 360
    }
    function avatarStyle(name) {
      const hue = avatarHue(name)
      return {
        background: 'hsla(' + hue + ',52%,46%,.28)',
        borderColor: 'hsla(' + hue + ',60%,62%,.55)',
        color: 'var(--dsw-alias-text-1,#e6eaf2)',
      }
    }

    function timeOptionOf(idx) {
      const n = Number(idx)
      return TIME_OPTIONS.find((o) => o.index === n) ?? null
    }

    function timeShort(idx) {
      const o = timeOptionOf(idx)
      return o ? o.label : ('时辰 ' + String(idx ?? '—'))
    }

    /** 出生时辰（含时间范围）。 */
    function timeLabel(idx) {
      const o = timeOptionOf(idx)
      return o ? (o.label + '（' + o.range + '）') : ('时辰 ' + String(idx ?? '—'))
    }

    function fmtTime(v) {
      if (v === undefined || v === null || v === '') return '—'
      const s = String(v)
      const d = new Date(s)
      if (!isNaN(d.getTime())) return d.toLocaleString('zh-CN', { hour12: false })
      return s
    }

    /** 带符号的分钟数，用于展示经度修正/均时差（如 −129.5 分、+3.19 分）。 */
    function fmtMin(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return '—'
      const sign = n < 0 ? '−' : '+'
      const abs = Math.abs(n)
      // 整数就不显示小数，免得「−14.00 分」这种噪音
      return sign + (Number.isInteger(abs) ? String(abs) : abs.toFixed(1)) + ' 分'
    }

    /** 从 iztro 的 decadal/age/yearly… 节点取干支。 */
    function ganzhiOf(v) {
      if (!v || typeof v !== 'object') return typeof v === 'string' ? v : ''
      const stem = v.heavenlyStem ?? ''
      const branch = v.earthlyBranch ?? ''
      return (stem || branch) ? String(stem) + String(branch) : ''
    }

    /** 记录类型徽标：daily=日运 / range=N年 / manual 或旧数据=不显示（原样兼容）。 */
    function kindBadge(rec) {
      if (rec?.kind === 'daily') return { cls: 'daily', text: '日运' }
      if (rec?.kind === 'range') return { cls: 'range', text: (rec.years != null ? rec.years + '年' : '区间') }
      return null
    }

    /** 列表行的摘要：大限 / 小限 / 流年干支。 */
    function recordSummary(record) {
      const s = record?.summary
      if (!s || typeof s !== 'object') return ''
      const parts = []
      SCOPE_ROWS.slice(0, 3).forEach(([k, label]) => {
        const gz = ganzhiOf(s[k])
        if (gz) parts.push(label + ' ' + gz)
      })
      return parts.join(' · ')
    }

    /**
     * 运限六层的结构化摘要（供分层卡片渲染）。
     * 每层返回干支 / 命宫落宫 / 四化，不再把 12 宫 palaceNames 拼成长串
     * （那会挤成一团；12 宫重排另有专门展示）。
     */
    function scopeLayers(horoscope) {
      return SCOPE_ROWS.map(([key, label]) => {
        const v = horoscope && typeof horoscope === 'object' ? horoscope[key] : null
        if (!v || typeof v !== 'object') {
          return { key, label, ok: false, gz: '', palaceName: '', index: null, mutagen: [], nominalAge: null }
        }
        const gz = ganzhiOf(v)
        const names = Array.isArray(v.palaceNames) ? v.palaceNames : []
        let palaceName = ''
        if (names.length && Number.isInteger(v.index)) palaceName = String(names[v.index] ?? '')
        if (!palaceName && names.length) palaceName = String(names[0] ?? '')
        return {
          key, label,
          ok: !!(gz || palaceName),
          gz, palaceName,
          index: Number.isInteger(v.index) ? v.index : null,
          mutagen: Array.isArray(v.mutagen) ? v.mutagen : [],
          nominalAge: Number.isInteger(v.nominalAge) ? v.nominalAge : null,
        }
      })
    }

    /**
     * 六层运限（大限 / 小限 / 流年 / 流月 / 流日 / 流时）分层卡片。
     * 每层一张小卡：层名 + 干支大字 + 落宫 + 四化彩色徽标；缺数据显示「—」。
     * 比原来一整片 key/value 字段行更清晰，也能一眼看出层级差别。
     */
    function ScopeLayers({ horoscope }) {
      const layers = scopeLayers(horoscope)
      if (!layers.some((l) => l.ok)) {
        return h('div', { className: 'zw-empty' }, '该记录没有可展示的六层运限数据。')
      }
      return h('div', { className: 'zw-scopes' },
        layers.map((l) => h('div', {
          className: 'zw-scope-card' + (l.ok ? '' : ' dim'),
          key: l.key,
          title: l.label + (l.gz ? ' ' + l.gz : '') + (l.palaceName ? ' · 落' + l.palaceName + '宫' : ''),
        },
          h('div', { className: 'zw-scope-hd' },
            h('span', { className: 'lb' }, l.label),
            l.nominalAge !== null ? h('span', { className: 'zw-scope-age' }, '虚岁 ' + l.nominalAge) : null),
          h('div', { className: 'zw-scope-gz' }, l.gz || '—'),
          h('div', { className: 'zw-scope-meta' },
            l.palaceName ? h('span', { className: 'pn' }, '落 ' + l.palaceName + ' 宫') : h('span', { className: 'pn dim' }, '—'),
            l.index !== null ? h('span', { className: 'idx' }, '宫序 ' + l.index) : null),
          l.mutagen.length
            ? h('div', { className: 'zw-scope-mg' },
              mutagenText(l.mutagen).split(' / ').filter(Boolean).map((starName, i) => h('span', {
                className: 'zw-mg-chip m' + i, key: 'm' + i,
                title: ['化禄', '化权', '化科', '化忌'][i] ?? '',
              }, starName)))
            : null)))
    }

    /** 四化数组 → 「禄/权/科/忌」对应的可读星名串（兼容字符串或 {name} 对象数组）。 */
    function mutagenText(v) {
      if (!v) return ''
      if (typeof v === 'string') return v
      if (Array.isArray(v)) {
        return v.map((x) => (x && typeof x === 'object' ? (x.name ?? x.star ?? '') : String(x ?? '')))
          .filter(Boolean).join(' / ')
      }
      if (typeof v === 'object') {
        // 形如 { 禄:'天同', 权:'天机', ... } 或 { lu:'天同', ... }
        const keys = ['禄', '权', '科', '忌', 'lu', 'quan', 'ke', 'ji']
        const parts = []
        keys.forEach((k) => { if (v[k]) parts.push(String(v[k])) })
        return parts.join(' / ')
      }
      return String(v)
    }

    /** 运限某一层的可读片段：干支 + 宫名 + 四化。 */
    function scopeBrief(v) {
      if (!v || typeof v !== 'object') return ''
      const parts = []
      const gz = ganzhiOf(v)
      if (gz) parts.push(gz)
      const palace = v.palaceNames && v.palaceNames.length
        ? (Array.isArray(v.palaceNames) ? v.palaceNames[0] : v.palaceNames)
        : (v.palaceName || v.name || '')
      if (palace) parts.push(String(palace))
      const mg = mutagenText(v.mutagen)
      if (mg) parts.push('四化 ' + mg)
      return parts.join(' · ')
    }

    /** 时间轴一项的中文摘要（Host 若已给 summary 则优先用）。 */
    function timelineSummary(item) {
      if (item?.summary) return String(item.summary)
      const gz = String(item?.heavenlyStem ?? '') + String(item?.earthlyBranch ?? '')
      const bits = [String(item?.year ?? '') + (gz ? ' ' + gz : '')]
      if (item?.age !== undefined && item?.age !== null) bits.push(String(item.age) + ' 岁')
      if (item?.palaceName) bits.push(String(item.palaceName))
      const dc = item?.decadal
      if (dc) {
        const dr = dc.yearRange
          ? (Array.isArray(dc.yearRange) ? dc.yearRange.join('~') : dc.yearRange) : ''
        bits.push('大限 ' + (dc.palaceName || dc.name || '') + (dr ? '(' + dr + ')' : ''))
      }
      const mg = mutagenText(item?.mutagen)
      if (mg) bits.push('四化 ' + mg)
      return bits.join(' · ')
    }

    /** 大限/年龄范围：兼容数组 [a,b] 或字符串。 */
    function rangeText(v) {
      if (v === undefined || v === null || v === '') return ''
      return Array.isArray(v) ? v.join('~') : String(v)
    }

    function failOf(r, fallback) {
      return { ok: false, error: r?.error?.message ?? fallback }
    }

    function caught(e) {
      return { ok: false, error: String(e?.message ?? e) }
    }

    /* ================================================================
       4. 样式（全部走 --dsw-alias-* 主题令牌，类名前缀 zw-）
       ================================================================ */

    const CSS = `
    .zw{display:flex;flex-direction:column;height:100%;min-height:0;
      background:var(--dsw-alias-bg-1,#11141a);color:var(--dsw-alias-text-1,#e6eaf2);
      font-size:13px;line-height:1.6;font-family:var(--dsw-alias-font-sans,system-ui,"Microsoft YaHei",sans-serif)}
    .zw *{box-sizing:border-box}
    .zw-gbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:10px 18px;
      background:linear-gradient(120deg,var(--dsw-alias-bg-3,#1e232d),var(--dsw-alias-bg-2,#171b23) 60%,var(--dsw-alias-bg-1,#11141a));
      border-bottom:1px solid var(--dsw-alias-border-1,#232833);
      box-shadow:0 1px 0 rgba(255,255,255,.02) inset,0 2px 10px rgba(0,0,0,.18)}
    .zw-brandwrap{display:inline-flex;align-items:center;gap:9px;white-space:nowrap}
    .zw-brand-badge{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
      border-radius:50%;font-size:15px;line-height:1;color:#a9c8ee;
      background:radial-gradient(circle at 30% 25%,rgba(91,143,214,.42),rgba(91,143,214,.14));
      border:1px solid rgba(91,143,214,.5);box-shadow:0 2px 8px rgba(91,143,214,.18)}
    .zw-brand{font-weight:700;font-size:14px;letter-spacing:.02em;color:var(--dsw-alias-text-1,#e6eaf2)}
    .zw-status{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);
      font-family:var(--dsw-alias-font-mono,monospace);white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis;max-width:240px}
    .zw-sp{flex:1 1 auto}
    .zw-btn{border:1px solid var(--dsw-alias-border-2,#2e3542);background:var(--dsw-alias-bg-3,#1e232d);
      color:var(--dsw-alias-text-2,#b6bfd0);border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;
      font-family:inherit;transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease,background .12s ease;
      white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.16)}
    .zw-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-3,#3a4252);color:var(--dsw-alias-text-1,#e6eaf2);
      transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.24)}
    .zw-btn:active:not(:disabled){transform:translateY(0)}
    .zw-btn:disabled{opacity:.5;cursor:not-allowed}
    .zw-btn.sm{padding:4px 10px;font-size:11.5px;border-radius:7px}
    .zw-btn.primary{background:linear-gradient(135deg,rgba(91,143,214,.32),rgba(91,143,214,.16));
      border-color:rgba(91,143,214,.65);color:#cfe0f6;font-weight:600;
      box-shadow:0 2px 10px rgba(91,143,214,.22)}
    .zw-btn.primary:hover:not(:disabled){background:linear-gradient(135deg,rgba(91,143,214,.44),rgba(91,143,214,.22))}
    .zw-btn.danger{background:linear-gradient(135deg,rgba(224,87,75,.22),rgba(224,87,75,.1));
      border-color:rgba(224,87,75,.5);color:#f3b3ac}
    .zw-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-text-4,#5f6879);
      padding:3px 8px;box-shadow:none;opacity:.85}
    .zw-btn.ghost:hover:not(:disabled){color:var(--dsw-alias-text-2,#b6bfd0);background:var(--dsw-alias-bg-3,#1e232d);opacity:1}
    .zw-alert{display:flex;align-items:center;gap:8px;margin:8px 14px 0;padding:8px 11px;border-radius:6px;
      font-size:12px;background:rgba(224,87,75,.1);border:1px solid rgba(224,87,75,.3);color:#efa79f}
    .zw-alert.sm{margin:8px 0 0;padding:6px 9px;font-size:11.5px}
    .zw-alert.wn{background:rgba(217,161,60,.1);border-color:rgba(217,161,60,.32);color:#e8c77e}
    .zw-x{background:none;border:none;color:inherit;font-size:15px;line-height:1;padding:2px 6px;
      border-radius:4px;cursor:pointer;opacity:.8}
    .zw-x:hover{opacity:1;background:var(--dsw-alias-bg-4,#252b37)}
    .zw-x:disabled{opacity:.4;cursor:not-allowed}

    .zw-body{display:grid;grid-template-columns:296px minmax(0,1fr);flex:1 1 auto;min-height:0}
    .zw-detail{display:flex;flex-direction:column;min-width:0;min-height:0;
      border-left:1px solid var(--dsw-alias-border-2,#2e3542)}
    .zw-list{display:flex;flex-direction:column;min-height:0;
      background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      border-right:1px solid var(--dsw-alias-border-2,#2e3542)}
    .zw-list-hd{flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:11px 14px;
      font-size:11px;color:var(--dsw-alias-text-4,#5f6879);font-weight:600;letter-spacing:.05em;
      border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    /* 人员列表头的「+」：与标题同一行，弱化存在感，不抢视线 */
    .zw-iconbtn{flex:none;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;
      padding:0;border:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);border-radius:5px;
      background:transparent;color:var(--dsw-alias-text-3,#8b93a1);font:inherit;font-size:13px;line-height:1;
      cursor:pointer;transition:all .14s ease}
    .zw-iconbtn:hover:not(:disabled){border-color:var(--dsw-alias-brand,#7aa2f7);color:var(--dsw-alias-brand,#7aa2f7);
      background:rgba(122,162,247,.1)}
    .zw-iconbtn:disabled{opacity:.4;cursor:default}

    /* 时辰标签行：标签在左，定盘入口在右（文字链接，不抢视觉） */
    .zw-time-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
    .zw-calibrate-btn{flex:none;padding:0 0 1px;border:0;background:transparent;
      color:var(--dsw-alias-label-tertiary,#6f7887);
      font:inherit;font-size:10px;line-height:1.4;letter-spacing:.02em;
      cursor:pointer;white-space:nowrap;
      border-bottom:1px dotted rgba(139,147,161,.5);
      transition:color .14s ease,border-color .14s ease}
    .zw-calibrate-btn:hover:not(:disabled){color:var(--dsw-alias-brand,#7aa2f7);
      border-bottom-color:rgba(122,162,247,.7)}
    .zw-calibrate-btn:disabled{opacity:.4;cursor:default}

    /* ===== 真太阳时 ===== */
    .zw-tst-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:14px;
      padding:9px 11px;border:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);border-radius:9px;
      background:transparent;transition:border-color .14s ease}
    .zw-tst-toggle:hover{border-color:var(--dsw-alias-border-l3,#4a5262)}
    .zw-tst-toggle input{margin:0;flex:none;cursor:pointer}
    .zw-tst-toggle > span:nth-child(2){flex:none;font-size:12.5px;color:var(--dsw-alias-label-primary,#e6e9ef)}
    .zw-tst-toggle .zw-hint{margin-left:auto;text-align:right;line-height:1.45}
    .zw-tst-block{display:flex;flex-direction:column;gap:9px;margin-top:10px;padding:11px;
      border:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);border-radius:9px;
      background:var(--dsw-alias-bg-l1,rgba(255,255,255,.02))}
    .zw-tst-block .zw-row2{margin-top:0}
    .zw-region{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .zw-region select{width:100%;box-sizing:border-box}
    .zw-tst-result{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:8px;
      background:rgba(122,162,247,.07);border-left:2px solid var(--dsw-alias-brand,#7aa2f7)}
    .zw-tst-row{display:flex;align-items:baseline;gap:10px;font-size:12px;line-height:1.6}
    .zw-tst-row .k{flex:none;width:56px;color:var(--dsw-alias-label-tertiary,#6f7887);font-size:11px}
    .zw-tst-row .v{color:var(--dsw-alias-label-secondary,#b9c0cc);font-variant-numeric:tabular-nums}
    .zw-tst-row.hi .v{color:var(--dsw-alias-label-primary,#e6e9ef);font-weight:650;font-size:12.5px}
    .zw-tst-arrow{font-size:10px;color:var(--dsw-alias-label-tertiary,#6f7887);padding-left:56px}
    .zw-tst-detail{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6f7887);padding-left:56px;
      font-variant-numeric:tabular-nums}
    .zw-tst-warn{margin-top:3px;padding:6px 9px;border-radius:6px;font-size:11px;line-height:1.6;
      color:var(--dsw-alias-state-warn-primary,#d49245);
      background:rgba(212,146,69,.1);border:0.5px solid rgba(212,146,69,.3)}
    .zw-list-items{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px}
    .zw-person{display:flex;gap:9px;align-items:flex-start;padding:9px 10px;margin-bottom:7px;
      border-radius:11px;cursor:pointer;position:relative;
      border:1px solid var(--dsw-alias-border-1,#232833);background:var(--dsw-alias-bg-2,#171b23);
      transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease,background .12s ease}
    .zw-person:hover{border-color:var(--dsw-alias-border-3,#3a4252);background:var(--dsw-alias-bg-3,#1e232d);
      transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.22)}
    .zw-person.on{border-color:rgba(91,143,214,.55);
      background:linear-gradient(100deg,rgba(91,143,214,.18),rgba(91,143,214,.05));
      box-shadow:0 3px 12px rgba(91,143,214,.14)}
    .zw-person.on::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:3px;
      border-radius:0 3px 3px 0;background:var(--dsw-alias-accent,#5b8fd6)}
    .zw-avatar{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
      width:30px;height:30px;border-radius:50%;font-size:13px;font-weight:600;
      border:1px solid;box-shadow:inset 0 1px 2px rgba(255,255,255,.06)}
    .zw-person-main{flex:1;min-width:0;display:flex;flex-direction:column}
    .zw-person-top{display:flex;align-items:center;gap:6px}
    .zw-person-name{flex:1;min-width:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-text-1,#e6eaf2);
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .zw-person-del{flex:0 0 auto;border:none;background:transparent;color:var(--dsw-alias-text-4,#5f6879);
      cursor:pointer;font-size:14px;line-height:1;padding:0 3px;border-radius:5px}
    .zw-person-del:hover{color:#efa79f;background:rgba(224,87,75,.12)}
    .zw-person-del:disabled{opacity:.4;cursor:not-allowed}
    .zw-person-meta{display:flex;align-items:center;gap:6px;margin-top:2px;font-size:10.5px;
      color:var(--dsw-alias-text-4,#5f6879);font-family:var(--dsw-alias-font-mono,monospace);
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .zw-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:9px;line-height:16px;
      border:1px solid var(--dsw-alias-border-2,#2e3542);font-size:10px;
      color:var(--dsw-alias-text-4,#5f6879);font-family:var(--dsw-alias-font-sans,inherit)}
    .zw-empty{padding:40px 20px;text-align:center;color:var(--dsw-alias-text-4,#5f6879);font-size:12.5px;line-height:1.9}
    .zw-loading{padding:22px;text-align:center;color:var(--dsw-alias-text-4,#5f6879);font-size:12px}

    .zw-tabs{flex:0 0 auto;display:flex;gap:3px;margin:10px 14px 0;padding:4px;border-radius:11px;
      background:var(--dsw-alias-bg-3,#1e232d);border:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-tab{flex:0 0 auto;padding:7px 16px;font-size:12.5px;color:var(--dsw-alias-text-4,#5f6879);border:none;
      border-radius:8px;background:transparent;cursor:pointer;font-family:inherit;
      transition:background .14s ease,color .14s ease,box-shadow .14s ease}
    .zw-tab:hover{color:var(--dsw-alias-text-2,#b6bfd0);background:var(--dsw-alias-bg-2,#171b23)}
    .zw-tab.on{color:var(--dsw-alias-text-1,#e6eaf2);font-weight:600;
      background:linear-gradient(135deg,rgba(91,143,214,.28),rgba(91,143,214,.12));
      border:1px solid rgba(91,143,214,.4);
      box-shadow:0 2px 8px rgba(0,0,0,.22),0 1px 0 rgba(255,255,255,.05) inset}
    .zw-pane{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 16px 48px}
    .zw-sec{background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      border:1px solid var(--dsw-alias-border-1,#232833);
      border-radius:12px;padding:14px 16px;margin-bottom:14px;
      box-shadow:0 3px 14px rgba(0,0,0,.16)}
    .zw-sec-h{font-size:11px;font-weight:600;color:var(--dsw-alias-text-3,#8b95a8);letter-spacing:.04em;
      margin-bottom:8px;padding-bottom:7px;border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:2px 18px}
    .zw-f{display:flex;gap:10px;padding:4px 0;font-size:12px;align-items:baseline}
    .zw-f .k{flex:0 0 92px;color:var(--dsw-alias-text-4,#5f6879);font-size:11px}
    .zw-f .v{flex:1;min-width:0;color:var(--dsw-alias-text-1,#e6eaf2);word-break:break-word;
      font-family:var(--dsw-alias-font-mono,monospace);font-size:11.5px}
    .zw-actions{display:flex;gap:8px;align-items:center;margin:12px 0;flex-wrap:wrap}
    .zw-subbar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
    .zw-hint{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);line-height:1.6}
    /* ===== AI 分析回填区块 ===== */
    .zw-ana{border:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-l2,rgba(255,255,255,.02))}
    .zw-ana .zw-sec-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
    .zw-ana-toggle{border:0;background:transparent;color:var(--dsw-alias-text-1,#e6e9ef);font:inherit;font-size:13.5px;font-weight:650;cursor:pointer;padding:0}
    .zw-ana-toggle:hover{color:var(--dsw-alias-brand,#7aa2f7)}
    .zw-ana-meta{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);border:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);border-radius:999px;padding:1px 7px}
    .zw-ana-sum{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-text-2,#b9c0cc);padding:8px 10px;margin-bottom:10px;
      border-left:2px solid var(--dsw-alias-brand,#7aa2f7);background:rgba(122,162,247,.07);border-radius:0 8px 8px 0;white-space:pre-wrap}
    .zw-ana-body{max-height:520px;overflow:auto;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-text-1,#e6e9ef)}
    .zw-ana-body .zw-ana-h{font-weight:650;color:var(--dsw-alias-text-1,#e6e9ef);margin:12px 0 6px;line-height:1.5}
    .zw-ana-body .zw-ana-h.lv1{font-size:15px;margin-top:0;padding-bottom:6px;border-bottom:0.5px solid var(--dsw-alias-border-l2,#3a3f4a)}
    .zw-ana-body .zw-ana-h.lv2{font-size:13.5px}
    .zw-ana-body .zw-ana-h.lv3,.zw-ana-body .zw-ana-h.lv4{font-size:12.5px;color:var(--dsw-alias-text-2,#b9c0cc)}
    .zw-ana-body .zw-ana-p{white-space:pre-wrap;margin:2px 0}
    .zw-ana-body .zw-ana-li{display:flex;gap:6px;margin:2px 0}
    .zw-ana-dot{color:var(--dsw-alias-text-4,#5f6879);flex:none}
    .zw-ana-gap{height:7px}
    .zw-ana-rule{border-top:0.5px solid var(--dsw-alias-border-l2,#3a3f4a);margin:10px 0}
    .zw-hasana{color:var(--dsw-alias-brand,#7aa2f7);font-size:11px;margin-right:3px}
    .zw-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
    .zw-chip{padding:4px 10px;border-radius:16px;border:1px solid var(--dsw-alias-border-2,#2e3542);
      background:transparent;color:var(--dsw-alias-text-3,#8b95a8);font-size:11.5px;cursor:pointer;font-family:inherit}
    .zw-chip:hover{border-color:var(--dsw-alias-border-3,#3a4252);color:var(--dsw-alias-text-2,#b6bfd0)}
    .zw-chip.on{background:rgba(91,143,214,.14);border-color:rgba(91,143,214,.5);color:#a9c8ee}

    /* 复制 JSON 按钮（不展示 JSON 内容） */
    .zw-copyjson{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}
    .zw-copyjson-hint{color:#7fc79c}
    .zw-rows{display:flex;flex-direction:column;gap:5px}
    .zw-row{display:grid;grid-template-columns:130px 100px 96px minmax(80px,1fr) minmax(120px,1.4fr) auto 16px;
      gap:8px;align-items:center;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:11.5px;
      background:var(--dsw-alias-bg-2,#171b23);border:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-row:hover{border-color:var(--dsw-alias-border-3,#3a4252);background:var(--dsw-alias-bg-3,#1e232d)}
    .zw-row>div{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
      color:var(--dsw-alias-text-3,#8b95a8);
      font-family:var(--dsw-alias-font-mono,monospace);font-size:10.5px}
    .zw-row .c2{color:var(--dsw-alias-text-1,#e6eaf2)}
    .zw-row .c6{text-align:right;font-size:15px;color:var(--dsw-alias-text-4,#5f6879)}
    .zw-row .c7{overflow:visible;white-space:nowrap;display:flex;align-items:center;justify-content:flex-end}
    .zw-subtabs{display:flex;gap:4px;margin:14px 0 0;border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-subtab{border:none;background:transparent;color:var(--dsw-alias-text-4,#5f6879);padding:6px 12px;
      font-size:11.5px;cursor:pointer;border-bottom:2px solid transparent;font-family:inherit}
    .zw-subtab.on{color:var(--dsw-alias-text-1,#e6eaf2);border-bottom-color:var(--dsw-alias-accent,#5b8fd6)}

    .zw-modal{position:fixed;inset:0;background:rgba(8,10,14,.62);display:flex;
      align-items:center;justify-content:center;z-index:60;
      -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
    .zw-mbox{background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      border:1px solid var(--dsw-alias-border-3,#3a4252);
      border-radius:16px;width:480px;max-width:92vw;max-height:86vh;overflow:auto;
      box-shadow:0 24px 64px rgba(0,0,0,.62),0 1px 0 rgba(255,255,255,.04) inset}
    .zw-mh{display:flex;align-items:center;padding:14px 18px;
      border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-mh h3{margin:0;font-size:14px;font-weight:700;letter-spacing:.02em}
    .zw-mh .zw-x{margin-left:auto;color:var(--dsw-alias-text-4,#5f6879)}
    .zw-mb{padding:15px 18px}
    .zw-mb label{display:block;font-size:11px;color:var(--dsw-alias-text-4,#5f6879);margin:11px 0 4px}
    .zw-mb label:first-child{margin-top:0}
    .zw-mb input[type=text],.zw-mb input[type=date],.zw-mb input[type=number],.zw-mb select,.zw-mb textarea{
      width:100%;background:var(--dsw-alias-bg-1,#11141a);
      border:1px solid var(--dsw-alias-border-2,#2e3542);border-radius:9px;padding:7px 10px;
      color:var(--dsw-alias-text-1,#e6eaf2);font:12px inherit;outline:none;
      transition:border-color .14s ease,box-shadow .14s ease}
    .zw-mb input:focus,.zw-mb select:focus,.zw-mb textarea:focus{
      border-color:var(--dsw-alias-accent,#5b8fd6);
      box-shadow:0 0 0 3px rgba(91,143,214,.18)}
    .zw-mb textarea{min-height:60px;resize:vertical}
    .zw-mb label.zw-check{display:flex;align-items:center;gap:6px;margin:11px 0 4px;
      color:var(--dsw-alias-text-2,#b6bfd0);font-size:11.5px;cursor:pointer}
    .zw-mb label.zw-check input{width:auto}
    .zw-override{margin-top:8px;padding:10px;border-radius:6px;
      border:1px dashed var(--dsw-alias-border-3,#3a4252);background:var(--dsw-alias-bg-1,#11141a)}
    .zw-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .zw-callout{font-size:12px;line-height:1.75;padding:9px 11px;border-radius:6px;border:1px solid}
    .zw-callout.danger{background:rgba(224,87,75,.1);border-color:rgba(224,87,75,.3);color:#efa79f}
    .zw-mf{display:flex;gap:7px;justify-content:flex-end;padding:11px 15px;
      border-top:1px solid var(--dsw-alias-border-1,#232833)}

    /* ===== 命盘可视化（需求 B） ===== */
    .zw-chart-top{max-width:940px;margin:0 auto;width:100%}
    .zw-chart-sum{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px}
    .zw-chart-sum .zw-sumchip{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:10px;
      border:1px solid var(--dsw-alias-border-2,#2e3542);
      background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      font-size:11px;color:var(--dsw-alias-text-3,#8b95a8);
      box-shadow:0 2px 8px rgba(0,0,0,.16)}
    .zw-chart-sum .zw-sumchip b{color:var(--dsw-alias-text-1,#e6eaf2);font-weight:700;
      font-family:var(--dsw-alias-font-mono,monospace);font-size:11.5px}
    .zw-gen{font-size:11px;padding:6px 10px;border-radius:6px;margin-bottom:10px;
      background:rgba(63,160,106,.1);border:1px solid rgba(63,160,106,.3);color:#7fc79c}
    .zw-chart-scroll{overflow-x:auto;padding-bottom:6px}
    .zw-chart{min-width:760px;width:100%;max-width:940px;margin:0 auto;display:grid;
      grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,minmax(118px,1fr));
      gap:7px;background:var(--dsw-alias-bg-2,#171b23);
      border:1px solid var(--dsw-alias-border-2,#2e3542);border-radius:14px;padding:8px;
      box-shadow:0 8px 26px rgba(0,0,0,.22)}
    .zw-palace{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;
      padding:6px 8px;border-radius:10px;overflow:hidden;
      background:linear-gradient(180deg,var(--dsw-alias-bg-1,#11141a),var(--dsw-alias-bg-2,#171b23));
      border:1px solid var(--dsw-alias-border-1,#232833);
      transition:transform .13s ease,box-shadow .13s ease,border-color .13s ease,background .13s ease}
    .zw-palace:hover{border-color:var(--dsw-alias-accent,#5b8fd6);background:var(--dsw-alias-bg-3,#1e232d);
      transform:translateY(-2px);box-shadow:0 8px 18px rgba(0,0,0,.3);z-index:2}
    .zw-palace.ming{border-color:rgba(217,161,60,.72);
      background:linear-gradient(160deg,rgba(217,161,60,.16),rgba(217,161,60,.03));
      box-shadow:0 0 0 1px rgba(217,161,60,.25) inset,0 3px 12px rgba(217,161,60,.12)}
    .zw-pal-head{display:flex;align-items:center;gap:4px;flex:0 0 auto;
      font-size:11px;line-height:1.4;min-width:0}
    .zw-pal-name{font-weight:600;color:var(--dsw-alias-text-1,#e6eaf2);overflow:hidden;
      white-space:nowrap;text-overflow:ellipsis}
    .zw-pal-gz{margin-left:auto;font-family:var(--dsw-alias-font-mono,monospace);font-size:10.5px;
      color:var(--dsw-alias-accent,#5b8fd6);white-space:nowrap}
    .zw-tag-mini{flex:0 0 auto;font-size:9px;line-height:14px;padding:0 4px;border-radius:3px;
      border:1px solid var(--dsw-alias-border-2,#2e3542);color:var(--dsw-alias-text-4,#5f6879)}
    .zw-tag-mini.body{color:#7fc79c;border-color:rgba(63,160,106,.4);background:rgba(63,160,106,.1)}
    .zw-tag-mini.orig{color:#c9a5e6;border-color:rgba(181,127,219,.4);background:rgba(181,127,219,.1)}
    .zw-pal-stars{flex:1 1 auto;min-height:0;overflow:hidden;padding:3px 0;display:flex;flex-direction:column;
      gap:1px;align-content:flex-start}
    .zw-major{display:inline-flex;align-items:baseline;gap:4px;flex-wrap:wrap;font-size:14px;font-weight:800;
      line-height:1.4;letter-spacing:.02em;color:var(--dsw-alias-text-1,#e6eaf2);
      text-shadow:0 1px 2px rgba(0,0,0,.35)}
    .zw-major .nm{white-space:nowrap}
    .zw-bright{font-size:9.5px;font-weight:400;color:var(--dsw-alias-text-4,#5f6879)}
    .zw-mutagen{display:inline-flex;align-items:center;font-size:9.5px;line-height:15px;padding:0 6px;
      border-radius:8px;border:1px solid;font-weight:700;white-space:nowrap;
      box-shadow:0 1px 3px rgba(0,0,0,.2)}
    .zw-mutagen.lu{color:#7fc79c;border-color:rgba(63,160,106,.45);background:rgba(63,160,106,.13)}
    .zw-mutagen.quan{color:#c9a5e6;border-color:rgba(181,127,219,.45);background:rgba(181,127,219,.13)}
    .zw-mutagen.ke{color:#6fd0c6;border-color:rgba(67,176,166,.45);background:rgba(67,176,166,.13)}
    .zw-mutagen.ji{color:#efa79f;border-color:rgba(224,87,75,.45);background:rgba(224,87,75,.13)}
    .zw-minors,.zw-adj{font-size:10px;line-height:1.4;color:var(--dsw-alias-text-3,#8b95a8);
      overflow:hidden;display:flex;flex-wrap:wrap;gap:0 5px}
    .zw-adj{font-size:9.5px;color:var(--dsw-alias-text-4,#5f6879)}
    .zw-empty-pal{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);font-style:italic;opacity:.7}
    .zw-pal-foot{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:0 6px;align-items:center;
      padding-top:3px;border-top:1px dashed var(--dsw-alias-border-1,#232833);font-size:9.5px;
      color:var(--dsw-alias-text-4,#5f6879);font-family:var(--dsw-alias-font-mono,monospace);line-height:1.4}
    .zw-pal-foot .dc{color:#e8c77e}
    .zw-center{grid-row:2/4;grid-column:2/4;display:flex;flex-direction:column;min-width:0;min-height:0;
      padding:10px 12px;border-radius:12px;overflow:auto;
      background:radial-gradient(circle at 20% 0%,rgba(91,143,214,.14),transparent 60%),
        linear-gradient(160deg,var(--dsw-alias-bg-3,#1e232d),var(--dsw-alias-bg-1,#11141a));
      border:1px solid rgba(91,143,214,.32);
      box-shadow:0 6px 20px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.04) inset}
    .zw-center-h{font-size:11px;font-weight:600;color:var(--dsw-alias-text-2,#b6bfd0);
      padding-bottom:5px;margin-bottom:5px;border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-center-fields{display:grid;grid-template-columns:1fr 1fr;gap:1px 10px}
    .zw-center-fields .zw-f{gap:5px;padding:2px 0}
    .zw-center-fields .zw-f .k{flex:0 0 76px;font-size:10px}
    .zw-center-fields .zw-f .v{font-size:10.5px}
    .zw-chart-foot{max-width:940px;margin:10px auto 0;width:100%}

    /* ===== 历法表单（需求 4） ===== */
    .zw-seg{display:inline-flex;gap:3px;padding:3px;border-radius:10px;
      background:var(--dsw-alias-bg-3,#1e232d);border:1px solid var(--dsw-alias-border-2,#2e3542)}
    .zw-seg button{border:none;background:transparent;color:var(--dsw-alias-text-4,#5f6879);
      padding:5px 16px;font-size:12px;border-radius:8px;cursor:pointer;font-family:inherit;transition:.14s}
    .zw-seg button:hover{color:var(--dsw-alias-text-2,#b6bfd0)}
    .zw-seg button.on{color:var(--dsw-alias-text-1,#e6eaf2);font-weight:600;
      background:linear-gradient(135deg,rgba(91,143,214,.3),rgba(91,143,214,.14));
      border:1px solid rgba(91,143,214,.45);box-shadow:0 2px 7px rgba(0,0,0,.22)}
    .zw-cal-block{margin-top:12px;padding:12px;border-radius:11px;
      background:var(--dsw-alias-bg-1,#11141a);border:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-lunar3{display:grid;grid-template-columns:1.1fr 1.2fr 1fr;gap:9px}
    .zw-leap{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:11.5px;
      color:var(--dsw-alias-text-2,#b6bfd0);cursor:pointer}
    .zw-leap input{width:auto;accent-color:var(--dsw-alias-accent,#5b8fd6)}
    .zw-preview{margin-top:9px;padding:8px 11px;border-radius:9px;font-size:11.5px;line-height:1.6;
      background:linear-gradient(135deg,rgba(67,176,166,.12),rgba(67,176,166,.03));
      border:1px solid rgba(67,176,166,.3);color:#8fded5}
    .zw-preview b{color:var(--dsw-alias-text-1,#e6eaf2);font-family:var(--dsw-alias-font-mono,monospace)}
    .zw-cal-tag{display:inline-flex;padding:0 6px;border-radius:8px;line-height:16px;font-size:10px;
      border:1px solid rgba(217,161,60,.4);background:rgba(217,161,60,.1);color:#e8c77e}

    /* ===== 快捷运势 / 时间轴（getFortune 会写入历史记录） ===== */
    .zw-fortune{margin-bottom:14px;padding:14px 16px;border-radius:12px;
      background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      border:1px solid var(--dsw-alias-border-2,#2e3542);box-shadow:0 3px 14px rgba(0,0,0,.18)}
    .zw-fq-h{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .zw-fq-h .ttl{font-size:11.5px;font-weight:700;color:var(--dsw-alias-text-2,#b6bfd0);letter-spacing:.02em}
    .zw-fq-bar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    .zw-fq-input{width:64px;background:var(--dsw-alias-bg-1,#11141a);
      border:1px solid var(--dsw-alias-border-2,#2e3542);border-radius:8px;padding:5px 8px;
      color:var(--dsw-alias-text-1,#e6eaf2);font:12px inherit;outline:none;text-align:center}
    .zw-fq-input:focus{border-color:var(--dsw-alias-accent,#5b8fd6);box-shadow:0 0 0 3px rgba(91,143,214,.18)}
    .zw-fq-date{width:148px;background:var(--dsw-alias-bg-1,#11141a);
      border:1px solid var(--dsw-alias-border-2,#2e3542);border-radius:8px;padding:5px 8px;
      color:var(--dsw-alias-text-1,#e6eaf2);font:12px inherit;outline:none}
    .zw-fq-date:focus{border-color:var(--dsw-alias-accent,#5b8fd6);box-shadow:0 0 0 3px rgba(91,143,214,.18)}
    .zw-fq-empty{font-size:11px;color:var(--dsw-alias-text-4,#5f6879);padding:6px 0 0;line-height:1.6}
    .zw-fq-err{font-size:11.5px;color:#efa79f;padding:7px 0 0}
    .zw-fq-result{margin-top:14px;border-top:1px dashed var(--dsw-alias-border-2,#2e3542);padding-top:12px}
    .zw-fq-scope{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
    .zw-fq-scope .lb{font-size:12.5px;font-weight:700;color:var(--dsw-alias-text-1,#e6eaf2)}
    .zw-fq-scope .base{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);
      font-family:var(--dsw-alias-font-mono,monospace)}
    .zw-fq-scopes{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;margin-bottom:12px}
    .zw-fq-scopes .row{display:flex;gap:8px;align-items:baseline;padding:5px 9px;border-radius:8px;
      background:var(--dsw-alias-bg-2,#171b23);border:1px solid var(--dsw-alias-border-1,#232833);font-size:11px}
    .zw-fq-scopes .row .k{flex:0 0 40px;color:var(--dsw-alias-text-4,#5f6879)}
    .zw-fq-scopes .row .v{flex:1;min-width:0;color:var(--dsw-alias-text-2,#b6bfd0);
      font-family:var(--dsw-alias-font-mono,monospace);font-size:10.5px;word-break:break-word}
    /* 「当年」徽标仍被 YearDetail 使用 */
    .zw-tl-tag{display:inline-flex;padding:1px 8px;border-radius:8px;line-height:16px;font-size:10px;
      border:1px solid var(--dsw-alias-border-2,#2e3542);color:var(--dsw-alias-text-3,#8b95a8);
      background:var(--dsw-alias-bg-3,#1e232d)}
    .zw-tl-tag.cur{color:#7fc79c;border-color:rgba(63,160,106,.45);background:rgba(63,160,106,.1)}
    /* ===== 年份 Tab 条（多年份改横向分 Tab） ===== */
    .zw-yeartabs-wrap{margin:4px 0 0}
    .zw-yeartabs-group{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);
      margin:0 0 7px;letter-spacing:.03em}
    .zw-yeartabs{display:flex;align-items:stretch;gap:5px;overflow-x:auto;overflow-y:hidden;
      flex-wrap:nowrap;padding:4px 4px 9px;border-bottom:1px solid var(--dsw-alias-border-1,#232833);
      scrollbar-width:thin}
    .zw-yeartab{position:relative;flex:0 0 auto;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:1px;min-width:62px;padding:6px 12px 7px;border-radius:9px;cursor:pointer;
      background:var(--dsw-alias-bg-2,#171b23);border:1px solid var(--dsw-alias-border-1,#232833);
      transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease,background .12s ease}
    .zw-yeartab:hover{transform:translateY(-1px);border-color:var(--dsw-alias-border-3,#3a4252);
      background:var(--dsw-alias-bg-3,#1e232d);box-shadow:0 4px 12px rgba(0,0,0,.22)}
    .zw-yeartab .yt-year{font-family:var(--dsw-alias-font-mono,monospace);font-size:13px;font-weight:700;
      color:var(--dsw-alias-text-2,#b6bfd0);line-height:1.25}
    .zw-yeartab .yt-gz{font-size:9.5px;color:var(--dsw-alias-text-4,#5f6879);line-height:1.2}
    .zw-yeartab.sel{background:linear-gradient(135deg,rgba(91,143,214,.3),rgba(91,143,214,.12));
      border-color:rgba(91,143,214,.6);
      box-shadow:0 3px 10px rgba(91,143,214,.22),0 1px 0 rgba(255,255,255,.05) inset}
    .zw-yeartab.sel .yt-year{color:#cfe0f6}
    .zw-yeartab.sel .yt-gz{color:#9dc0ec}
    .zw-yeartab.cur .yt-year{color:#e8c77e}
    .zw-yeartab-curmark{position:absolute;top:-4px;right:-4px;min-width:14px;height:14px;line-height:14px;
      text-align:center;padding:0 2px;border-radius:8px;font-size:9px;font-weight:700;color:#0f1319;
      background:#e8c77e;box-shadow:0 1px 4px rgba(0,0,0,.3)}
    .zw-yeartab-sep{flex:0 0 auto;align-self:stretch;width:1px;margin:4px 3px;
      background:linear-gradient(180deg,transparent,var(--dsw-alias-border-3,#3a4252),transparent)}
    /* 选中年详情卡片 */
    .zw-yeardet{margin-top:14px;padding:12px 14px;border-radius:12px;
      background:linear-gradient(180deg,var(--dsw-alias-bg-2,#171b23),var(--dsw-alias-bg-1,#11141a));
      border:1px solid var(--dsw-alias-border-2,#2e3542);box-shadow:0 3px 14px rgba(0,0,0,.18)}
    .zw-yeardet-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;
      padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-1,#232833)}
    .zw-yeardet-h .yr{font-size:16px;font-weight:800;color:var(--dsw-alias-text-1,#e6eaf2);
      font-family:var(--dsw-alias-font-mono,monospace)}
    .zw-yeardet-h .gz{font-size:12px;font-weight:600;color:#8fded5}
    .zw-palacelist-wrap{margin-top:12px}
    .zw-palacelist-h{font-size:10.5px;color:var(--dsw-alias-text-4,#5f6879);margin-bottom:6px;letter-spacing:.03em}
    .zw-palacelist{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:5px}
    /* ===== 六层运限卡片（大限/小限/流年/流月/流日/流时） ===== */
    .zw-scopes{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:9px}
    .zw-scope-card{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:11px;
      background:var(--dsw-alias-bg-1,#11141a);border:1px solid var(--dsw-alias-border-2,#2e3542);
      transition:.14s;min-width:0}
    .zw-scope-card:hover{transform:translateY(-2px);border-color:var(--dsw-alias-border-3,#3a4252);
      box-shadow:0 6px 16px rgba(0,0,0,.26)}
    .zw-scope-card.dim{opacity:.5}
    .zw-scope-hd{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
    .zw-scope-hd .lb{font-size:10.5px;font-weight:600;letter-spacing:.05em;
      color:var(--dsw-alias-text-4,#5f6879)}
    .zw-scope-age{margin-left:auto;font-size:9.5px;padding:0 6px;border-radius:8px;line-height:15px;
      background:rgba(217,161,60,.14);border:1px solid rgba(217,161,60,.3);color:#e8c77e;
      font-family:var(--dsw-alias-font-mono,monospace);white-space:nowrap}
    .zw-scope-gz{font-size:19px;font-weight:800;line-height:1.15;letter-spacing:.04em;
      color:var(--dsw-alias-text-1,#e6eaf2);font-family:var(--dsw-alias-font-mono,monospace)}
    .zw-scope-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;
      font-family:var(--dsw-alias-font-mono,monospace);color:var(--dsw-alias-text-3,#8b95a8)}
    .zw-scope-meta .pn{color:#9dc0ec}
    .zw-scope-meta .pn.dim{color:var(--dsw-alias-text-4,#5f6879)}
    .zw-scope-meta .idx{color:var(--dsw-alias-text-4,#5f6879);font-size:9.5px}
    .zw-scope-mg{display:flex;gap:4px;flex-wrap:wrap;margin-top:1px}
    .zw-mg-chip{font-size:9.5px;line-height:16px;padding:0 6px;border-radius:8px;border:1px solid;
      font-family:var(--dsw-alias-font-mono,monospace);white-space:nowrap}
    .zw-mg-chip.m0{background:rgba(70,169,122,.14);border-color:rgba(70,169,122,.34);color:#7fc79c}
    .zw-mg-chip.m1{background:rgba(181,127,219,.14);border-color:rgba(181,127,219,.34);color:#c9a5e6}
    .zw-mg-chip.m2{background:rgba(67,176,166,.14);border-color:rgba(67,176,166,.32);color:#6fd0c6}
    .zw-mg-chip.m3{background:rgba(224,87,75,.14);border-color:rgba(224,87,75,.34);color:#ef9a92}
    .zw-palaceitem{display:flex;align-items:center;gap:5px;padding:4px 8px;border-radius:7px;
      background:var(--dsw-alias-bg-2,#171b23);border:1px solid var(--dsw-alias-border-1,#232833);
      font-size:10.5px}
    .zw-palaceitem .br{flex:0 0 auto;font-family:var(--dsw-alias-font-mono,monospace);
      color:var(--dsw-alias-accent,#5b8fd6);font-weight:700}
    .zw-palaceitem .pn{flex:1;min-width:0;color:var(--dsw-alias-text-2,#b6bfd0);
      overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
    .zw-fq-hint{margin-top:9px;padding:7px 10px;border-radius:9px;font-size:11px;
      background:rgba(217,161,60,.09);border:1px solid rgba(217,161,60,.3);color:#e8c77e}
    /* 历史列表的记录类型胶囊（daily / range；旧数据无 kind 时不显示） */
    .zw-kind{display:inline-flex;align-items:center;margin-right:5px;padding:0 6px;border-radius:8px;
      line-height:15px;font-size:9.5px;vertical-align:middle;font-family:var(--dsw-alias-font-sans,inherit)}
    .zw-kind.daily{color:#7fc79c;border:1px solid rgba(63,160,106,.45);background:rgba(63,160,106,.12)}
    .zw-kind.range{color:#c9a5e6;border:1px solid rgba(181,127,219,.45);background:rgba(181,127,219,.12)}
    /* ===== 发起对话分析（仅通路） ===== */
    .zw-analyze-wrap{display:inline-flex;align-items:center;gap:5px;min-width:0}
    .zw-analyze-btn{border:1px solid rgba(91,143,214,.55);border-radius:8px;padding:4px 11px;
      font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;
      color:#cfe0f6;background:linear-gradient(135deg,rgba(91,143,214,.3),rgba(91,143,214,.13));
      box-shadow:0 1px 4px rgba(0,0,0,.2);
      transition:transform .12s ease,box-shadow .12s ease,background .12s ease}
    .zw-analyze-btn:hover:not(:disabled){transform:translateY(-1px);
      background:linear-gradient(135deg,rgba(91,143,214,.44),rgba(91,143,214,.2));
      box-shadow:0 4px 12px rgba(91,143,214,.24)}
    .zw-analyze-btn:disabled{opacity:.5;cursor:not-allowed}
    .zw-analyze-btn.sm{padding:2px 8px;font-size:10.5px;border-radius:7px}
    .zw-analyze-err{font-size:10px;color:#efa79f;max-width:160px;overflow:hidden;
      white-space:nowrap;text-overflow:ellipsis}
    `

    /* ================================================================
       5. 通用小组件
       ================================================================ */

    /** 字段行（详情卡片里的一对 key/value）。 */
    function Field({ k, v }) {
      const text = (v === undefined || v === null || v === '') ? '—' : String(v)
      return h('div', { className: 'zw-f' },
        h('span', { className: 'k' }, k),
        h('span', { className: 'v' }, text))
    }

    /** 时辰下拉（0..12），allowEmpty 时多一个「不指定」。 */
    function TimeSelect({ value, onChange, allowEmpty }) {
      return h('select', {
        value: String(value ?? ''),
        onChange: (e) => onChange(e.target.value),
      },
        allowEmpty ? h('option', { key: 'none', value: '' }, '不指定（使用默认）') : null,
        ...TIME_OPTIONS.map((o) => h('option', {
          key: o.index, value: String(o.index),
        }, o.label + '（' + o.range + '）')))
    }

    function GenderSelect({ value, onChange }) {
      return h('select', { value: String(value ?? '男'), onChange: (e) => onChange(e.target.value) },
        ...GENDER_OPTIONS.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
    }

    /**
     * 通用弹窗外壳。
     * 注意：React 把子元素放在 props.children，**不是**第二个位置参数。
     */
    function Modal({ title, busy, onClose, footer, children }) {
      return h('div', {
        className: 'zw-modal',
        onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) onClose() },
      },
        h('div', { className: 'zw-mbox' },
          h('div', { className: 'zw-mh' },
            h('h3', null, title),
            h('button', { className: 'zw-x', title: '关闭', disabled: busy, onClick: onClose }, '×')),
          h('div', { className: 'zw-mb' }, children),
          h('div', { className: 'zw-mf' },
            h('button', { className: 'zw-btn', disabled: busy, onClick: onClose }, '取消'),
            ...(footer || []))))
    }

    /** 二次确认弹窗。onConfirm 返回 {ok:boolean,error?:string}。 */
    function ConfirmModal({ title, message, confirmLabel, busy, onConfirm, onClose }) {
      const [err, setErr] = useState('')
      const run = async () => {
        setErr('')
        try {
          const r = await onConfirm()
          if (r && r.ok === false) setErr(r.error || '操作失败')
        } catch (e) { setErr(String(e?.message ?? e)) }
      }
      return h(Modal, {
        title, busy, onClose,
        footer: [h('button', {
          key: 'ok', className: 'zw-btn danger', disabled: busy, onClick: run,
        }, confirmLabel || '确认删除')],
      },
        h('div', { className: 'zw-callout danger' }, message),
        err ? h('div', { className: 'zw-alert sm' }, err) : null)
    }

    /**
     * 复制 JSON 按钮（**不展示 JSON 内容**）。
     *
     * 用户明确要求去掉 JSON 展示页面，只留一个复制入口。
     * 优先 navigator.clipboard；不可用时退回「临时 textarea + execCommand」，
     * 仍失败则给出可操作的中文提示，不静默。
     */
    function CopyJsonButton({ title, value, label, compact }) {
      const [hint, setHint] = useState('')
      const timerRef = useRef(0)
      useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

      let text
      try { text = JSON.stringify(value ?? null, null, 2) } catch { text = String(value) }

      const flash = (m) => {
        setHint(m)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setHint(''), 2400)
      }
      const copy = async () => {
        if (text === undefined || text === 'undefined') { flash('没有可复制的内容'); return }
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(text)
          flash('已复制 ' + text.length + ' 字符')
          return
        } catch { /* 落到下面的兜底 */ }
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.top = '-1000px'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand && document.execCommand('copy')
          ta.remove()
          flash(ok ? '已复制 ' + text.length + ' 字符' : '复制失败，请手动复制')
        } catch {
          flash('复制失败，请手动复制')
        }
      }

      return h('span', { className: 'zw-copyjson' },
        h('button', {
          className: 'zw-btn sm' + (compact ? ' ghost' : ''),
          title: title ? title + '（' + String(text ?? '').length + ' 字符）' : '',
          onClick: copy,
        }, label || '复制 JSON'),
        hint ? h('span', { className: 'zw-hint zw-copyjson-hint' }, hint) : null)
    }
    /**
     * 一个宫格：宫头（宫名/干支/身宫/来因）+ 主星/辅星/杂曜 + 底部大限小限等。
     * 所有字段都直接取自 iztro 的 palace 对象，取不到就留空，不编造数据。
     */
    function PalaceCell({ slot, palace }) {
      const p = palace || {}
      const name = p.name || ''
      const gz = String(p.heavenlyStem ?? '') + String(p.earthlyBranch ?? '')
      const majors = Array.isArray(p.majorStars) ? p.majorStars : []
      const minors = Array.isArray(p.minorStars) ? p.minorStars : []
      const adjs = Array.isArray(p.adjectiveStars) ? p.adjectiveStars : []
      const decadal = p.decadal && typeof p.decadal === 'object' ? p.decadal : null
      const ages = Array.isArray(p.ages) ? p.ages : null
      const extra = [
        ['长生', p.changsheng12], ['博士', p.boshi12],
        ['将前', p.jiangqian12], ['岁前', p.suiqian12],
      ].filter(([, v]) => v !== undefined && v !== null && v !== '')
      const infoBits = []
      if (decadal && decadal.range !== undefined && decadal.range !== null) {
        infoBits.push(h('span', { key: 'dc', className: 'dc', title: '大限' }, '大限 ' +
          (typeof decadal.range === 'object'
            ? (JSON.stringify(decadal.range)) : String(decadal.range))))
      } else if (decadal && (decadal.heavenlyStem || decadal.earthlyBranch)) {
        infoBits.push(h('span', { key: 'dc', className: 'dc', title: '大限' }, '大限 ' + ganzhiOf(decadal)))
      }
      if (ages && ages.length) {
        const a = ages.length > 8 ? ages.slice(0, 8).join('、') + '…' : ages.join('、')
        infoBits.push(h('span', { key: 'ages', title: '小限岁数 ' + ages.join('、') }, '小限 ' + a))
      }
      extra.forEach(([label, val]) => infoBits.push(h('span', {
        key: label, title: label + '：' + String(val),
      }, String(val))))

      return h('div', {
        className: 'zw-palace' + (name === '命宫' ? ' ming' : ''),
        style: { gridRow: String(slot.row + 1), gridColumn: String(slot.col + 1) },
        title: name + ' · ' + gz + (p.earthlyBranch ? '（' + p.earthlyBranch + '宫）' : ''),
      },
        h('div', { className: 'zw-pal-head' },
          h('span', { className: 'zw-pal-name' }, name || slot.branch + '宫'),
          p.isBodyPalace ? h('span', { className: 'zw-tag-mini body' }, '身宫') : null,
          p.isOriginalPalace ? h('span', { className: 'zw-tag-mini orig' }, '来因') : null,
          gz ? h('span', { className: 'zw-pal-gz' }, gz) : null),
        h('div', { className: 'zw-pal-stars' },
          majors.length
            ? majors.map((s, i) => h('span', { className: 'zw-major', key: 'm' + i },
              h('span', { className: 'nm' }, s?.name ?? ''),
              brightnessLabel(s) ? h('span', { className: 'zw-bright' }, brightnessLabel(s)) : null,
              h(MutagenTag, { text: s?.mutagen })))
            : h('span', { className: 'zw-empty-pal' }, '空宫'),
          minors.length
            ? h('div', { className: 'zw-minors' }, minors.map((s, i) => h('span', { key: 'n' + i }, s?.name ?? '')))
            : null,
          adjs.length
            ? h('div', { className: 'zw-adj' }, adjs.map((s, i) => h('span', { key: 'j' + i }, s?.name ?? '')))
            : null),
        infoBits.length ? h('div', { className: 'zw-pal-foot' }, infoBits) : null)
    }

    /** 中宫信息卡：chart.astrolabe 顶层字段 + chart 元信息，两列 key/value。 */
    function CenterCard({ chart }) {
      const a = chart?.astrolabe || {}
      const eng = chart?.engine
      const engText = eng
        ? (typeof eng === 'object'
          ? [eng.library, eng.version].filter(Boolean).join(' ')
          : String(eng))
        : ''
      const fields = [
        ['性别', a.gender], ['阳历', a.solarDate], ['农历', a.lunarDate], ['四柱', a.chineseDate],
        ['时辰', [a.time, a.timeRange].filter(Boolean).join(' · ')],
        ['生肖', a.zodiac], ['星座', a.sign], ['五行局', a.fiveElementsClass],
        ['命主', a.soul], ['身主', a.body],
        ['命宫地支', a.earthlyBranchOfSoulPalace], ['身宫地支', a.earthlyBranchOfBodyPalace],
        ['盘标签', chart?.label], ['引擎', engText], ['生成时间', chart?.createdAt ? fmtTime(chart.createdAt) : ''],
      ]
      return h('div', { className: 'zw-center' },
        h('div', { className: 'zw-center-h' }, '命盘总览 · 中宫'),
        h('div', { className: 'zw-center-fields' },
          fields.map(([k, v], i) => h(Field, { key: 'cf' + i, k, v }))))
    }

    /**
     * 紫微斗数命盘 4×4 网格（12 宫环绕 + 中宫）。
     * 顶部摘要条 + generated 提示由调用方传入；这里只负责盘面本身。
     */
    function AstrolabeGrid({ chart }) {
      const a = chart?.astrolabe
      if (!a || typeof a !== 'object') {
        return h('div', { className: 'zw-empty' }, '没有可展示的星盘数据。')
      }
      const cells = layoutPalaces(a)
      const summaryBits = [
        ['命主', a.soul], ['身主', a.body], ['五行局', a.fiveElementsClass],
        ['生肖', a.zodiac], ['星座', a.sign], ['四柱', a.chineseDate],
      ].filter(([, v]) => v !== undefined && v !== null && v !== '')
      return h('div', { className: 'zw-chart-top' },
        h('div', { className: 'zw-chart-sum' },
          summaryBits.map(([k, v]) => h('span', { className: 'zw-sumchip', key: 's' + k },
            k + ' ', h('b', null, String(v))))),
        chart?.generated
          ? h('div', { className: 'zw-gen' }, '已按档案生辰生成星盘；修改档案后会自动更新。') : null,
        chart?.input?.calendarType === 'lunar'
          ? h('div', { className: 'zw-hint' }, '本盘按农历生辰排盘（含闰月）') : null,
        h('div', { className: 'zw-chart-scroll' },
          h('div', { className: 'zw-chart' },
            ...cells.map((c) => h(PalaceCell, { key: 'p' + c.branch, slot: c, palace: c.palace })),
            h(CenterCard, { key: 'center', chart }))))
    }

    /**
     * 「发起对话分析」通路（仅搭通路，不写任何分析话术/解读模板）。
     * 点击 → buildAnalysisContext 取 Host 生成的 starterPrompt → 交给父级的
     * launchAnalysis（由 apply/register 作用域里的 uiWorkspace 闭包实现）放进新会话草稿。
     * UI 不自行拼接任何提示词内容。
     */
    function AnalysisLauncher({ personId, horoscopeId, remote, launchAnalysis, compact, label }) {
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const remoteRef = useRef(remote)
      remoteRef.current = remote

      const run = async (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
        if (!personId || !horoscopeId) return
        setError('')
        setLoading(true)
        try {
          const r = await callRemote(remoteRef.current, 'buildAnalysisContext', {
            request: { personId, horoscopeId },
          })
          if (!r.ok) { setError(r.error?.message ?? '分析上下文构建失败'); return }
          const ctx = r.value?.context
          const prompt = ctx?.starterPrompt
          if (!prompt) { setError('宿主未返回可用的会话草稿内容'); return }
          const result = await launchAnalysis(prompt)
          if (result && result.ok === false) setError(result.error || '无法发起会话')
        } catch (e2) {
          setError(String(e2?.message ?? e2))
        } finally {
          setLoading(false)
        }
      }

      return h('span', { className: 'zw-analyze-wrap' },
        h('button', {
          className: 'zw-analyze-btn' + (compact ? ' sm' : ''),
          disabled: loading || !personId || !horoscopeId,
          title: loading
            ? '正在准备分析上下文…'
            : '提示词模板整理中，当前仅建立对话并附带原始数据',
          onClick: run,
        }, loading ? '… 准备中' : (label || (compact ? '✦ 分析' : '✦ 发起对话分析'))),
        error ? h('span', { className: 'zw-analyze-err', title: error }, '⚠ ' + error) : null)
    }

    /**
     * AI 分析回填区块。
     *
     * 回填由模型在分析完后调用 `ziwei_save_analysis` 完成，这里只负责展示。
     * 正文是 Markdown 全文——客户端没有 Markdown 渲染器（只能 require('react')），
     * 所以按行做**轻量渲染**：标题加粗放大、`- ` 列表缩进、`---` 分隔线，
     * 其余原样保留空白与换行，保证不丢信息也不破坏可读性。
     */
    function AnalysisBlock({ analysis }) {
      const [open, setOpen] = useState(true)
      const a = analysis || {}
      const text = String(a.content || '')

      const lines = text.split('\n').map((raw, i) => {
        const line = raw.replace(/\s+$/, '')
        if (!line.trim()) return h('div', { key: 's' + i, className: 'zw-ana-gap' })
        const hm = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hm) {
          const lvl = Math.min(hm[1].length, 4)
          return h('div', { key: 'h' + i, className: 'zw-ana-h lv' + lvl }, hm[2])
        }
        if (/^---+$/.test(line.trim())) return h('div', { key: 'r' + i, className: 'zw-ana-rule' })
        const lm = /^(\s*)[-*+]\s+(.*)$/.exec(line)
        if (lm) {
          return h('div', { key: 'l' + i, className: 'zw-ana-li', style: { paddingLeft: (8 + lm[1].length * 8) + 'px' } },
            h('span', { className: 'zw-ana-dot' }, '·'), lm[2])
        }
        return h('div', { key: 'p' + i, className: 'zw-ana-p' }, line)
      })

      return h('div', { className: 'zw-sec zw-ana' },
        h('div', { className: 'zw-sec-h' },
          h('button', {
            className: 'zw-ana-toggle',
            onClick: () => setOpen(!open),
            title: open ? '收起' : '展开',
          }, (open ? '▾ ' : '▸ ') + 'AI 分析'),
          h('span', { className: 'zw-sp' }),
          a.revisions > 1 ? h('span', { className: 'zw-ana-meta' }, `第 ${a.revisions} 版`) : null,
          a.updatedAt ? h('span', { className: 'zw-ana-meta' }, fmtTime(a.updatedAt)) : null,
          h(CopyJsonButton, { title: '复制分析全文', value: text, label: '复制全文', compact: true })),
        a.summary ? h('div', { className: 'zw-ana-sum' }, a.summary) : null,
        open ? h('div', { className: 'zw-ana-body' }, ...lines) : null)
    }

    /** 某一年的详情卡片：完整字段 + 流年十二宫重排（流年干支起）。 */
    function YearDetail({ item }) {
      if (!item) return null
      const gz = String(item.heavenlyStem ?? '') + String(item.earthlyBranch ?? '')
      const dc = item.decadal || {}
      const dcGz = ganzhiOf(dc)
      const fields = [
        ['代表日期', item.date],
        ['虚岁', item.age != null ? item.age + ' 岁' : ''],
        ['流年干支', gz],
        ['流年落宫', item.palaceName],
        ['流年四化', mutagenText(item.mutagen)],
        ['所属大限', [dc.palaceName || dc.name, dcGz].filter(Boolean).join(' · ')],
        ['大限年段', rangeText(dc.yearRange)],
        ['大限岁段', rangeText(dc.ageRange)],
        ['大限四化', mutagenText(dc.mutagen)],
      ]
      // 流年十二宫：palaceNames[i] 对应 INDEX_BRANCH[i]（0=寅…11=丑）。
      const palaceNames = Array.isArray(item.palaceNames) ? item.palaceNames : []
      return h('div', { className: 'zw-yeardet' },
        h('div', { className: 'zw-yeardet-h' },
          h('span', { className: 'yr' }, String(item.year ?? '—')),
          gz ? h('span', { className: 'gz' }, gz + ' 年') : null,
          item.age != null ? h('span', { className: 'zw-tag-mini' }, '虚岁 ' + item.age) : null,
          item.isCurrentYear ? h('span', { className: 'zw-tl-tag cur' }, '当年') : null),
        h('div', { className: 'zw-fields' },
          fields.map(([k, v], i) => h(Field, { key: 'yd' + i, k, v }))),
        palaceNames.length
          ? h('div', { className: 'zw-palacelist-wrap' },
            h('div', { className: 'zw-palacelist-h' }, '流年十二宫（以流年干支起）'),
            h('div', { className: 'zw-palacelist' },
              INDEX_BRANCH.map((branch, i) => h('div', {
                className: 'zw-palaceitem', key: 'pl' + i,
              },
                h('span', { className: 'br' }, branch),
                h('span', { className: 'pn' }, palaceNames[i] != null ? String(palaceNames[i]) : '—')))))
          : null)
    }

    /**
     * 运势时间轴（range 记录详情页）：scopeLabel + 起算日 + 六层运限摘要
     * + 横向「年份 Tab 条」+ 选中年的详情卡片。
     * 默认选中「当年」，点 Tab 在本页内切换年详情（setSelectedYear），不弹窗、不跳页。
     * 大限分组：同大限年份连续排，切换处插一条竖分隔；分组标题随选中项显示该年所属大限。
     * interactive=false 时不渲染 Tab 条（只显示详情），目前详情页均用默认 true。
     */
    function FortuneTimeline({ fortune, interactive = true }) {
      const cur = fortune?.current
      const scopeRows = cur
        ? SCOPE_ROWS.map(([k, label]) => ({ label, text: scopeBrief(cur[k]) || '—' }))
        : []
      const timeline = Array.isArray(fortune?.timeline) ? fortune.timeline : []
      // 默认选中「当年」，否则第一项；年份作为 key（Host 保证时间轴按年唯一）。
      const [selectedYear, setSelectedYear] = useState(() => {
        const curItem = timeline.find((x) => x?.isCurrentYear) || timeline[0]
        return curItem?.year ?? null
      })
      // 切换记录（fortune 变化）时把选中项重置到该盘的当年/第一项。
      useEffect(() => {
        const curItem = timeline.find((x) => x?.isCurrentYear) || timeline[0]
        setSelectedYear(curItem?.year ?? null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [fortune])
      const selectedItem = timeline.find((x) => String(x?.year) === String(selectedYear))
        || timeline[0] || null

      // 横向年份 Tab：大限切换处插一条竖分隔（.zw-yeartab-sep），同大限年份连续排。
      let lastDecadal = null
      const tabs = []
      timeline.forEach((item, i) => {
        const dk = item?.decadal?.index ?? null
        if (dk !== null && dk !== lastDecadal && tabs.length) {
          tabs.push(h('span', { className: 'zw-yeartab-sep', key: 'sep-' + i }))
        }
        lastDecadal = dk
        const gz = String(item?.heavenlyStem ?? '') + String(item?.earthlyBranch ?? '')
        const isSel = interactive && String(item?.year) === String(selectedYear)
        tabs.push(h('div', {
          className: 'zw-yeartab'
            + (isSel ? ' sel' : '')
            + (item?.isCurrentYear ? ' cur' : ''),
          key: 'yt-' + (item?.year ?? i) + '-' + i,
          title: timelineSummary(item),
          onClick: interactive ? () => setSelectedYear(item?.year ?? i) : undefined,
        },
          item?.isCurrentYear ? h('span', { className: 'zw-yeartab-curmark' }, '今') : null,
          h('span', { className: 'yt-year' }, String(item?.year ?? '—')),
          gz ? h('span', { className: 'yt-gz' }, gz) : null))
      })

      // 分组标题随选中年变化：显示该年所属大限（简单、不挤占 Tab 条空间）。
      const selDc = selectedItem?.decadal
      const groupText = selDc
        ? '大限：' + (selDc.palaceName || selDc.name || ('第 ' + (selDc.index ?? '') + ' 限'))
          + (ganzhiOf(selDc) ? ' ' + ganzhiOf(selDc) : '')
          + (rangeText(selDc.yearRange) ? ' · ' + rangeText(selDc.yearRange) : '')
        : ''

      return h('div', { className: 'zw-fq-result' },
        h('div', { className: 'zw-fq-scope' },
          h('span', { className: 'lb' }, fortune?.scopeLabel || '运势时间轴'),
          h('span', { className: 'base' },
            '起算 ' + (fortune?.baseDate || '—') + ' · 今天 ' + (fortune?.today || '—')),
          cur?.label ? h('span', { className: 'zw-badge' }, String(cur.label)) : null),
        scopeRows.length
          ? h('div', { className: 'zw-fq-scopes' },
            scopeRows.map((row) => h('div', { className: 'row', key: 'sc-' + row.label },
              h('span', { className: 'k' }, row.label),
              h('span', { className: 'v' }, row.text))))
          : null,
        timeline.length
          ? h('div', { className: 'zw-yeartabs-wrap', key: 'ytabs' },
            groupText ? h('div', { className: 'zw-yeartabs-group' }, groupText) : null,
            interactive ? h('div', { className: 'zw-yeartabs' }, tabs) : null)
          : h('div', { className: 'zw-empty' }, '没有可展示的时间轴数据。'),
        selectedItem
          ? h(YearDetail, { key: 'yd-' + selectedYear, item: selectedItem })
          : null)
    }

    /**
     * 快捷运势查询工具条（今天 / 明天 / 未来 N 年 / 自定义）。
     * getFortune 会写入一条运限历史记录（今天/明天按日期去重），成功后刷新下方历史列表。
     * 用户只要「记录列表 + 快捷按钮」，这里不做即时结果展示；结果到详情里看。
     */
    function FortuneQuick({ personId, remote, busy, onError, onRecordCreated, clearKey }) {
      const [years, setYears] = useState('10')
      const [customDate, setCustomDate] = useState(todayDateInput())
      const [loading, setLoading] = useState(false)
      const [localErr, setLocalErr] = useState('')
      /** 温和提示：deduplicated=true 时「该日期已有记录，已复用」。 */
      const [notice, setNotice] = useState('')
      const remoteRef = useRef(remote)
      remoteRef.current = remote

      // 切换人员时收起本地 loading/err/notice。
      useEffect(() => { setLoading(false); setLocalErr(''); setNotice('') }, [clearKey])

      const run = async (preset) => {
        if (!personId) return
        const n = Math.min(30, Math.max(1, Number(years) || 10))
        const req = { personId, preset }
        if (preset === 'nYears') req.years = n
        if (preset === 'custom') req.targetDate = toSolarDate(customDate)
        setLocalErr('')
        setNotice('')
        setLoading(true)
        try {
          const r = await callRemote(remoteRef.current, 'getFortune', { request: req })
          if (!r.ok) {
            const m = r.error?.message ?? '运势计算失败'
            setLocalErr(m)
            onError && onError(m)
            return
          }
          const dedup = !!(r.value?.deduplicated ?? r.value?.record?.deduplicated)
          setNotice(dedup ? '该日期已有记录，已复用（未新建）。' : '')
          // getFortune 会落库一条运限历史记录：通知父级刷新下方列表。
          if (onRecordCreated) onRecordCreated(personId)
        } catch (e) {
          const m = String(e?.message ?? e)
          setLocalErr(m)
          onError && onError(m)
        } finally {
          setLoading(false)
        }
      }

      return h('div', { className: 'zw-fortune' },
        h('div', { className: 'zw-fq-h' },
          h('span', { className: 'ttl' }, '⚡ 快捷运势查询'),
          h('span', { className: 'zw-hint' }, '查询会记入下方历史，点记录查看详情；今天/明天按日期去重')),
        h('div', { className: 'zw-fq-bar' },
          h('button', {
            className: 'zw-btn sm', disabled: busy || loading || !personId,
            onClick: () => run('today'),
          }, '今天'),
          h('button', {
            className: 'zw-btn sm', disabled: busy || loading || !personId,
            onClick: () => run('tomorrow'),
          }, '明天'),
          h('span', { className: 'zw-hint' }, '未来'),
          h('input', {
            className: 'zw-fq-input', type: 'number', min: 1, max: 30, value: years,
            disabled: busy || loading || !personId,
            onChange: (e) => setYears(e.target.value),
          }),
          h('span', { className: 'zw-hint' }, '年'),
          h('button', {
            className: 'zw-btn primary sm', disabled: busy || loading || !personId,
            onClick: () => run('nYears'),
          }, '生成记录'),
          h('input', {
            className: 'zw-fq-date', type: 'date', value: customDate,
            disabled: busy || loading || !personId,
            onChange: (e) => setCustomDate(e.target.value),
          }),
          h('button', {
            className: 'zw-btn sm', disabled: busy || loading || !personId,
            onClick: () => run('custom'),
          }, '自定义日')),
        loading
          ? h('div', { className: 'zw-loading' }, '正在生成记录…')
          : localErr
            ? h('div', { className: 'zw-fq-err' }, localErr)
            : notice
              ? h('div', { className: 'zw-fq-hint' }, notice)
              : null)
    }

    /**
     * 农历日期输入：年 / 月 / 日 三个 select + 闰月勾选。
     * 浏览器端无历法依赖，日固定给 1..30；「该年是否有闰月 / 该月几天」由 Host 校验。
     * 输出 birthDate='YYYY-M-D'（月份数字 1..12）与 isLeapMonth。
     */
    function LunarDateInput({ value, leap, onLeapChange, onChange }) {
      const { y, m, d } = parseYMD(value)
      const emit = (ny, nm, nd) => onChange(lunarToYMD(ny, nm, nd))
      return h('div', null,
        h('div', { className: 'zw-lunar3' },
          h('div', null,
            h('label', null, '农历年'),
            h('select', {
              value: String(y), onChange: (e) => emit(Number(e.target.value), m, d),
            }, LUNAR_YEARS.map((yy) => h('option', { key: yy, value: String(yy) }, String(yy) + ' 年')))),
          h('div', null,
            h('label', null, '农历月'),
            h('select', {
              value: String(m), onChange: (e) => emit(y, Number(e.target.value), d),
            }, LUNAR_MONTHS.map((label, i) => h('option', { key: i + 1, value: String(i + 1) },
              (leap ? '闰' : '') + label)))),
          h('div', null,
            h('label', null, '农历日'),
            h('select', {
              value: String(Math.min(Math.max(d, 1), 30)), onChange: (e) => emit(y, m, Number(e.target.value)),
            }, LUNAR_DAYS.map((label, i) => h('option', { key: i + 1, value: String(i + 1) }, label))))),
        h('label', { className: 'zw-leap' },
          h('input', { type: 'checkbox', checked: !!leap, onChange: (e) => onLeapChange(e.target.checked) }),
          '闰月（该年确有此闰月时勾选）'))
    }

    /**
     * 地区选择器（省 → 市两级联）。
     *
     * 数据由 Host 的 `listRegions` 提供（省/市 + 经纬度），只在真太阳时
     * 启用后才需要。城市数量 337 条，用原生 select 两级联动即可，
     * 不必上搜索框。
     *
     * 选中的城市名会作为 `regionName` 提交——Host 用这个名字反查经纬度，
     * 客户端拿到的经纬度只用于即时预览，不作为可信来源。
     */
    function RegionPicker({ value, onChange, disabled, remote }) {
      const [data, setData] = useState(null)
      const [loadErr, setLoadErr] = useState('')
      const remoteRef = useRef(remote)
      remoteRef.current = remote

      // 挂载时拉一次地区表；失败只影响本控件，不打断整个表单。
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const r = await callRemote(remoteRef.current, 'listRegions', undefined)
            if (cancelled) return
            if (!r.ok) { setLoadErr(r.error?.message ?? '加载地区失败'); return }
            setData(r.value)
          } catch (e) {
            if (!cancelled) setLoadErr(String(e?.message ?? e))
          }
        })()
        return () => { cancelled = true }
      }, [])

      // 反查当前值所属省份：value 是城市名，需要从已选值推出省份下拉的选中项。
      const provinces = data?.provinces ?? []
      const currentProvince = (() => {
        if (!value) return ''
        for (const p of provinces) {
          if ((p.cities ?? []).some((c) => c.name === value)) return p.name
        }
        return ''
      })()
      const [province, setProvince] = useState(currentProvince)
      // 外部值变化（编辑已有人员）时同步省份。
      useEffect(() => { setProvince(currentProvince) }, [currentProvince])

      const cities = (provinces.find((p) => p.name === province)?.cities) ?? []

      if (loadErr) return h('div', { className: 'zw-hint' }, '地区数据不可用：' + loadErr)
      if (!data) return h('div', { className: 'zw-hint' }, '正在加载地区…')

      return h('div', { className: 'zw-region' },
        h('select', {
          value: province, disabled,
          onChange: (e) => { setProvince(e.target.value); onChange('') },
        },
          h('option', { value: '' }, '选择省份…'),
          provinces.map((p) => h('option', { key: p.name, value: p.name }, p.name))),
        h('select', {
          value: value || '', disabled: disabled || !province,
          onChange: (e) => onChange(e.target.value),
        },
          h('option', { value: '' }, province ? '选择城市…' : '请先选省份'),
          cities.map((c) => h('option', { key: c.name, value: c.name }, c.name))))
    }

    /**
     * 新增 / 编辑人员弹窗。onSubmit 返回 {ok,error}。
     * 支持阳历 / 农历（含闰月）两种历法，日期变化时调 convertDate 做实时对照预览。
     */
    function PersonModal({ mode, person, busy, onSubmit, onClose, remote, launchAnalysis }) {
      const [name, setName] = useState(person?.name ?? '')
      const [gender, setGender] = useState(person?.gender ?? '男')
      const [calendarType, setCalendarType] = useState(person?.calendarType === 'lunar' ? 'lunar' : 'solar')
      // 阳历模式用 date input；农历模式 birthDate 存的是农历 YYYY-M-D。
      const [solarDate, setSolarDate] = useState(
        toDateInput(person?.solarDate || (person?.calendarType === 'lunar' ? '' : person?.birthDate)) || todayDateInput())
      const [lunarDate, setLunarDate] = useState(person?.calendarType === 'lunar'
        ? (person?.birthDate || toSolarDate(todayDateInput()))
        : toSolarDate(todayDateInput()))
      const [isLeapMonth, setIsLeapMonth] = useState(!!person?.isLeapMonth)
      const [timeIndex, setTimeIndex] = useState(String(person?.birthTimeIndex ?? 0))
      const [formErr, setFormErr] = useState('')
      const [preview, setPreview] = useState(null)
      const [calibrating, setCalibrating] = useState(false)
      /* ---------- 真太阳时 ---------- */
      const [useTst, setUseTst] = useState(person?.useTrueSolarTime === true)
      const [regionName, setRegionName] = useState(person?.regionName ?? '')
      const [birthClock, setBirthClock] = useState(person?.birthClock ?? '')
      const [tst, setTst] = useState(null)     // 校正预览结果
      const remoteRef = useRef(remote)
      remoteRef.current = remote

      const birthDate = calendarType === 'lunar' ? lunarDate : solarDate
      const leap = calendarType === 'lunar' ? isLeapMonth : false

      /**
       * 定盘：不知道生辰时辰时，让 AI 把这一天 13 个时辰的盘都列出来。
       *
       * 只做两件事：校验表单已填好 → 把 Host 生成的提示词放进新会话草稿。
       * **不写盘**：只是打开一个对话，用户对照后回来在同一个弹窗里选时辰。
       */
      const runCalibrate = async () => {
        const n = name.trim()
        if (!n) { setFormErr('请先填写姓名，定盘后会用它建档'); return }
        const d = toSolarDate(birthDate)
        if (!d) { setFormErr('请先选择出生日期'); return }
        setFormErr('')
        setCalibrating(true)
        try {
          const r = await callRemote(remoteRef.current, 'listTimeCandidates', {
            request: {
              // 姓名一并带上：Host 会写进提示词的建档指令，
              // 否则 AI 建档时只能填占位符或反过来问用户。
              name: n,
              gender, birthDate: d, calendarType,
              ...(calendarType === 'lunar' ? { isLeapMonth: !!isLeapMonth } : {}),
            },
          })
          if (!r.ok) { setFormErr(r.error?.message ?? '定盘计算失败'); return }
          const prompt = r.value?.starterPrompt
          if (!prompt) { setFormErr('宿主未返回定盘提示词'); return }
          if (typeof launchAnalysis !== 'function') {
            setFormErr('当前 DSH 版本不支持发起会话')
            return
          }
          const res = await launchAnalysis(prompt)
          if (res && res.ok === false) { setFormErr(res.error || '无法发起会话'); return }
          // 会话已开好；弹窗保持打开，用户对照完回来直接选时辰点保存。
          setFormErr('')
        } catch (e) {
          setFormErr(String(e?.message ?? e))
        } finally {
          setCalibrating(false)
        }
      }

      /* 真太阳时实时预览：勾选后随日期/时辰/地区/精确时刻变化重算（debounce 250ms）。 */
      useEffect(() => {
        if (!useTst || !regionName) { setTst(null); return }
        const d = toSolarDate(birthDate)
        if (!d) { setTst(null); return }
        const timer = setTimeout(async () => {
          try {
            const r = await callRemote(remoteRef.current, 'previewTrueSolarTime', {
              request: {
                birthDate: d, calendarType,
                ...(calendarType === 'lunar' ? { isLeapMonth: !!isLeapMonth } : {}),
                birthTimeIndex: Number(timeIndex),
                birthClock: birthClock || undefined,
                regionName,
              },
            })
            if (!r.ok) { setTst({ error: r.error?.message ?? '校正失败' }); return }
            setTst(r.value)
          } catch (e) { setTst({ error: String(e?.message ?? e) }) }
        }, 250)
        return () => clearTimeout(timer)
      }, [useTst, regionName, birthClock, birthDate, calendarType, isLeapMonth, timeIndex])

      /* 实时对照预览：debounce 250ms，失败静默不显示，绝不打断表单。 */
      useEffect(() => {
        const d = toSolarDate(birthDate)
        if (!d) { setPreview(null); return }
        const timer = setTimeout(async () => {
          try {
            const r = await callRemote(remoteRef.current, 'convertDate', {
              request: { calendarType, birthDate: d, isLeapMonth: leap },
            })
            if (!r.ok) return
            setPreview({
              solarDate: r.value?.solarDate,
              lunarText: r.value?.lunarText,
              display: r.value?.display,
            })
          } catch { /* 静默 */ }
        }, 250)
        return () => clearTimeout(timer)
      }, [calendarType, birthDate, leap])

      const save = async () => {
        const n = name.trim()
        if (!n) { setFormErr('请填写姓名'); return }
        const d = toSolarDate(birthDate)
        if (!d) { setFormErr('请选择出生日期'); return }
        const ti = Number(timeIndex)
        if (!Number.isInteger(ti) || ti < 0 || ti > 12) { setFormErr('请选择出生时辰'); return }
        const req = { name: n, gender, birthDate: d, birthTimeIndex: ti, calendarType }
        if (calendarType === 'lunar') req.isLeapMonth = !!isLeapMonth
        // 真太阳时：开启时必须选地区；关闭时传 false 让 Host 清掉地区字段。
        req.useTrueSolarTime = !!useTst
        if (useTst) {
          if (!regionName) { setFormErr('已启用真太阳时，请选择出生地区'); return }
          req.regionName = regionName
          if (birthClock) req.birthClock = birthClock
        }
        setFormErr('')
        let r
        try { r = await onSubmit(req) } catch (e) { r = caught(e) }
        if (r && r.ok === false) setFormErr(r.error || '保存失败')
      }

      return h(Modal, {
        title: mode === 'edit' ? '编辑人员' : '新增人员',
        busy, onClose,
        footer: [h('button', {
          key: 'ok', className: 'zw-btn primary', disabled: busy, onClick: save,
        }, '保存')],
      },
        h('label', null, '姓名（必填）'),
        h('input', { type: 'text', value: name, placeholder: '请输入姓名', onChange: (e) => setName(e.target.value) }),
        h('label', null, '历法'),
        h('div', { className: 'zw-seg' },
          h('button', {
            className: calendarType === 'solar' ? 'on' : '',
            onClick: () => setCalendarType('solar'),
          }, '阳历'),
          h('button', {
            className: calendarType === 'lunar' ? 'on' : '',
            onClick: () => setCalendarType('lunar'),
          }, '农历')),
        h('div', { className: 'zw-cal-block' },
          calendarType === 'solar'
            ? h('div', null,
              h('label', null, '出生日期（阳历，必填）'),
              h('input', { type: 'date', value: solarDate, onChange: (e) => setSolarDate(e.target.value) }))
            : h('div', null,
              h('label', null, '出生日期（农历，必填）'),
              h(LunarDateInput, {
                value: lunarDate, leap: isLeapMonth,
                onLeapChange: setIsLeapMonth, onChange: setLunarDate,
              })),
          preview
            ? h('div', { className: 'zw-preview' },
              '≈ 阳历 ', h('b', null, preview.solarDate || '—'),
              preview.lunarText ? [' · 农历 ', h('b', { key: 'lt' }, preview.lunarText)] : null,
              preview.display ? h('div', { key: 'dp', className: 'zw-hint' }, preview.display) : null)
            : null,
          h('div', { className: 'zw-hint' },
            calendarType === 'lunar'
              ? '日下拉固定为初一~三十；该年是否真有此闰月、当月是 29 还是 30 天由服务端校验，不合法会给出明确错误。'
              : '阳历日期按 YYYY-M-D 传给 Host。')),
        h('div', { className: 'zw-row2' },
          h('div', null,
            h('label', null, '性别'),
            h(GenderSelect, { value: gender, onChange: setGender })),
          h('div', null,
            h('label', { className: 'zw-time-label' },
              h('span', null, '出生时辰（必填）'),
              mode === 'add'
                ? h('button', {
                  className: 'zw-calibrate-btn',
                  type: 'button',
                  disabled: busy || calibrating,
                  title: '不记得时辰？让 AI 把这一天 13 个时辰的盘都列出来，你对照哪个最像自己',
                  onClick: runCalibrate,
                }, calibrating ? '准备中…' : '不记得？让 AI 定盘')
                : null),
            h(TimeSelect, { value: timeIndex, onChange: setTimeIndex }))),
        h('div', { className: 'zw-hint' },
          '时辰序号与 iztro 的 0..12 一致；修改生辰后星盘会自动重算。',
          mode === 'add'
            ? h('div', null, '定盘会新开一个对话，不会建档案；对照完回到这里选时辰再保存。')
            : null),

        /* ---------- 真太阳时 ---------- */
        h('label', { className: 'zw-tst-toggle' },
          h('input', {
            type: 'checkbox', checked: !!useTst,
            onChange: (e) => {
              setUseTst(e.target.checked)
              if (!e.target.checked) { setRegionName(''); setBirthClock(''); setTst(null) }
            },
          }),
          h('span', null, '使用真太阳时'),
          h('span', { className: 'zw-hint' },
            '按出生地经度与时差校正时辰；经度偏离东经 120° 越大，差得越多')),

        useTst
          ? h('div', { className: 'zw-tst-block' },
            h('label', null, '出生地区（必填）'),
            h(RegionPicker, {
              value: regionName, onChange: setRegionName,
              disabled: busy, remote,
            }),
            h('div', { className: 'zw-row2' },
              h('div', null,
                h('label', null, '精确出生时刻（可选）'),
                h('input', {
                  type: 'time', value: birthClock,
                  placeholder: '不填则按时辰中点',
                  onChange: (e) => setBirthClock(e.target.value),
                }))),
            h('div', { className: 'zw-hint' },
              '不填时刻时，按所选时辰的区间中点推算——精度略低但不必强求。'),
            // 校正结果：把「填写值 → 校正值」摆明，时辰/日期变了要显眼提示
            tst?.error
              ? h('div', { className: 'zw-alert sm' }, tst.error)
              : tst
                ? h('div', { className: 'zw-tst-result' },
                  h('div', { className: 'zw-tst-row' },
                    h('span', { className: 'k' }, '你填写'),
                    h('span', { className: 'v' },
                      (tst.written.solarDate || '') + ' ' + (tst.written.clock || tst.written.timeLabel))),
                  h('div', { className: 'zw-tst-arrow' }, '↓ 校正'),
                  h('div', { className: 'zw-tst-row hi' },
                    h('span', { className: 'k' }, '真太阳时'),
                    h('span', { className: 'v' },
                      (tst.corrected.solarDate || '') + ' ' + tst.corrected.clock,
                      '/' + tst.corrected.timeLabel)),
                  h('div', { className: 'zw-tst-detail' },
                    '经度修正 ' + fmtMin(tst.correction.longitudeMinutes)
                    + ' · 均时差 ' + fmtMin(tst.correction.equationOfTimeMinutes)
                    + ' · 合计 ' + fmtMin(tst.correction.totalMinutes)),
                  tst.timeIndexChanged
                    ? h('div', { className: 'zw-tst-warn' },
                      '⚠ 时辰已由「' + tst.written.timeLabel + '」校正为「' + tst.corrected.timeLabel + '」，排盘会用校正后的时辰。')
                    : null,
                  tst.dateChanged
                    ? h('div', { className: 'zw-tst-warn' },
                      '⚠ 校正后跨日（' + (tst.corrected.dayShift > 0 ? '后一天' : '前一天')
                      + '），日期已同步调整为 ' + tst.corrected.solarDate + '。')
                    : null)
                : null)
          : null,

        formErr ? h('div', { className: 'zw-alert sm' }, formErr) : null)
    }

    /**
     * 新增运限查询弹窗：目标日期 / 时辰 / 备注。
     * 需求 A：Host 自动使用该人员唯一的那张盘（没有就先生成），所以不再需要选盘下拉。
     */
    function HoroscopeModal({ personId, busy, onSubmit, onClose }) {
      const [targetDate, setTargetDate] = useState(todayDateInput())
      const [timeIndex, setTimeIndex] = useState('')
      const [label, setLabel] = useState('')
      const [formErr, setFormErr] = useState('')

      const save = async () => {
        const d = toSolarDate(targetDate)
        if (!d) { setFormErr('请选择查询目标日期'); return }
        const req = { personId, targetDate: d }
        if (timeIndex !== '') req.timeIndex = Number(timeIndex)
        if (label.trim()) req.label = label.trim()
        setFormErr('')
        let r
        try { r = await onSubmit(req) } catch (e) { r = caught(e) }
        if (r && r.ok === false) setFormErr(r.error || '运限查询失败')
      }

      return h(Modal, {
        title: '新增运限查询', busy, onClose,
        footer: [h('button', {
          key: 'ok', className: 'zw-btn primary', disabled: busy, onClick: save,
        }, '查询')],
      },
        h('div', { className: 'zw-row2' },
          h('div', null,
            h('label', null, '目标日期（必填）'),
            h('input', { type: 'date', value: targetDate, onChange: (e) => setTargetDate(e.target.value) })),
          h('div', null,
            h('label', null, '时辰（可选）'),
            h(TimeSelect, { value: timeIndex, onChange: setTimeIndex, allowEmpty: true }))),
        h('label', null, '备注 label（可选）'),
        h('input', { type: 'text', value: label, placeholder: '例如：2026 流年', onChange: (e) => setLabel(e.target.value) }),
        h('div', { className: 'zw-hint' },
          '运限目标日期按阳历填写（iztro horoscope 用阳历），按 YYYY-M-D 传给 Host；不指定时辰时由 Host 使用默认值。'),
        formErr ? h('div', { className: 'zw-alert sm' }, formErr) : null)
    }

    /* ================================================================
       6. 主组件
       ================================================================ */

    /** 左侧栏入口图标：折叠态给 tooltip + aria-label，展开态宿主按 label 显示文字。 */
    function PanelIcon({ size, active }) {
      const px = typeof size === 'number' ? size : 16
      return h('span', {
        title: '紫微斗数工作台',
        'aria-label': '紫微斗数工作台',
        style: {
          fontSize: px + 'px', lineHeight: 1, display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          color: active ? 'var(--dsw-alias-accent,#5b8fd6)' : 'inherit',
        },
      }, '☯')
    }

    function Workbench({ remote, launchAnalysis }) {
      // 兜底：宿主未提供 uiWorkspace 能力时，按钮给出明确降级提示而非静默失败。
      const doLaunch = typeof launchAnalysis === 'function'
        ? launchAnalysis
        : async () => ({ ok: false, error: '当前 DSH 版本不支持发起会话' })
      /* ---- 列表与选中态 ---- */
      const [people, setPeople] = useState([])
      const [loadingPeople, setLoadingPeople] = useState(true)
      const [selectedId, setSelectedId] = useState(null)
      const [tab, setTab] = useState('person')

      /* ---- 详情数据 ---- */
      const [person, setPerson] = useState(null)
      const [charts, setCharts] = useState([])
      const [horoscopes, setHoroscopes] = useState([])
      const [loadingDetail, setLoadingDetail] = useState(false)

      /* ---- 星盘 tab 内部（一人一盘，由生辰唯一确定，修改档案后自动重算） ---- */
      const [chartDetail, setChartDetail] = useState(null)
      const [loadingChart, setLoadingChart] = useState(false)

      /* ---- 运限 tab 内部：列表 → 详情两级视图 ---- */
      const [horoscopeDetailId, setHoroscopeDetailId] = useState(null)
      const [horoscopeDetail, setHoroscopeDetail] = useState(null)
      const [loadingHoroscope, setLoadingHoroscope] = useState(false)

      /* ---- 全局状态 ---- */
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState(null)
      /** 非致命警告（例如：档案已保存，但星盘重算失败）。 */
      const [warn, setWarn] = useState(null)
      const [diag, setDiag] = useState('')
      const [personModal, setPersonModal] = useState(null)   // {mode:'add'|'edit', person?}
      const [horoscopeModal, setHoroscopeModal] = useState(false)
      const [confirm, setConfirm] = useState(null)

      /** remote 每次渲染都可能是新引用，用 ref 持有最新值，避免 effect 反复触发。 */
      const remoteRef = useRef(remote)
      remoteRef.current = remote
      /** 防止快速切换人员时旧请求覆盖新数据。 */
      const seqRef = useRef(0)

      /* ---------------- 数据加载 ---------------- */

      const loadPeople = useCallback(async () => {
        const r = await callRemote(remoteRef.current, 'listPeople', { request: {} })
        if (!r.ok) { setErr(r.error?.message ?? '读取人员列表失败'); return [] }
        const list = Array.isArray(r.value?.people) ? r.value.people : []
        setPeople(list)
        return list
      }, [])

      /** 选中人员后并行 getPerson + listCharts + listHoroscopes。 */
      const loadDetail = useCallback(async (id) => {
        if (!id) return
        const seq = ++seqRef.current
        setLoadingDetail(true)
        try {
          const [a, b, c] = await Promise.all([
            callRemote(remoteRef.current, 'getPerson', { request: { personId: id } }),
            callRemote(remoteRef.current, 'listCharts', { request: { personId: id } }),
            callRemote(remoteRef.current, 'listHoroscopes', { request: { personId: id } }),
          ])
          if (seq !== seqRef.current) return
          const failed = [a, b, c].find((x) => !x.ok)
          if (failed) { setErr(failed.error?.message ?? '读取人员详情失败'); return }
          setPerson(a.value?.person ?? null)
          setCharts(Array.isArray(b.value?.charts) ? b.value.charts : [])
          setHoroscopes(Array.isArray(c.value?.records) ? c.value.records : [])
          setErr(null)
        } catch (e) {
          if (seq === seqRef.current) setErr(String(e?.message ?? e))
        } finally {
          if (seq === seqRef.current) setLoadingDetail(false)
        }
      }, [])

      /**
       * 只刷新运限历史列表（不整页重载、不闪烁）。
       * getFortune 会落库一条记录，快捷卡片区成功后调它让新记录立刻出现在下方列表。
       */
      const refreshHoroscopes = useCallback(async (id) => {
        if (!id) return
        try {
          const r = await callRemote(remoteRef.current, 'listHoroscopes', { request: { personId: id } })
          if (!r.ok) return
          setHoroscopes(Array.isArray(r.value?.records) ? r.value.records : [])
        } catch { /* 刷新失败不打断快捷查看结果 */ }
      }, [])

      /**
       * 读取该人员唯一的那张盘。
       * 星盘由生辰唯一确定：Host 的 getChart({ request:{personId} }) 首次调用时自动生成并持久化，
       * 之后复用；修改档案生辰时 updatePerson 会自动重算。这里不传 chartId，也无需手动触发排盘。
       * 返回值 { ok:true, chart:{...}, generated:boolean }。
       */
      const loadChart = useCallback(async (id) => {
        if (!id) return
        setLoadingChart(true)
        try {
          const r = await callRemote(remoteRef.current, 'getChart', { request: { personId: id } })
          if (!r.ok) { setErr(r.error?.message ?? '读取星盘失败'); setChartDetail(null); return }
          const chart = r.value?.chart ?? null
          // generated 在 r.value 顶层（不在 chart 内），挂在视图对象上供 AstrolabeGrid 提示。
          setChartDetail(chart ? { ...chart, generated: !!r.value?.generated } : null)
          setErr(null)
        } catch (e) {
          setErr(String(e?.message ?? e))
        } finally {
          setLoadingChart(false)
        }
      }, [])

      /** 写操作后刷新：列表 + 当前人员详情。 */
      const refreshAll = useCallback(async () => {
        await Promise.all([
          loadPeople(),
          selectedId ? loadDetail(selectedId) : Promise.resolve(),
        ])
      }, [loadPeople, loadDetail, selectedId])

      /* 进入组件：listPeople + diagnostics（诊断失败不报错，只不显示状态）。 */
      useEffect(() => {
        let cancelled = false
        ;(async () => {
          setLoadingPeople(true)
          try {
            const list = await loadPeople()
            if (cancelled) return
            if (list.length) setSelectedId(list[0].id)
          } catch (e) {
            if (!cancelled) setErr(String(e?.message ?? e))
          } finally {
            if (!cancelled) setLoadingPeople(false)
          }
        })()
        return () => { cancelled = true }
      }, [loadPeople])

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const r = await callRemote(remoteRef.current, 'diagnostics', undefined)
            if (cancelled || !r.ok) return
            const v = r.value || {}
            const bits = []
            if (v.engine?.library) bits.push('引擎 ' + v.engine.library)
            if (v.version) bits.push('v' + v.version)
            setDiag(bits.join(' · ') || '已连接')
          } catch { /* 诊断失败不阻断主流程 */ }
        })()
        return () => { cancelled = true }
      }, [])

      /* 选中人员 → 加载详情。 */
      useEffect(() => {
        if (!selectedId) {
          setPerson(null); setCharts([]); setHoroscopes([])
          return
        }
        loadDetail(selectedId)
      }, [selectedId, loadDetail])

      /* 切换人员：清空上一人的星盘与运限详情（保留当前 tab）。 */
      useEffect(() => {
        setChartDetail(null)
        setHoroscopeDetailId(null)
        setHoroscopeDetail(null)
        setHoroscopeModal(false)
        setConfirm(null)
      }, [selectedId])

      /* 星盘 tab：切到该 tab 且已选人员时，调 getChart({personId}) 自动按需生成 / 复用唯一星盘。 */
      useEffect(() => {
        if (tab !== 'chart' || !selectedId) return
        loadChart(selectedId)
      }, [tab, selectedId, loadChart])

      /* 运限 tab：点进详情后按需加载完整 horoscope + astrolabe JSON。 */
      useEffect(() => {
        if (tab !== 'horoscope' || !selectedId || !horoscopeDetailId) return
        let cancelled = false
        ;(async () => {
          setLoadingHoroscope(true)
          try {
            const r = await callRemote(remoteRef.current, 'getHoroscope', {
              request: { personId: selectedId, horoscopeId: horoscopeDetailId },
            })
            if (cancelled) return
            if (!r.ok) { setErr(r.error?.message ?? '读取运限详情失败'); setHoroscopeDetail(null); return }
            setHoroscopeDetail(r.value ?? null)
          } catch (e) {
            if (!cancelled) setErr(String(e?.message ?? e))
          } finally {
            if (!cancelled) setLoadingHoroscope(false)
          }
        })()
        return () => { cancelled = true }
      }, [tab, selectedId, horoscopeDetailId])

      /* ---------------- 写操作 ---------------- */

      /** 新增 / 编辑人员。返回 {ok,error} 供弹窗显示内联错误。 */
      const runPersonSubmit = async (form) => {
        const isEdit = personModal?.mode === 'edit'
        const editId = personModal?.person?.id ?? selectedId
        setBusy(true)
        try {
          const r = isEdit
            ? await callRemote(remoteRef.current, 'updatePerson', {
              request: { personId: editId, patch: form },
            })
            : await callRemote(remoteRef.current, 'addPerson', { request: form })
          if (!r.ok) { const m = r.error?.message ?? '保存失败'; setErr(m); return { ok: false, error: m } }
          const newId = isEdit ? editId : (r.value?.person?.id ?? null)
          setPersonModal(null)
          await loadPeople()
          if (!isEdit && newId) setSelectedId(newId)
          else if (isEdit) {
            await loadDetail(editId)
            // 生辰变更后 Host 会自动重算星盘：当前在星盘 tab 就立即刷新，
            // 否则清空让下次切到该 tab 时按需重新 getChart。
            if (tab === 'chart') await loadChart(editId)
            else setChartDetail(null)
          }
          // Host 在「档案已保存但星盘重算失败」时返回 warning：用独立状态展示，
          // 不与 err 互相覆盖（loadChart 成功时会清 err）。
          if (r.value?.warning) setWarn(String(r.value.warning))
          else setWarn(null)
          setErr(null)
          return { ok: true }
        } catch (e) { const m = String(e?.message ?? e); setErr(m); return { ok: false, error: m } }
        finally { setBusy(false) }
      }

      const askDeletePerson = (p) => setConfirm({
        title: '删除人员',
        message: '确定要删除人员「' + (p?.name || '未命名') + '」吗？该人员下的所有星盘与运限记录也会被删除，此操作不可撤销。',
        confirmLabel: '确认删除',
        onConfirm: async () => {
          setBusy(true)
          try {
            const r = await callRemote(remoteRef.current, 'deletePerson', { request: { personId: p.id } })
            if (!r.ok) return failOf(r, '删除人员失败')
            setConfirm(null)
            await loadPeople()
            if (String(selectedId) === String(p.id)) setSelectedId(null)
            setErr(null)
            return { ok: true }
          } catch (e) { return caught(e) }
          finally { setBusy(false) }
        },
      })

      /**
       * 「重新生成」：可选加分项。UI 只在星盘 tab 底部放一个很不起眼的链接，
       * 点它二次确认后调 createChart({ personId, force:true })，再重新 getChart。
       * 主流程完全不依赖它（星盘由生辰唯一确定，修改档案后 updatePerson 会自动重算）。
       */
      const askRegenerateChart = () => setConfirm({
        title: '重新生成星盘',
        message: '将按该人员当前档案重新排盘并覆盖原有星盘，运限历史仍会保留但星盘内容会变化。确定继续吗？',
        confirmLabel: '重新生成',
        onConfirm: async () => {
          setBusy(true)
          try {
            const r = await callRemote(remoteRef.current, 'createChart', {
              request: { personId: selectedId, force: true },
            })
            if (!r.ok) return failOf(r, '重新生成失败')
            setConfirm(null)
            await loadChart(selectedId)
            setErr(null)
            return { ok: true }
          } catch (e) { return caught(e) }
          finally { setBusy(false) }
        },
      })

      const runCreateHoroscope = async (req) => {
        setBusy(true)
        try {
          const r = await callRemote(remoteRef.current, 'createHoroscope', { request: req })
          if (!r.ok) { const m = r.error?.message ?? '运限查询失败'; setErr(m); return { ok: false, error: m } }
          setHoroscopeModal(false)
          await refreshAll()
          setTab('horoscope')
          setHoroscopeDetailId(null)
          setHoroscopeDetail(null)
          setErr(null)
          return { ok: true }
        } catch (e) { const m = String(e?.message ?? e); setErr(m); return { ok: false, error: m } }
        finally { setBusy(false) }
      }

      const askDeleteHoroscope = (rec) => setConfirm({
        title: '删除运限记录',
        message: '确定删除这条运限查询记录吗？此操作不可撤销。',
        confirmLabel: '确认删除',
        onConfirm: async () => {
          setBusy(true)
          try {
            const r = await callRemote(remoteRef.current, 'deleteHoroscope', {
              request: { personId: selectedId, horoscopeId: rec.id ?? horoscopeDetailId },
            })
            if (!r.ok) return failOf(r, '删除运限记录失败')
            setConfirm(null)
            setHoroscopeDetailId(null)
            setHoroscopeDetail(null)
            await refreshAll()
            setErr(null)
            return { ok: true }
          } catch (e) { return caught(e) }
          finally { setBusy(false) }
        },
      })

      /* ---------------- 渲染辅助 ---------------- */

      const currentPerson = person || people.find((p) => String(p.id) === String(selectedId)) || { id: selectedId }
      const disabled = busy || loadingDetail

      const renderPersonTab = () => {
        const p = currentPerson
        return h('div', { key: 'tab-person' },
          loadingDetail ? h('div', { className: 'zw-loading' }, '正在读取人员档案…') : null,
          h('div', { className: 'zw-sec' },
            h('div', { className: 'zw-sec-h' }, '档案信息'),
            h('div', { className: 'zw-fields' },
              h(Field, { k: '姓名', v: p.name }),
              h(Field, { k: '性别', v: p.gender }),
              h(Field, { k: '历法', v: p.calendarType === 'lunar' ? '农历' : '阳历' }),
              h(Field, { k: '出生日期', v: p.birthDateDisplay || p.birthDate }),
              h(Field, { k: '对应阳历', v: p.solarDate || (p.calendarType === 'lunar' ? '' : p.birthDate) }),
              h(Field, { k: '闰月', v: p.calendarType === 'lunar' ? (p.isLeapMonth ? '是（闰月）' : '否') : '—' }),
              h(Field, { k: '出生时辰', v: timeLabel(p.birthTimeIndex) }),
              h(Field, { k: '真太阳时', v: p.useTrueSolarTime
                ? ('已启用 · ' + (p.regionName || '未选地区'))
                : '未启用' }),
              p.useTrueSolarTime && p.solar?.enabled
                ? h(Field, { k: '校正结果', v: (p.solar.trueSolar?.solarDate || '') + ' '
                  + (p.solar.trueSolar?.clock || '') + ' · ' + timeLabel(p.solar.trueSolar?.timeIndex)
                  + '（经度 ' + fmtMin(p.solar.correction?.longitudeMinutes)
                  + '，均时差 ' + fmtMin(p.solar.correction?.equationOfTimeMinutes) + '）' })
                : null,
              p.useTrueSolarTime && p.birthClock
                ? h(Field, { k: '填写时刻', v: p.birthClock })
                : null,
              h(Field, { k: '创建时间', v: fmtTime(p.createdAt) }),
              h(Field, { k: '更新时间', v: fmtTime(p.updatedAt) }),
              h(Field, { k: '档案星盘数', v: p.chartCount ?? charts.length }),
              h(Field, { k: '档案运限数', v: p.horoscopeCount ?? horoscopes.length }))),
          h('div', { className: 'zw-actions' },
            h('button', {
              className: 'zw-btn', disabled,
              onClick: () => setPersonModal({ mode: 'edit', person: p }),
            }, '编辑'),
            h('button', {
              className: 'zw-btn danger', disabled,
              onClick: () => askDeletePerson(p),
            }, '删除人员')),
          h('div', { className: 'zw-hint' },
            '时辰范围：早子时 00:00~01:00，晚子时 23:00~00:00；星盘与运限记录请切换到上方对应标签页查看。'))
      }

      /** 星盘信息 tab：主视觉是 4×4 命盘，原始 JSON 退居折叠区块。 */
      const renderChartTab = () => h('div', { key: 'tab-chart' },
        h('div', { className: 'zw-hint', key: 'chart-static-hint' },
          '星盘随档案生辰自动生成；修改生辰后会自动重算。'),
        loadingChart
          ? h('div', { className: 'zw-loading' }, '正在按档案生辰生成 / 读取星盘…')
          : chartDetail
            ? h('div', { key: 'chart-detail' },
              h(AstrolabeGrid, { chart: chartDetail }),
              h('div', { className: 'zw-chart-foot' },
                h(CopyJsonButton, {
                  title: '完整 astrolabe JSON（iztro）',
                  value: chartDetail.astrolabe,
                  label: '复制星盘 JSON',
                  compact: true,
                }),
                h('div', { className: 'zw-actions' },
                  h('span', { className: 'zw-hint' }, '星盘由生辰唯一确定，修改档案后自动更新。'),
                  h('button', {
                    className: 'zw-btn ghost sm', disabled: busy,
                    title: '按当前档案重新排盘（会覆盖原有星盘）',
                    onClick: () => askRegenerateChart(),
                  }, '重新生成'))))
            : h('div', { className: 'zw-empty' }, '暂无星盘数据，请稍后重试或切换人员。'))

      const renderHoroscopeTab = () => {
        /* 详情视图（替换左侧详情区内容） */
        if (horoscopeDetailId) {
          const rec = horoscopeDetail?.record || {}
          const horo = horoscopeDetail?.horoscope
          const fortune = horoscopeDetail?.fortune   // range 记录专属：完整 fortune 对象
          return h('div', { key: 'tab-horoscope-detail' },
            h('div', { className: 'zw-subbar' },
              h('button', {
                className: 'zw-btn sm',
                onClick: () => { setHoroscopeDetailId(null); setHoroscopeDetail(null) },
              }, '‹ 返回列表'),
              h('span', { className: 'zw-sp' }),
              h(AnalysisLauncher, {
                personId: selectedId,
                horoscopeId: horoscopeDetailId,
                remote,
                launchAnalysis: doLaunch,
                label: '✦ 发起对话分析',
              }),
              h('button', {
                className: 'zw-btn danger sm', disabled,
                onClick: () => askDeleteHoroscope(rec),
              }, '删除该记录')),
            loadingHoroscope
              ? h('div', { className: 'zw-loading' }, '正在读取运限详情…')
              : horoscopeDetail
                ? h('div', null,
                  h('div', { className: 'zw-sec' },
                    h('div', { className: 'zw-sec-h' }, '查询信息'),
                    h('div', { className: 'zw-fields' },
                      h(Field, { k: '类型', v: rec.kind === 'daily' ? '日运' : rec.kind === 'range' ? '未来 ' + (rec.years ?? 'N') + ' 年' : (rec.kind === 'manual' ? '手动查询' : '—') }),
                      h(Field, { k: '目标日期', v: rec.targetDate }),
                      h(Field, { k: '范围', v: rec.scopeLabel || rec.scope }),
                      h(Field, { k: '时辰', v: rec.timeIndexLabel || timeShort(rec.timeIndex) }),
                      h(Field, { k: '标签', v: rec.label }),
                      h(Field, { k: '查询时间', v: fmtTime(rec.createdAt) }),
                      h(Field, { k: '星盘 ID', v: rec.chartId }))),
                  rec.analysis && rec.analysis.content
                    ? h(AnalysisBlock, { key: 'analysis', analysis: rec.analysis })
                    : null,
                  fortune
                    ? h('div', { className: 'zw-sec', key: 'fortune-timeline' },
                      h('div', { className: 'zw-sec-h' }, '运势时间轴'),
                      h(FortuneTimeline, { fortune }))
                    : null,
                  h('div', { className: 'zw-sec' },
                    h('div', { className: 'zw-sec-h' }, '六层运限 · 干支与落宫'),
                    h(ScopeLayers, { horoscope: horo })),
                  h('div', { className: 'zw-sec' },
                    h('div', { className: 'zw-sec-h' }, '原始数据'),
                    h(CopyJsonButton, {
                      title: '完整 horoscope JSON（iztro）',
                      value: horo,
                      label: '复制运限 JSON',
                    })))
                : h('div', { className: 'zw-empty' }, '没有找到该运限记录，请返回列表重试。'))
        }

        /* 列表视图：快捷运势卡片区（最上方）+ 原有运限历史列表 */
        return h('div', { key: 'tab-horoscope-list' },
          h(FortuneQuick, {
            personId: selectedId,
            remote,
            busy,
            onError: (m) => setErr(m),
            onRecordCreated: refreshHoroscopes,
            clearKey: selectedId,
          }),
          h('div', { className: 'zw-subbar' },
            h('span', { className: 'zw-hint' }, '共 ' + horoscopes.length + ' 条运限查询历史'),
            h('span', { className: 'zw-sp' }),
            h('button', {
              className: 'zw-btn primary sm', disabled: busy,
              onClick: () => setHoroscopeModal(true),
            }, '新增运限查询')),
          horoscopes.length === 0
            ? h('div', { className: 'zw-empty' }, '还没有运限查询记录。点击「新增运限查询」开始。')
            : h('div', { className: 'zw-rows' },
              horoscopes.map((rec) => {
                const badge = kindBadge(rec)
                const isRange = rec?.kind === 'range'
                return h('div', {
                  key: String(rec.id),
                  className: 'zw-row',
                  title: isRange ? '点击查看运势时间轴详情' : '点击查看完整运限 JSON',
                  onClick: () => setHoroscopeDetailId(rec.id),
                },
                  h('div', { className: 'c1' }, fmtTime(rec.createdAt)),
                  h('div', { className: 'c2' },
                    badge ? h('span', { className: 'zw-kind ' + badge.cls }, badge.text) : null,
                    rec.targetDate || '—'),
                  h('div', { className: 'c3' }, rec.timeIndexLabel || timeShort(rec.timeIndex)),
                  h('div', { className: 'c4' },
                    isRange
                      ? (rec.scopeLabel || ('未来 ' + (rec.years ?? 'N') + ' 年'))
                      : (rec.label || rec.scope || '—')),
                  h('div', { className: 'c5' },
                    rec.analysisSummary
                      ? h('span', { className: 'zw-hasana', title: '已回填 AI 分析：' + rec.analysisSummary }, '✎ ')
                      : null,
                    recordSummary(rec) || '—'),
                  h('div', { className: 'c7' },
                    h(AnalysisLauncher, {
                      personId: selectedId,
                      horoscopeId: rec.id,
                      remote,
                      launchAnalysis: doLaunch,
                      compact: true,
                    })),
                  h('div', { className: 'c6' }, '›'))
              })))
      }

      const renderTab = () => {
        if (tab === 'chart') return renderChartTab()
        if (tab === 'horoscope') return renderHoroscopeTab()
        return renderPersonTab()
      }

      /* ---------------- 顶层渲染 ---------------- */

      return h('div', { className: 'zw' },
        /* 顶部工具条 */
        h('div', { className: 'zw-gbar' },
          h('span', { className: 'zw-brandwrap' },
            h('span', { className: 'zw-brand-badge', 'aria-hidden': true }, '☯'),
            h('span', { className: 'zw-brand' }, '紫微斗数工作台')),
          diag ? h('span', { className: 'zw-status' }, diag) : null,
          h('span', { className: 'zw-sp' })),

        /* 顶部错误条（可关闭） */
        err ? h('div', { className: 'zw-alert' },
          h('span', { className: 'zw-sp' }, err),
          h('button', { className: 'zw-x', title: '关闭', onClick: () => setErr(null) }, '×')) : null,
        /* 非致命警告条（可关闭），与错误条独立 */
        warn ? h('div', { className: 'zw-alert wn' },
          h('span', { className: 'zw-sp' }, warn),
          h('button', { className: 'zw-x', title: '关闭', onClick: () => setWarn(null) }, '×')) : null,

        /* 主体：左人员列表 / 右详情区（Tab） */
        h('div', { className: 'zw-body' },
          h('div', { className: 'zw-list' },
            h('div', { className: 'zw-list-hd' },
              '人员列表',
              h('span', { className: 'zw-badge' }, String(people.length)),
              h('span', { className: 'zw-sp' }),
              h('button', {
                className: 'zw-iconbtn', title: '新增人员', disabled: busy,
                onClick: () => setPersonModal({ mode: 'add' }),
              }, '+')),
            h('div', { className: 'zw-list-items' },
              loadingPeople
                ? h('div', { className: 'zw-loading' }, '正在读取人员列表…')
                : people.length === 0
                  ? h('div', { className: 'zw-empty' },
                    '暂无人员。点上方「+」建立第一份档案；',
                    '不记得出生时辰也没关系，新增时点「不确定时辰？AI 定盘」。')
                  : people.map((p) => h('div', {
                    key: String(p.id),
                    className: 'zw-person' + (String(p.id) === String(selectedId) ? ' on' : ''),
                    onClick: () => setSelectedId(p.id),
                  },
                    h('span', {
                      className: 'zw-avatar', style: avatarStyle(p.name || '?'),
                    }, String(p.name || '?').trim().charAt(0) || '?'),
                    h('div', { className: 'zw-person-main' },
                      h('div', { className: 'zw-person-top' },
                        h('span', { className: 'zw-person-name' }, p.name || '未命名'),
                        h('button', {
                          className: 'zw-person-del', title: '删除人员（二次确认）', disabled: busy,
                          onClick: (e) => { e.stopPropagation(); askDeletePerson(p) },
                        }, '×')),
                      h('div', { className: 'zw-person-meta' },
                        p.calendarType === 'lunar'
                          ? h('span', { className: 'zw-cal-tag' }, '农历')
                          : null,
                        (p.gender || '—') + ' · ' + (p.birthDateDisplay || p.birthDate || '—') + ' · ' + timeShort(p.birthTimeIndex)),
                      h('div', { className: 'zw-person-meta' },
                        h('span', { className: 'zw-badge' }, '盘 ' + (p.chartCount ?? 0)),
                        h('span', { className: 'zw-badge' }, '运限 ' + (p.horoscopeCount ?? 0)))))))),
          h('div', { className: 'zw-detail' },
            selectedId
              ? [
                h('div', { className: 'zw-tabs', key: 'tabs' },
                  TABS.map((t) => h('button', {
                    key: t.k,
                    className: 'zw-tab' + (tab === t.k ? ' on' : ''),
                    onClick: () => setTab(t.k),
                  }, t.label))),
                h('div', { className: 'zw-pane', key: 'pane' }, renderTab()),
              ]
              : h('div', { className: 'zw-empty' },
                '请从左侧人员列表选择一位人员，查看其档案、星盘与运限历史。'))),

        /* 弹窗层 */
        personModal
          ? h(PersonModal, {
            key: 'person-modal-' + personModal.mode + '-' + (personModal.person?.id ?? 'new'),
            mode: personModal.mode,
            person: personModal.person,
            busy,
            remote,
            launchAnalysis: doLaunch,
            onSubmit: runPersonSubmit,
            onClose: () => { if (!busy) setPersonModal(null) },
          })
          : null,
        horoscopeModal
          ? h(HoroscopeModal, {
            key: 'horoscope-modal', personId: selectedId,
            busy, onSubmit: runCreateHoroscope,
            onClose: () => { if (!busy) setHoroscopeModal(false) },
          })
          : null,
        confirm
          ? h(ConfirmModal, {
            key: 'confirm-modal',
            title: confirm.title,
            message: confirm.message,
            confirmLabel: confirm.confirmLabel,
            busy,
            onConfirm: confirm.onConfirm,
            onClose: () => { if (!busy) setConfirm(null) },
          })
          : null)
    }

    /* ================================================================
       7. 插件入口
       ================================================================ */

    return {
      inject: ['remote'],
      async apply(ctx) {
        ctx.effect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-dsh-ziwei-doushu', '1')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => { try { el.remove() } catch { /* ignore */ } }
        }, 'ziwei:style')

        await ctx.remote.$mount(CONTRIBUTION)

        const register = (scope) => {
          const api = scope.remote.ziwei
          // 运行时按需取 uiWorkspace（不写进 inject 声明，避免改变插件依赖就绪条件）。
          // 取不到时优雅降级，返回带 ok:false 的结果供 UI 显示内联错误。
          const getUiWorkspace = () => (typeof scope.get === 'function' ? scope.get('uiWorkspace') : null) || scope.uiWorkspace
          const launchAnalysis = async (prompt) => {
            const ws = getUiWorkspace()
            if (!ws || typeof ws.startSession !== 'function') {
              return { ok: false, error: '当前 DSH 版本不支持发起会话' }
            }
            try {
              await Promise.resolve(ws.startSession(undefined, {
                prompt,
                whenDraftExists: 'append',
              }))
              return { ok: true }
            } catch (e) {
              return { ok: false, error: String(e?.message ?? e) }
            }
          }
          scope.slots.inject('main', () => scope.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ remote: api, launchAnalysis }),
          }, Workbench))
          scope.slots.inject('sidebar.panellist', () => scope.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => '紫微斗数',
          }, PanelIcon))
        }

        const ui = ctx.inject(['slots', 'remote.ziwei'], register)
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          throw error
        }
      },
    }
  },
})
