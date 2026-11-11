/**
 * AI 分析用的「紧凑文本」视图。
 *
 * 为什么要有这一层：
 *   直接把星盘/运限的完整 JSON 塞进对话，是最贵的传法——实测 30 年记录
 *   光数据就有 43KB（其中汉字只有 2102，其余全是 JSON 结构、英文键、数字），
 *   而且模型还要自己去 `palaces[i].majorStars[j].brightness` 里捞信息。
 *
 *   所以改成：对话里只放**一小段任务说明**，数据由 `ziwei_analysis` 工具
 *   在需要时现取，且返回的是**人话摘要**而不是 JSON。
 *
 *   这样三件事同时成立：
 *     · 提示词只有几百字，点一次不炸上下文；
 *     · 模型拿到的是已经排好版的信息，不用解析嵌套数组；
 *     · 数据永远与工作台一致（工具是实时读库，不会带过期快照）。
 */

/**
 * 把一张本命盘渲染成 12 行宫位摘要。
 *
 * 格式刻意压得很紧：`命宫 戊寅 主:天机[得] … 辅:地劫 杂:天寿 大限5-14`
 * 主星带亮度与四化（`[旺科]` = 旺 + 化科），空宫写明「空宫」提示借对宫。
 *
 * @param {object} astrolabe iztro 的 toJSON() 结果
 * @returns {string}
 */
/** 地支槽位顺序：iztro 的 `index` 就是这张表的下标（0=寅 … 11=丑）。 */
const BRANCH_SLOTS = ['寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥', '子', '丑']

/** 地支 → 本命宫名（用于说明某层命宫落在本命哪个宫位）。 */
function natalPalaceByBranch(astrolabe) {
  const map = new Map()
  for (const p of (astrolabe?.palaces ?? [])) {
    const raw = p.name ?? ''
    map.set(p.earthlyBranch, raw.endsWith('宫') ? raw : raw + '宫')
  }
  return map
}

export function renderPalaceLines(astrolabe) {
  const palaces = Array.isArray(astrolabe?.palaces) ? astrolabe.palaces : []
  if (!palaces.length) return '（星盘数据缺失）'

  // 按地支顺序展示（寅→丑），与命盘网格一致，方便对照 UI。
  const B = BRANCH_SLOTS
  const ordered = palaces.slice().sort((a, b) => B.indexOf(a.earthlyBranch) - B.indexOf(b.earthlyBranch))

  return ordered.map((p) => {
    // iztro 的 palace.name 不带「宫」字（`兄弟`/`命宫`），补上便于阅读。
    const raw = p.name ?? ''
    const name = raw.endsWith('宫') ? raw : raw + '宫'
    const gz = `${p.heavenlyStem ?? ''}${p.earthlyBranch ?? ''}`
    const parts = []

    const majors = (p.majorStars ?? []).map((s) => {
      const b = s.brightness ? `[${s.brightness}${s.mutagen ?? ''}]` : (s.mutagen ? `[${s.mutagen}]` : '')
      return `${s.name}${b}`
    })
    // 空宫没有主星，按斗数规则要借对宫看，这里直接标出来，省得模型自己推。
    parts.push(majors.length ? `主:${majors.join(' ')}` : '主:空宫(借对宫)')

    const minors = (p.minorStars ?? []).map((s) => `${s.name}${s.brightness ? `[${s.brightness}]` : ''}`)
    if (minors.length) parts.push(`辅:${minors.join(' ')}`)

    const adjs = (p.adjectiveStars ?? []).map((s) => s.name)
    if (adjs.length) parts.push(`杂:${adjs.join(' ')}`)

    const dc = p.decadal
    if (dc && Array.isArray(dc.range) && dc.range.length === 2) {
      parts.push(`大限${dc.range[0]}-${dc.range[1]}`)
    }
    if (p.isBodyPalace) parts.push('身宫')

    return `${name} ${gz}｜${parts.join('｜')}`
  }).join('\n')
}

/**
 * 一层的干支摘要，例如：
 *   `流年 丙午 · 命宫在午（本命官禄宫位）· 37 岁 · 四化 天同/天机/文昌/廉贞`
 *
 * ⚠️ `palaceNames[index]` 恒等于 `'命宫'`（这是 iztro 的不变量，表示该层
 * 命宫所在的槽位），所以显示它没有信息量。真正有用的是：
 *   · 这个槽位对应哪个**地支**；
 *   · 该地支上的**本命宫位**是哪一个（流年命宫落在本命什么位置）。
 */
