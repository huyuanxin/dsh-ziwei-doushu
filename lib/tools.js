/**
 * 紫微斗数工作台 · Agent 工具
 *
 * 四个工具，按「读 / 分析 / 排盘 / 写」分离：
 *   ziwei_query     只读——查人员、星盘、运限历史与详情
 *   ziwei_analysis  只读——取某条运限记录的**人话摘要**用于解盘
 *   ziwei_save_analysis  写——把分析结果回填到该条运限记录（需 confirm=true）
 *   ziwei_time_candidates 只读——定盘：同一天 13 个时辰的候选盘
 *   ziwei_chart     排盘与运限计算（写历史）
 *   ziwei_people    人员增删改（写，需 confirm=true 才执行写操作）
 *
 * 与 UI 共用同一个 ZiweiWorkbench 服务，保证数据一致。
 */

import { TIME_OPTIONS, LANGUAGES, timeLabel } from './chart.js'
import { renderTimeCandidates } from './analysis.js'

/** 把属性映射编译成 JSON Schema。 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(spec ?? {})) {
    const { required: req, ...rest } = v ?? {}
    properties[k] = rest
    if (req === true) required.push(k)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** 纯文本渲染。 */
function text(t) { return [{ type: 'text', text: t }] }

/** 把返回值渲染成紧凑可读文本。 */
function render(kind, v) {
  if (!v || v.ok === false) {
    return text(`失败：${v?.error?.code ?? 'unknown'} — ${v?.error?.message ?? '未知错误'}`)
  }
  if (kind === 'people') {
    const ps = v.people ?? []
    if (!ps.length) return text('暂无人员档案。')
    return text(ps.map((p) =>
      `- ${p.name}（${p.gender}｜${p.birthDate} ${p.birthTimeShort}）id=${p.id}｜盘 ${p.chartCount}｜运限 ${p.horoscopeCount}`
    ).join('\n'))
  }
  if (kind === 'person') {
    const p = v.person
    const lines = [
      `${p.name}｜${p.gender}｜阳历 ${p.birthDate}｜${p.birthTimeLabel}`,
      `id=${p.id}｜星盘 ${p.chartCount} 张｜运限记录 ${p.horoscopeCount} 条`,
    ]
    for (const c of v.charts ?? []) {
      lines.push(`  · 盘 ${c.id}｜${c.label}｜${c.summary?.chineseDate ?? ''}｜${c.summary?.soul ?? ''}`)
    }
    return text(lines.join('\n'))
  }
  if (kind === 'charts') {
    const cs = v.charts ?? []
    if (!cs.length) return text('该人员还没有星盘，请先排盘。')
    return text(cs.map((c) =>
      `- ${c.id}｜${c.label}｜${c.summary?.chineseDate ?? ''}｜命主 ${c.summary?.soul ?? ''}｜${c.summary?.fiveElementsClass ?? ''}`
    ).join('\n'))
  }
  if (kind === 'chart') {
    const c = v.chart
    return text([
      `星盘 ${c.id}｜${c.label}`,
      `输入：${JSON.stringify(c.input)}`,
      `摘要：${JSON.stringify(c.summary)}`,
      `完整 astrolabe JSON（${JSON.stringify(c.astrolabe).length} 字符）见返回值对象。`,
    ].join('\n'))
  }
  if (kind === 'horoscopes') {
    const rs = v.records ?? []
    if (!rs.length) return text('暂无运限查询历史。')
    return text(rs.map((r) =>
      `- ${r.id}｜${r.createdAt}｜目标 ${r.targetDate} ${timeLabel(r.timeIndex)}｜${r.label}｜盘 ${r.chartId}`
    ).join('\n'))
  }
  if (kind === 'horoscope') {
    const r = v.record
    return text([
      `运限记录 ${r.id}｜${r.label}`,
      `目标：${r.targetDate} ${timeLabel(r.timeIndex)}｜盘 ${r.chartId}`,
      `大限：${r.summary?.decadal?.heavenlyStem ?? ''}${r.summary?.decadal?.earthlyBranch ?? ''}｜流年：${r.summary?.yearly?.heavenlyStem ?? ''}${r.summary?.yearly?.earthlyBranch ?? ''}`,
      `完整 horoscope JSON 与对应星盘 JSON 见返回值对象。`,
    ].join('\n'))
  }
  return text(JSON.stringify(v))
}