function layerLine(label, layer, natalPalaces) {
  if (!layer) return `${label}：（无数据）`
  const gz = `${layer.heavenlyStem ?? ''}${layer.earthlyBranch ?? ''}`
  const idx = Number.isInteger(layer.index) ? layer.index : -1
  const branch = idx >= 0 ? (BRANCH_SLOTS[idx] ?? '') : ''
  const natal = branch ? (natalPalaces?.get(branch) ?? '') : ''
  const age = layer.age != null ? `${layer.age} 岁` : ''
  const mut = Array.isArray(layer.mutagen) && layer.mutagen.length ? `四化 ${layer.mutagen.join('/')}` : ''
  const where = branch
    ? `命宫在${branch}${natal ? `（本命${natal}位）` : ''}`
    : ''
  return [label, gz, where, age, mut].filter(Boolean).join(' · ')
}

/**
 * 六层运限摘要（大限/小限/流年/流月/流日/流时）。
 *
 * 关键不变量：每层 `palaceNames[index] === '命宫'`，所以 `index` 是**地支槽位**
 * 而不是「第几个大限」——这里直接用 `palaceNames[index]` 取落宫，不做二次推算。
 *
 * @param {object} horoscope iztro 的 horoscope().toJSON()
 * @param {object} [astrolabe] 本命盘，用于把落宫地支换算成本命宫名
 * @returns {string}
 */
export function renderScopeLayers(horoscope, astrolabe) {
  const h = horoscope ?? {}
  const natal = natalPalaceByBranch(astrolabe)
  return [
    layerLine('大限', h.decadal, natal),
    layerLine('小限', h.age, natal),
    layerLine('流年', h.yearly, natal),
    layerLine('流月', h.monthly, natal),
    layerLine('流日', h.daily, natal),
    layerLine('流时', h.hourly, natal),
  ].join('\n')
}

/**
 * 逐年时间轴（只有 `range` 记录有）。
 *
 * 一年一行：`2026 丙午 37岁 流年财帛宫 大限田宅(2026~2035) 四化 天同/天机/文昌/廉贞`
 *
 * @param {object} fortune buildFortune 的返回值
 * @returns {string}
 */
export function renderTimeline(fortune, astrolabe) {
  const list = Array.isArray(fortune?.timeline) ? fortune.timeline : []
  if (!list.length) return ''
  const natal = natalPalaceByBranch(astrolabe)
  return list.map((t) => {
    const gz = `${t.heavenlyStem ?? ''}${t.earthlyBranch ?? ''}`
    const idx = Number.isInteger(t.index) ? t.index : -1
    const branch = idx >= 0 ? (BRANCH_SLOTS[idx] ?? '') : ''
    const natalName = branch ? (natal.get(branch) ?? '') : ''
    const dec = t.decadal
    const decTxt = dec && Array.isArray(dec.yearRange) && dec.yearRange.length === 2
      ? `大限${dec.palaceName}宫(${dec.yearRange[0]}~${dec.yearRange[1]})`
      : ''
    const mut = Array.isArray(t.mutagen) && t.mutagen.length ? `四化 ${t.mutagen.join('/')}` : ''
    return [
      String(t.year),
      gz,
      t.age != null ? `${t.age}岁` : '',
      branch ? `流年命宫在${branch}${natalName ? `(本命${natalName})` : ''}` : '',
      decTxt,
      mut,
      t.isCurrentYear ? '← 当前' : '',
    ].filter(Boolean).join(' ')
  }).join('\n')
}

/**
 * 组装一条运限记录的完整解读摘要（`ziwei_analysis` 工具的正文）。
 *
 * @param {object} p
 * @param {object} p.person   人员视图
 * @param {object} p.chart    星盘（含 astrolabe 与 summary）
 * @param {object} p.record   运限记录
 * @param {object} [p.horoscope] 该记录的六层运限
 * @param {object} [p.fortune]   range 记录的时间轴
 * @returns {string}
 */