/**
 * 构造并注册工具。
 * @param {object} ctx Cordis 上下文（已含 tools）
 * @param {object} svc ZiweiWorkbench
 * @returns {Array<() => void>} 清理器
 */
export function buildZiweiTools(ctx, svc) {
  const tools = ctx.get('tools')
  if (!tools) return []
  const disposers = []

  /* ---------------- ziwei_query：只读 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_query',
    description: [
      '查询紫微斗数工作台：人员列表、人员详情、星盘列表、星盘完整 JSON、运限查询历史、运限详情。只读，不修改任何数据。',
      '星盘由生辰唯一决定，一人一盘：what=chart 会按需生成一次并持久化，之后一直复用，不需要先手动排盘。',
      'what=people 列出人员；person 查单人；charts 列出某人的盘；chart 取该人唯一的盘的完整 iztro JSON；',
      'horoscopes 列运限历史；horoscope 取一条运限的完整 JSON 与对应星盘；diagnostics 看配置与能力；',
      'convert 做阳历/农历（含闰月）换算，返回对照日期与展示文案；',
      'fortune 查看今天/明天/未来 N 年运势，返回起算日六层运限 + 逐年时间轴 + 大限列表，并写入一条运限历史记录；',
      '今天/明天按日期去重（重复查询复用已有记录），未来 N 年每次新建一条可点进去看详情的记录；',
      '需要分析某条运限记录时不要用本工具，改用 ziwei_analysis（返回已排版的人话摘要）；',
      'what=regions 列出真太阳时可用的地区（省/市 + 经纬度）；',
      'what=solar-preview 预览真太阳时换算（填写值 vs 校正值），需要 birthDate + birthTimeIndex + regionName。',
    ].join(' '),
    parameters: compileParameters({
      what: {
        type: 'string', required: true,
        enum: ['people', 'person', 'charts', 'chart', 'horoscopes', 'horoscope', 'diagnostics', 'convert', 'fortune', 'regions', 'solar-preview'],
        description: '要读什么',
      },
      personId: { type: 'string', description: '人员 id（除 people/diagnostics/convert 外必填）' },
      chartId: { type: 'string', description: '星盘 id（一人一盘，通常省略；horoscopes 时可选过滤）' },
      horoscopeId: { type: 'string', description: '运限记录 id（what=horoscope 时必填）' },
      calendarType: { type: 'string', enum: ['solar', 'lunar'], description: '历法（what=convert 时必填）' },
      birthDate: { type: 'string', description: '日期 YYYY-M-D（what=convert 时必填；lunar 时为农历日期）' },
      isLeapMonth: { type: 'boolean', description: '是否闰月（what=convert 且 calendarType=lunar 时可选）' },
      preset: { type: 'string', enum: ['today', 'tomorrow', 'nYears', 'custom'], description: '运势快捷预设（what=fortune，默认 today）' },
      years: { type: 'number', description: '未来年数 1~30（what=fortune，默认 10）' },
      targetDate: { type: 'string', description: '自定义起算日 YYYY-M-D（what=fortune 且 preset=custom 时必填）' },
      birthTimeIndex: { type: 'number', description: '出生时辰 0~12（what=solar-preview 必填）' },
      birthClock: { type: 'string', description: '精确出生时刻 HH:MM（what=solar-preview 可选）' },
      regionName: { type: 'string', description: '出生地区名（what=solar-preview 必填），如「北京市」' },
    }),
    output: {
      schema: { type: 'object' },
      render: (args, v) => render(args?.what, v),
    },
    async execute(args = {}) {
      switch (args.what) {
        case 'people': return svc.listPeople({})
        case 'person': return svc.getPerson({ personId: args.personId })
        case 'charts': return svc.listCharts({ personId: args.personId })
        case 'chart': return svc.getChart({ personId: args.personId, chartId: args.chartId })
        case 'horoscopes': return svc.listHoroscopes({ personId: args.personId, chartId: args.chartId })
        case 'horoscope': return svc.getHoroscope({ personId: args.personId, horoscopeId: args.horoscopeId })
        case 'diagnostics': return svc.diagnostics()
        case 'convert': return svc.convertDate({
          calendarType: args.calendarType, birthDate: args.birthDate, isLeapMonth: args.isLeapMonth,
        })
        case 'fortune': return svc.getFortune({
          personId: args.personId, preset: args.preset, targetDate: args.targetDate, years: args.years,
        })
        case 'regions': return svc.listRegions()
        case 'solar-preview': return svc.previewTrueSolarTime({
          birthDate: args.birthDate, calendarType: args.calendarType, isLeapMonth: args.isLeapMonth,
          birthTimeIndex: args.birthTimeIndex, birthClock: args.birthClock, regionName: args.regionName,
        })
        default: return { ok: false, error: { code: 'ziwei/invalid-input', message: '未知的 what: ' + args.what } }
      }
    },
  }))

  /* ---------------- ziwei_analysis：只读，解盘用的摘要 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_analysis',
    description: [
      '取某条运限记录的**完整解读资料**（纯文本，已排版），用于分析运势。只读。',
      '返回内容依次是：命主信息 → 本命十二宫（每宫一行：宫名干支、主星[亮度四化]、辅星、杂曜、大限岁数段）',
      '→ 本次记录的类型与范围 → 起算日六层运限（大限/小限/流年/流月/流日/流时，含落宫与四化）',
      '→ range 记录还会逐年列出农历年时间轴（干支/虚岁/流年落宫/所属大限/四化）。',
      '分析紫微斗数运势时应**先调用本工具**取资料，不要凭记忆推测星曜位置；',
      '需要解盘方法与星曜/格局释义时，再加载 ziwei-doushu 技能读取对应 reference 文件。',
      '参数省略时使用最近一次的记录（单人员场景可只传 personId）。',
    ].join(' '),
    parameters: compileParameters({
      personId: { type: 'string', required: true, description: '人员 id' },
      horoscopeId: { type: 'string', description: '运限记录 id（省略则取该人员最近一条记录）' },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, v) => {
        if (!v || v.ok === false) {
          return text(`失败：${v?.error?.code ?? 'unknown'} — ${v?.error?.message ?? '未知错误'}`)
        }
        return text(v.brief)
      },
    },
    async execute(args = {}) {
      const personId = args.personId
      if (!personId) {
        return { ok: false, error: { code: 'ziwei/invalid-input', message: '缺少 personId' } }
      }
      let horoscopeId = args.horoscopeId
      if (!horoscopeId) {
        // 省略记录 id 时取最近一条：新会话里用户只说「分析一下」也能工作。
        const listed = await svc.listHoroscopes({ personId })
        if (!listed.ok) return listed
        const first = (listed.records ?? [])[0]
        if (!first) {
          return { ok: false, error: { code: 'ziwei/not-found', message: '该人员还没有运限记录，请先在紫微斗数面板里查询一次运势' } }
        }
        horoscopeId = first.id
      }
      return svc.getAnalysisBrief({ personId, horoscopeId })
    },
  }))

  /* ---------------- ziwei_time_candidates：定盘候选 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_time_candidates',
    description: [
      '定盘：对同一天的全部 13 个时辰各排一张盘，返回候选盘面特征。只读。',
      '用于用户**不确定出生时辰**的场景：把候选时辰的命宫主星、身宫、兄弟/夫妻/迁移/福德四宫列出来，',
      '让用户对照自己的性格判断哪个最像。13 个时辰里有相当多会排出同一张盘（本工具会给出 distinct 张数）。',
      '返回的是紧凑文本，不是 JSON。拿到结果后应按候选逐条给出可自我验证的性格特征，并突出候选间的差异。',
      '**不要**用本工具创建人员；定盘后由用户确认，再调 ziwei_people(action=add) 建档。',
    ].join(' '),
    parameters: compileParameters({
      gender: { type: 'string', required: true, enum: ['男', '女'], description: '性别' },
      birthDate: { type: 'string', required: true, description: '生日 YYYY-M-D（calendarType=lunar 时为农历日期）' },
      calendarType: { type: 'string', enum: ['solar', 'lunar'], description: '历法，默认 solar' },
      isLeapMonth: { type: 'boolean', description: '农历闰月（calendarType=lunar 时有效）' },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, v) => {
        if (!v || v.ok === false) {
          return text(`失败：${v?.error?.code ?? 'unknown'} — ${v?.error?.message ?? '未知错误'}`)
        }
        return text(renderTimeCandidates(v))
      },
    },
    async execute(args = {}) {
      return svc.listTimeCandidates({
        gender: args.gender,
        birthDate: args.birthDate,
        calendarType: args.calendarType,
        isLeapMonth: args.isLeapMonth,
      })
    },
  }))

  /* ---------------- ziwei_save_analysis：回填分析结果 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_save_analysis',
    description: [
      '把 AI 分析结果回填到对应的运限记录里，之后在紫微斗数面板的历史列表与详情页都能看到。写操作，需要 confirm=true。',
      '**分析完成后应当调用本工具**：用户点了「✦ 分析」就是想留下结论，不存的话这次分析只剩对话里的一份。',
      'content 传完整分析正文（Markdown 全文）；summary 可选，不传会从正文自动截取前 100 字。',
      '同一记录重复回填会覆盖正文并累加 revisions 计数，不保留多版历史。',
      'personId / horoscopeId 用 ziwei_analysis 返回或对话里给出的那两个 id。',
    ].join(' '),
    parameters: compileParameters({
      personId: { type: 'string', required: true, description: '人员 id' },
      horoscopeId: { type: 'string', required: true, description: '运限记录 id' },
      content: { type: 'string', required: true, description: '完整分析正文（Markdown），最多 60000 字符' },
      summary: { type: 'string', description: '摘要（可选，≤200 字）；不传则自动截取正文前 100 字' },
      confirm: { type: 'boolean', description: '必须显式传 true 才执行写操作' },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, v) => {
        if (!v || v.ok === false) {
          return text(`失败：${v?.error?.code ?? 'unknown'} — ${v?.error?.message ?? '未知错误'}`)
        }
        const a = v.analysis ?? {}
        const parts = [`已回填分析到记录 ${v.horoscopeId}`]
        parts.push(`正文 ${a.length ?? 0} 字符｜摘要 ${a.summary ? a.summary.length : 0} 字`)
        if (a.replaced) parts.push(`覆盖了上一版（第 ${a.revisions} 次回填）`)
        if (a.summaryAuto) parts.push('摘要为自动截取')
        return text(parts.join('\n'))
      },
    },
    async execute(args = {}) {
      if (args.confirm !== true) {
        return {
          ok: true,
          dryRun: true,
          notice: '未传 confirm=true，未写入。将回填到记录 ' + (args.horoscopeId ?? '(未指定)') +
            '，正文 ' + String(args.content ?? '').length + ' 字符。',
        }
      }
      if (!args.personId || !args.horoscopeId) {
        return { ok: false, error: { code: 'ziwei/invalid-input', message: '缺少 personId 或 horoscopeId' } }
      }
      return svc.saveAnalysis({
        personId: args.personId,
        horoscopeId: args.horoscopeId,
        content: args.content,
        summary: args.summary,
      })
    },
  }))

  /* ---------------- ziwei_chart：排盘 / 运限计算 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_chart',
    description: [
      '星盘由生辰唯一决定，一人一盘：查看星盘请用 ziwei_query(what=chart)，它会自动按需生成一次并持久化，之后一直复用。',
      '本工具用于显式重新生成星盘或新增一次运限查询（调用 iztro）。写操作，需要 confirm=true。',
      'action=create-chart 显式重新生成（必须 force=true，可用 input 覆盖生辰/语言/闰月处理）；',
      'action=create-horoscope 查询某日运限并写入历史（无需 chartId，自动用该人员唯一的盘）；',
      'action=delete-chart / delete-horoscope 删除记录。',
      'confirm=false 时只做 dryRun 预览、不写盘。',
    ].join(' '),
    parameters: compileParameters({
      action: {
        type: 'string', required: true,
        enum: ['create-chart', 'create-horoscope', 'delete-chart', 'delete-horoscope'],
        description: '动作',
      },
      personId: { type: 'string', required: true, description: '人员 id' },
      chartId: { type: 'string', description: '星盘 id（可选；一人一盘，省略即自动使用唯一盘）' },
      horoscopeId: { type: 'string', description: '运限记录 id（delete-horoscope 必填）' },
      label: { type: 'string', description: '备注（可选）' },
      targetDate: { type: 'string', description: '运限目标日期 YYYY-M-D（create-horoscope 必填）' },
      timeIndex: { type: 'number', description: '目标时辰 0~12（create-horoscope，默认沿用盘的时辰）' },
      force: { type: 'boolean', description: 'create-chart 必须传 true，表示显式重新生成星盘' },
      input: {
        type: 'object',
        description: '生辰参数覆盖：{ solarDate, timeIndex, gender, fixLeap, language }（create-chart 可选）',
      },
      confirm: { type: 'boolean', description: '必须显式传 true 才执行写操作' },
    }),
    output: {
      schema: { type: 'object' },
      render: (args, v) => text(
        v?.ok === false
          ? `失败：${v.error?.code} — ${v.error?.message}`
          : `${args?.action} 成功：${JSON.stringify(v).slice(0, 1200)}`
      ),
    },
    async execute(args = {}) {
      if (args.confirm !== true) {
        return { ok: true, dryRun: true, notice: '未传 confirm=true，未执行写操作。预览：' + args.action }
      }
      switch (args.action) {
        case 'create-chart': return svc.createChart({
          personId: args.personId, label: args.label, input: args.input, force: args.force,
        })
        case 'create-horoscope': return svc.createHoroscope({
          personId: args.personId, chartId: args.chartId,
          targetDate: args.targetDate, timeIndex: args.timeIndex, label: args.label,
        })
        case 'delete-chart': return svc.deleteChart({ personId: args.personId, chartId: args.chartId })
        case 'delete-horoscope': return svc.deleteHoroscope({ personId: args.personId, horoscopeId: args.horoscopeId })
        default: return { ok: false, error: { code: 'ziwei/invalid-input', message: '未知的 action: ' + args.action } }
      }
    },
  }))

  /* ---------------- ziwei_people：人员增删改 ---------------- */
  disposers.push(tools.register({
    name: 'ziwei_people',
    description: [
      '管理人员档案：新增、修改、删除人员。写操作，需要 confirm=true。',
      '新增需填 name / gender(男|女) / birthDate(YYYY-M-D) / birthTimeIndex(0~12)；',
      '支持农历：calendarType=lunar 时 birthDate 是农历日期，可加 isLeapMonth=true 指定闰月（该年无此闰月会报错）。',
      '编辑生辰后会自动重算该人员唯一的星盘。',
      '真太阳时：useTrueSolarTime=true 时按 regionName 的经度与当天均时差把北京时间校正成当地真太阳时，',
      '并自动调整日期与时辰（经度偏差大时可能跨到前一天），排盘用校正后的值；',
      '填 birthClock(HH:MM) 可做分钟级校正，不填则按所选时辰的中点推定。',
      '0=早子时 1=丑时 2=寅时 3=卯时 4=辰时 5=巳时 6=午时 7=未时 8=申时 9=酉时 10=戌时 11=亥时 12=晚子时。',
      'confirm=false 时只做 dryRun 预览、不写盘。',
    ].join(' '),
    parameters: compileParameters({
      action: { type: 'string', required: true, enum: ['add', 'update', 'delete'], description: '动作' },
      personId: { type: 'string', description: '人员 id（update/delete 必填）' },
      name: { type: 'string', description: '姓名（add 必填）' },
      gender: { type: 'string', enum: ['男', '女'], description: '性别' },
      birthDate: { type: 'string', description: '生日 YYYY-M-D（add 必填；lunar 时为农历日期）' },
      birthTimeIndex: { type: 'number', description: '出生时辰 0~12（add 必填）' },
      calendarType: { type: 'string', enum: ['solar', 'lunar'], description: '历法，默认 solar' },
      isLeapMonth: { type: 'boolean', description: '农历闰月（calendarType=lunar 时有效）' },
      useTrueSolarTime: { type: 'boolean', description: '是否按真太阳时定时辰（默认 false）。为 true 时必须给 regionName' },
      regionName: { type: 'string', description: '出生地区名（真太阳时用），如「北京市」「乌鲁木齐市」；用 ziwei_query(what=regions) 查可用值' },
      birthClock: { type: 'string', description: '精确出生时刻 HH:MM（可选）。给了做分钟级校正，不给按时辰中点推定' },
      note: { type: 'string', description: '备注' },
      confirm: { type: 'boolean', description: '必须显式传 true 才执行写操作' },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, v) => text(
        v?.ok === false
          ? `失败：${v.error?.code} — ${v.error?.message}`
          : JSON.stringify(v)
      ),
    },
    async execute(args = {}) {
      if (args.confirm !== true) {
        return { ok: true, dryRun: true, notice: '未传 confirm=true，未执行写操作。预览：' + args.action }
      }
      switch (args.action) {
        case 'add': return svc.addPerson({
          name: args.name, gender: args.gender, birthDate: args.birthDate,
          birthTimeIndex: args.birthTimeIndex, note: args.note,
          calendarType: args.calendarType, isLeapMonth: args.isLeapMonth,
          useTrueSolarTime: args.useTrueSolarTime, regionName: args.regionName,
          birthClock: args.birthClock,
        })
        case 'update': return svc.updatePerson({
          personId: args.personId,
          patch: {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.gender !== undefined ? { gender: args.gender } : {}),
            ...(args.birthDate !== undefined ? { birthDate: args.birthDate } : {}),
            ...(args.birthTimeIndex !== undefined ? { birthTimeIndex: args.birthTimeIndex } : {}),
            ...(args.calendarType !== undefined ? { calendarType: args.calendarType } : {}),
            ...(args.isLeapMonth !== undefined ? { isLeapMonth: args.isLeapMonth } : {}),
            ...(args.useTrueSolarTime !== undefined ? { useTrueSolarTime: args.useTrueSolarTime } : {}),
            ...(args.regionName !== undefined ? { regionName: args.regionName } : {}),
            ...(args.birthClock !== undefined ? { birthClock: args.birthClock } : {}),
            ...(args.note !== undefined ? { note: args.note } : {}),
          },
        })
        case 'delete': return svc.deletePerson({ personId: args.personId })
        default: return { ok: false, error: { code: 'ziwei/invalid-input', message: '未知的 action: ' + args.action } }
      }
    },
  }))

  return disposers
}