export function renderAnalysisBrief({ person, chart, record, horoscope, fortune }) {
  const L = []
  const p = person ?? {}
  const c = chart ?? {}
  const r = record ?? {}
  const s = c.summary ?? {}

  L.push('# 紫微斗数 · 运限记录')
  L.push('')
  L.push('## 命主')
  L.push(`- 姓名：${p.name ?? '未命名'}　性别：${p.gender ?? ''}`)
  L.push(`- 出生：阳历 ${p.solarDate || p.birthDate || ''}　时辰：${p.birthTimeLabel ?? ''}`)
  L.push(`- 农历：${p.birthDateDisplay ?? ''}　四柱：${s.chineseDate ?? ''}`)
  L.push(`- 五行局：${s.fiveElementsClass ?? ''}　命主：${s.soul ?? ''}　身主：${s.body ?? ''}`)
  L.push(`- 命宫地支：${s.earthyBranchOfSoulPalace ?? s.earthlyBranchOfSoulPalace ?? ''}　身宫：${s.earthlyBranchOfBodyPalace ?? ''}`)

  const astrolabe = c.astrolabe ?? null

  L.push('')
  L.push('## 本命十二宫')
  L.push('格式：`宫名 干支｜主:星曜[亮度四化]｜辅:｜杂:｜大限岁数段`')
  L.push('')
  L.push(renderPalaceLines(astrolabe))

  L.push('')
  L.push('## 本次查询的记录')
  const kindLabel = r.kind === 'range' ? '未来 N 年（range）' : r.kind === 'daily' ? '当天（daily）' : '手动查询（manual）'
  L.push(`- 类型：${kindLabel}`)
  const ti = r.timeIndexLabel ?? (Number.isInteger(r.timeIndex) ? `时辰索引 ${r.timeIndex}` : '')
  L.push(`- 目标日期：${r.targetDate ?? ''}${ti ? `　时辰：${ti}` : ''}`)
  if (r.scopeLabel) L.push(`- 覆盖范围：${r.scopeLabel}`)
  L.push(`- 记录 id：${r.id ?? ''}`)

  L.push('')
  L.push('## 起算日六层运限')
  L.push('格式：`层 干支 · 命宫所在地支（对应本命宫位）· 虚岁 · 四化`')
  L.push('说明：每层的 `palaceNames[index]` 恒为「命宫」（iztro 不变量），所以下面给的是'
    + '该层命宫落在**哪个地支**、以及那个地支在**本命盘**上是哪一宫——这才是解读要用的信息。')
  L.push('')
  L.push(renderScopeLayers(horoscope, astrolabe))

  const timeline = renderTimeline(fortune, astrolabe)
  if (timeline) {
    L.push('')
    L.push('## 逐年时间轴（农历年）')
    L.push('格式：`农历年 干支 虚岁 流年命宫所在地支(本命宫位) 所属大限 四化`')
    L.push('')
    L.push(timeline)
  }

  L.push('')
  L.push('---')
  L.push('需要解盘方法与星曜/格局释义时，加载 `ziwei-doushu` 技能；')
  L.push('其中 `reference/*.md` 按需读取（如只看命宫涉及的几颗主星，不必读整篇）。')

  return L.join('\n')
}

/**
 * 「点击 AI 分析」时放进新会话草稿的提示词。
 *
 * ⚠️ 这里**故意只有任务说明，不含任何数据**：
 * 数据由 `ziwei_analysis` 工具现取，避免把几十 KB 的 JSON 写进对话，
 * 也保证分析用的是库里的最新数据而不是点击那一刻的快照。
 *
 * @param {object} context buildAnalysisContext 组装的上下文
 * @returns {string}
 */
export function renderStarterPrompt(context) {
  const ctx = context ?? {}
  const person = ctx.person ?? {}
  const record = ctx.record ?? {}
  const chart = ctx.chart ?? {}

  const kindLabel = record.kind === 'range' ? '未来运势（逐年）' : record.kind === 'daily' ? '当天运势' : '指定日期运势'
  const when = record.scopeLabel || record.targetDate || ''

  const L = []
  L.push(`请分析 ${person.name || '该命主'} 的${kindLabel}记录${when ? `（${when}）` : ''}。`)
  L.push('')
  L.push('## 怎么做')
  L.push('')
  const pid = person.id ?? ''
  const hid = record.id ?? ''
  L.push('1. 先调用 `ziwei_analysis` 取这条记录的完整资料：')
  L.push(`   \`ziwei_analysis({ personId: "${pid}", horoscopeId: "${hid}" })\``)
  L.push('   它会返回命主信息、本命十二宫、起算日六层运限、以及逐年时间轴；**不要凭空推测星曜位置**。')
  L.push('2. 需要解盘方法与星曜/格局释义时，加载 `ziwei-doushu` 技能，按其中索引读取需要的 `reference` 文件。')
  L.push('3. 输出分析。')
  L.push('4. **分析写完后回填到记录**，这样结论会留在工作台里：')
  L.push('')
  L.push('   ```')
  L.push(`   ziwei_save_analysis({`)
  L.push(`     personId: "${pid}",`)
  L.push(`     horoscopeId: "${hid}",`)
  L.push(`     content: "<把上面完整的分析 Markdown 原文原样传进来>",`)
  L.push(`     summary: "<100 字以内的结论摘要，用于列表展示>",`)
  L.push(`     confirm: true`)
  L.push(`   })`)
  L.push('   ```')
  L.push('')
  L.push('   `content` 传完整正文（不要只传结论或删减），`summary` 用一两句话说清这次分析的核心判断。')
  L.push('')
  L.push('## 分析要求')
  L.push('')
  L.push('- 先按「解盘八步」定性（命宫主星 → 三方四正 → 福德宫 → 生年四化 → 宫干四化），再落到本次运限。')
  L.push('- 讲清**为什么**：每个结论要指出对应哪个宫、哪颗星、哪条四化。')
  L.push('- 区分「本命倾向」与「运限影响」，不要把流年问题说成天生如此。')
  L.push('- 吉凶只谈倾向与应对，不下绝对断语；不做医学诊断、投资建议、法律意见。')
  L.push('- 出生时辰若本身存疑，先提示需要定盘。')
  return L.join('\n')
}

/* ==================================================================
   定盘（不确定出生时辰时，逐时辰比对）
   ================================================================== */

/** 把一个候选时辰渲染成可读的一段。 */
function renderCandidate(c, i) {
  const L = []
  L.push(`### 候选 ${i + 1}：${c.timeLabel}（${c.timeRange}）｜timeIndex=${c.timeIndex}`)
  if (!c.ok) {
    L.push(`- 排盘失败：${c.error?.message ?? '未知错误'}`)
    return L.join('\n')
  }
  const soul = c.soulPalace
  L.push(`- 命宫：${soul.ganzhi}｜${soul.majors.length ? soul.majors.join(' ') : '空宫（借对宫）'}`)
  if (c.bodyPalace) {
    L.push(`- 身宫：${c.bodyPalace.name}（${c.bodyPalace.earthlyBranch}）`)
  }
  L.push(`- 五行局：${c.fiveElementsClass}｜命主：${c.soul}｜身主：${c.body}`)
  // 命宫已在上面单独列过，这里跳过以免重复。
  for (const p of c.keyPalaces) {
    if (p.palace === '命宫') continue
    L.push(`- ${p.palace}：${p.ganzhi}｜${p.majors.length ? p.majors.join(' ') : '空宫'}`)
  }
  return L.join('\n')
}

/**
 * 定盘资料：全部候选时辰的盘面特征（供 AI 逐条对照用户描述）。
 *
 * @param {object} result listTimeCandidates 的返回值
 * @returns {string}
 */
export function renderTimeCandidates(result) {
  const r = result ?? {}
  const L = []
  L.push('# 紫微斗数 · 定盘候选')
  L.push('')
  L.push('## 已知信息')
  L.push(`- 性别：${r.gender ?? ''}`)
  L.push(`- 生日：${r.calendarType === 'lunar' ? '农历 ' : '阳历 '}${r.birthDate ?? ''}`)
  if (r.display) L.push(`- 换算：${r.display}`)
  if (r.solarDate) L.push(`- 阳历：${r.solarDate}`)
  L.push(`- ${r.note ?? ''}`)
  L.push('')
  L.push('## 候选盘')
  L.push('')
  L.push('说明：命宫是「本质个性」，身宫是「后天行为倾向」，')
  L.push('兄弟宫看手足/母亲相处，夫妻宫看择偶与亲密关系，')
  L.push('迁移宫是「外人先看到的你」，福德宫是精神面与内在喜好。')
  L.push('')

  const list = Array.isArray(r.candidates) ? r.candidates : []
  list.forEach((c, i) => {
    L.push(renderCandidate(c, i))
    L.push('')
  })

  L.push('---')
  L.push('需要星曜释义时，加载 `ziwei-doushu` 技能读取 `reference/major-stars.md`、')
  L.push('`reference/palaces.md`（按需读单条，不必读整篇）。')
  return L.join('\n')
}

/**
 * 「不知道出生时辰」时放进新会话草稿的提示词。
 *
 * 与运限分析的提示词同一个思路：**只放任务，不放数据**。数据由
 * `ziwei_time_candidates` 工具现取。
 *
 * @param {object} params { gender, birthDate, calendarType, isLeapMonth, display }
 * @returns {string}
 */
export function renderTimePrompt(params) {
  const p = params ?? {}
  const rawName = String(p.name ?? '').trim()
  // 没填姓名时用「本人」占位：建档指令里必须有具体值，
  // 留「<姓名>」这种占位符会让 AI 原样写进档案。
  const name = rawName || '本人'
  const g = p.gender ?? ''
  const d = p.birthDate ?? ''
  const isLunar = p.calendarType === 'lunar'

  const L = []
  L.push(`我不确定自己的出生时辰。已知：${rawName ? rawName + '，' : ''}${g ? g + '，' : ''}${isLunar ? '农历 ' : '阳历 '}${d}${p.isLeapMonth ? '（闰月）' : ''}。`)
  L.push('')
  L.push('## 怎么做')
  L.push('')
  L.push('1. 调用 `ziwei_time_candidates` 取这一天生出的全部候选盘：')
  L.push(`   \`ziwei_time_candidates({ gender: "${g}", birthDate: "${d}", calendarType: "${p.calendarType ?? 'solar'}"${
    p.isLeapMonth ? ', isLeapMonth: true' : ''
  } })\``)
  L.push('   它会返回 13 个时辰各自的命宫主星、身宫、以及兄弟/夫妻/迁移/福德四宫。')
  L.push('2. 需要星曜与宫位释义时，加载 `ziwei-doushu` 技能，按需读单条（不要整篇读）。')
  L.push('3. 再输出对比。')
  L.push('')
  L.push('## 输出要求')
  L.push('')
  L.push('- **按候选逐个说**，每个时辰给出 2~4 条**可自我验证的性格特征**，')
  L.push('  必须能从盘面推出来（点明是哪个宫、哪颗星、什么亮度/四化造成的）。')
  L.push('- 特征要具体可对照，避免「性格较好」「比较内向」这类空话。')
  L.push('  例：「说话直，容易在无意中得罪人」比「表达能力强」有用得多。')
  L.push('- 突出**几个候选之间的差异**：哪些特征是这个时辰独有、别的时辰没有的。')
  L.push('  这是用户判断的关键。')
  L.push('- 如果两个时辰排出同一张盘（盘面完全相同），**合并成一条**并说明。')
  L.push('- 最后给一句「如果以上 A 最像你，就选 A」这样的明确引导，让用户好做决定。')
  L.push('- 不要替用户下结论，不要算命式绝对断言，不做医学/投资/法律建议。')
  L.push('- 输出末尾单独列一行 **推荐候选**，格式：`推荐时辰：X（理由一句话）`。')
  L.push('')
  L.push('## 用户确认后建档')
  L.push('')
  L.push(`用户选定时辰后（可能在后续消息里告诉你），调用下面的工具把${rawName ? '「' + name + '」' : '本人'}建档，`)
  L.push('这样工作台里就有一份带正确时辰的档案。')
  L.push(`姓名已经填好（${name}），**不要**再问用户叫什么，也不要用占位符：`)
  L.push('')
  L.push('```')
  L.push(`ziwei_people({`)
  L.push(`  action: "add",`)
  L.push(`  name: "${name}",`)
  L.push(`  gender: "${g}",`)
  L.push(`  birthDate: "${d}",`)
  L.push(`  birthTimeIndex: <选定的时辰序号 0~12>,`)
  L.push(`  calendarType: "${p.calendarType ?? 'solar'}"${p.isLeapMonth ? ',\n  isLeapMonth: true' : ''},`)
  L.push(`  confirm: true`)
  L.push(`})`)
  L.push('```')
  L.push('')
  L.push('`birthTimeIndex` 用候选标题里 **timeIndex=** 后面的数字（0=早子时 … 12=晚子时），')
  L.push('不要用「候选 N」的 N——候选编号只是展示顺序。')
  return L.join('\n')
}
