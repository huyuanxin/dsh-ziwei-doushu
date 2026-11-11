/**
 * 紫微斗数工作台 · 冒烟/回归测试
 *
 * 用临时目录（DSH_ZIWEI_DOUSHU_DIR）跑完整链路，绝不污染用户数据：
 *   新增人员 → 排盘 → 读盘 JSON → 运限查询 → 读运限详情 → 编辑/删除。
 * 同时校验 iztro 排盘结果的真实形状（12 宫、toJSON 可序列化）。
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ziwei-test-'))
process.env.DSH_ZIWEI_DOUSHU_DIR = tmp

const { ZiweiWorkbench } = await import('../lib/index.js')
const { REMOTE_METHODS } = await import('../lib/index.js')
const {
  normalizeDate, TIME_OPTIONS, LANGUAGES, sanitizeChartInput,
  generateAstrolabe, generateHoroscope, convertDate, validateLunarDate,
  buildFortune, todayString,
} = await import('../lib/chart.js')
// 真太阳时的纯函数单独一个模块（chart.js 不重导出，避免职责混淆）。
const {
  equationOfTimeMinutes, isLeapYear, daysInYear, dayOfYear,
  longitudeCorrectionMinutes, timeIndexFromMinutes,
  computeTrueSolarTime, resolveTrueSolarTime,
} = await import('../lib/solar-time.js')

const config = { dataDir: tmp, language: 'zh-CN', fixLeap: true }
const svc = new ZiweiWorkbench({ get: () => null, provide() {}, set() {}, inject() {} }, config)

let passed = 0
function ok(label, cond) {
  assert.ok(cond, label)
  passed++
  console.log('  ✓ ' + label)
}

try {
  /* ---------- 纯函数 ---------- */
  console.log('\n[1] 输入校验 / 时辰表 / 历法')
  ok('13 个时辰，index 0..12 连续', TIME_OPTIONS.length === 13 && TIME_OPTIONS.every((t, i) => t.index === i))
  ok('支持 6 种语言', LANGUAGES.length === 6)
  ok('YYYY-MM-DD 归一为 YYYY-M-D', normalizeDate('2000-08-16') === '2000-8-16')
  ok('斜线分隔可解析', normalizeDate('2000/8/16') === '2000-8-16')
  ok('拒绝乱码', normalizeDate('abc') === null)
  // 真实日历日：否则 `1990-2-30` 会被 Date 静默溢出成 `1990-3-2`，
  // 「不存在的生日」被存成另一天且排盘照算——错得很隐蔽。
  ok('拒绝 2 月 30 日', normalizeDate('1990-2-30') === null)
  ok('拒绝平年 2 月 29 日', normalizeDate('1990-2-29') === null)
  ok('接受闰年 2 月 29 日', normalizeDate('2024-2-29') === '2024-2-29')
  ok('拒绝 4 月 31 日', normalizeDate('1990-4-31') === null)
  ok('拒绝 13 月', normalizeDate('1990-13-1') === null)
  ok('拒绝时辰 13', sanitizeChartInput({ birthDate: '2000-8-16', timeIndex: 13, gender: '男' }).ok === false)
  ok('拒绝未知性别', sanitizeChartInput({ birthDate: '2000-8-16', timeIndex: 2, gender: 'X' }).ok === false)
  ok('拒绝未知语言', sanitizeChartInput({ birthDate: '2000-8-16', timeIndex: 2, gender: '男', language: 'xx' }).ok === false)
  ok('阳历 2 月 30 日被拒', sanitizeChartInput({ calendarType: 'solar', birthDate: '2000-2-30', timeIndex: 2, gender: '男' }).ok === false)
  // 农历 / 闰月
  ok('农历 2000-7-17 合法', validateLunarDate('2000-7-17', false).ok === true)
  ok('农历 2023 闰二月合法', validateLunarDate('2023-2-15', true).ok === true)
  ok('该年无此闰月被拒', validateLunarDate('2023-3-15', true).ok === false)
  ok('农历该月只有 29 天被拒', validateLunarDate('2023-2-30', true).ok === false)
  const cv = convertDate({ calendarType: 'lunar', birthDate: '2000-7-17', isLeapMonth: false })
  ok('农历换算出阳历', cv.ok === true && cv.solarDate === '2000-8-16')
  ok('换算带展示文案', typeof cv.display === 'string' && cv.display.includes('农历'))
  const cv2 = convertDate({ calendarType: 'solar', birthDate: '2000-8-16' })
  ok('阳历换算出农历', cv2.ok === true && cv2.lunarText.includes('七月十七'))
  const leapConv = convertDate({ calendarType: 'lunar', birthDate: '2023-2-15', isLeapMonth: true })
  ok('闰二月换算到 2023-4-5', leapConv.solarDate === '2023-4-5')
  ok('闰月文案不重复「闰闰」', !String(leapConv.display).includes('闰闰'))

  /* ---------- 排盘核心 ---------- */
  console.log('\n[2] iztro 排盘核心（含农历）')
  const solarInput = sanitizeChartInput({ calendarType: 'solar', birthDate: '2000-8-16', timeIndex: 2, gender: '男' }, config)
  ok('阳历输入净化成功', solarInput.ok === true && solarInput.input.calendarType === 'solar')
  const lunarInput = sanitizeChartInput({ calendarType: 'lunar', birthDate: '2000-7-17', timeIndex: 2, gender: '男' }, config)
  ok('农历输入净化成功', lunarInput.ok === true && lunarInput.input.calendarType === 'lunar')
  const g = generateAstrolabe(solarInput.input)
  ok('排盘成功', g.ok === true)
  ok('12 宫', g.astrolabe.palaces.length === 12)
  ok('含命主/身主/五行局', !!g.summary.soul && !!g.summary.body && !!g.summary.fiveElementsClass)
  ok('中文输出为简体', g.astrolabe.time === '寅时' && g.astrolabe.zodiac === '龙')
  ok('toJSON 可再序列化', JSON.stringify(JSON.parse(JSON.stringify(g.astrolabe))).length > 1000)
  const gl = generateAstrolabe(lunarInput.input)
  ok('农历排盘成功', gl.ok === true)
  ok('农历与等价阳历得到同一张盘', JSON.stringify(gl.astrolabe) === JSON.stringify(g.astrolabe))
  const leapInput = sanitizeChartInput({ calendarType: 'lunar', birthDate: '2023-2-15', isLeapMonth: true, timeIndex: 2, gender: '女' }, config)
  const gleap = generateAstrolabe(leapInput.input)
  ok('闰二月排盘成功且落到正确阳历', gleap.ok === true && gleap.astrolabe.solarDate === '2023-4-5')
  const h = generateHoroscope(solarInput.input, '2026-3-1', 6)
  ok('运限计算成功', h.ok === true)
  ok('大限/小限/流年/流月/流日/流时齐全',
    !!(h.horoscope.decadal && h.horoscope.age && h.horoscope.yearly && h.horoscope.monthly && h.horoscope.daily && h.horoscope.hourly))
  ok('运限摘要有干支', !!(h.summary.decadal.heavenlyStem && h.summary.yearly.earthlyBranch))
  ok('农历盘的运限也能算', generateHoroscope(lunarInput.input, '2026-3-1', 6).ok === true)

  /* ---------- 未来运势快捷查看 ---------- */
  console.log('\n[2b] 未来运势（decadalList + 逐年 horoscope）')
  const ft = buildFortune(solarInput.input, { preset: 'today', years: 10 })
  ok('today 预设成功', ft.ok === true)
  ok('baseDate 是今天', ft.fortune.baseDate === todayString())
  ok('时间轴 = years+1 项', ft.fortune.timeline.length === 11)
  ok('首项是当年', ft.fortune.timeline[0].isCurrentYear === true)
  ok('六层运限快照齐全', !!(ft.fortune.current.decadal && ft.fortune.current.age
    && ft.fortune.current.yearly && ft.fortune.current.monthly
    && ft.fortune.current.daily && ft.fortune.current.hourly))
  ok('大限列表 12 项带 yearRange', ft.fortune.decadals.length === 12
    && ft.fortune.decadals.every((d) => Array.isArray(d.yearRange) && d.yearRange.length === 2))
  ok('每年有干支/宫位/四化/大限/摘要', ft.fortune.timeline.every((t) =>
    t.heavenlyStem && t.earthlyBranch && t.palaceName
    && Array.isArray(t.mutagen) && t.decadal && t.summary))
  ok('大限按 yearRange 匹配（跨 2032 会换限）',
    ft.fortune.timeline[0].decadal.index !== ft.fortune.timeline[ft.fortune.timeline.length - 1].decadal.index)
  ok('scopeLabel 含年份范围', ft.fortune.scopeLabel.includes(String(new Date().getFullYear())))
  const ftT = buildFortune(solarInput.input, { preset: 'tomorrow', years: 3 })
  ok('tomorrow = 今天+1 天', ftT.ok === true && ftT.fortune.baseDate > todayString())
  ok('tomorrow 时间轴 4 项', ftT.fortune.timeline.length === 4)
  const ftN = buildFortune(solarInput.input, { preset: 'nYears', years: 5 })
  ok('nYears 预设生效', ftN.ok === true && ftN.fortune.years === 5 && ftN.fortune.timeline.length === 6)
  const ftC = buildFortune(solarInput.input, { preset: 'custom', targetDate: '2030-6-1', years: 2 })
  ok('自定义起算日生效', ftC.ok === true && ftC.fortune.baseDate === '2030-6-1')
  ok('years 被夹到 1~30', buildFortune(solarInput.input, { preset: 'nYears', years: 99 }).fortune.years === 30)
  ok('不存在的阳历日期被拒', buildFortune(solarInput.input, { preset: 'custom', targetDate: '2030-2-29' }).ok === false)

  /* 按年取数必须走官方 yearlyList()：农历年连续、不跳年、干支正确 */
  const ftLeapStart = buildFortune(solarInput.input, { preset: 'custom', targetDate: '2028-2-29', years: 2 })
  ok('2-29 起算也能算', ftLeapStart.ok === true && ftLeapStart.fortune.timeline.length === 3)
  // 回归：起算日落在农历新年前（阳历 1~2 月中）时，旧实现用"阳历周年日"会漏掉一整年。
  const ftBeforeNY = buildFortune(solarInput.input, { preset: 'custom', targetDate: '2026-2-14', years: 4 })
  ok('农历新年前起算不跳年', ftBeforeNY.ok === true
    && ftBeforeNY.fortune.timeline.map((t) => t.year).join(',') === '2025,2026,2027,2028,2029')
  ok('起算日的农历年作为起点', ftBeforeNY.fortune.baseLunarYear === 2025)
  ok('逐年干支与官方一致（2026 丙午）',
    ftBeforeNY.fortune.timeline.find((t) => t.year === 2026)?.heavenlyStem === '丙')
  ok('年份连续递增无缺口', ftBeforeNY.fortune.timeline.every((t, i, arr) => i === 0 || t.year === arr[i - 1].year + 1))
  ok('scopeLabel 用农历年口径', ftBeforeNY.fortune.scopeLabel.includes('农历'))
  // 官方代表日 = 农历六月初一换算出的阳历日
  ok('代表日取农历六月初一', (() => {
    const t = ftBeforeNY.fortune.timeline.find((x) => x.year === 2026)
    return t && t.date === '2026-7-14'
  })())
  ok('农历盘也能看运势', buildFortune(lunarInput.input, { preset: 'today', years: 2 }).ok === true)

  /* ---------- 服务链路 ---------- */
  console.log('\n[3] 服务完整链路')
  const add = await svc.addPerson({ name: '张三', gender: '男', birthDate: '2000-8-16', birthTimeIndex: 2 })
  ok('新增人员', add.ok === true && !!add.person.id)
  ok('时辰显示名正确', add.person.birthTimeLabel.includes('寅时'))
  const personId = add.person.id

  const badAdd = await svc.addPerson({ name: '', gender: '男', birthDate: '2000-8-16', birthTimeIndex: 2 })
  ok('空姓名被拒', badAdd.ok === false && badAdd.error.code === 'ziwei/invalid-name')

  // 农历人员（含闰月）与换算 Remote 方法
  const lunarAdd = await svc.addPerson({
    name: '农历测试', gender: '女', calendarType: 'lunar',
    birthDate: '2023-2-15', isLeapMonth: true, birthTimeIndex: 6,
  })
  ok('农历闰月人员新增成功', lunarAdd.ok === true)
  ok('档案带历法与换算字段', lunarAdd.person.calendarType === 'lunar'
    && lunarAdd.person.isLeapMonth === true
    && lunarAdd.person.solarDate === '2023-4-5'
    && lunarAdd.person.birthDateDisplay.includes('农历'))
  const lunarChart = await svc.getChart({ personId: lunarAdd.person.id })
  ok('农历人员排盘走 lunar 入口', lunarChart.ok === true
    && lunarChart.chart.input.calendarType === 'lunar'
    && lunarChart.chart.input.isLeapMonth === true
    && lunarChart.chart.astrolabe.solarDate === '2023-4-5')
  const convRemote = svc.convertDate({ calendarType: 'solar', birthDate: '2000-8-16' })
  ok('convertDate Remote 可用', convRemote.ok === true && convRemote.lunarText.includes('七月十七'))
  await svc.deletePerson({ personId: lunarAdd.person.id })

  const list = await svc.listPeople({})
  ok('列表返回 1 人', list.ok === true && list.people.length === 1)

  const detail = await svc.getPerson({ personId })
  ok('详情可读', detail.ok === true && detail.person.name === '张三')

  // 一人一盘：首次 getChart 按需生成一次（generated=true），之后永远复用。
  const chart = await svc.getChart({ personId })
  ok('首次查看星盘自动生成', chart.ok === true && chart.generated === true)
  ok('星盘 JSON 完整（12 宫）', chart.chart.astrolabe.palaces.length === 12)
  ok('星盘带 iztro 引擎标记', chart.chart.engine.library === 'iztro')
  ok('返回摘要含四柱', !!chart.chart.summary.chineseDate)
  const chartId = chart.chart.id
  const firstCreatedAt = chart.chart.createdAt

  const again = await svc.getChart({ personId })
  ok('再次查看不重复生成', again.ok === true && again.generated === false)
  ok('复用同一张盘（id/时间不变）', again.chart.id === chartId && again.chart.createdAt === firstCreatedAt)

  const charts = await svc.listCharts({ personId })
  ok('列表恰好 1 张盘', charts.ok === true && charts.charts.length === 1)
  ok('列表不返回完整 astrolabe（避免过重）', charts.charts.every((c) => c.astrolabe === undefined))
  ok('listCharts 也复用不重排', charts.generated === false)

  // 显式重新生成：必须 force=true；覆盖 input 生效；仍只留一张盘。
  const noForce = await svc.createChart({ personId })
  ok('未传 force 拒绝重排', noForce.ok === false && noForce.error.code === 'ziwei/force-required')

  const c2 = await svc.createChart({ personId, force: true, label: '英文盘', input: { language: 'en-US', timeIndex: 6 } })
  ok('force 重新生成成功', c2.ok === true && c2.chart.input.language === 'en-US')
  ok('覆盖时辰生效（英文输出非中文）', c2.chart.input.timeIndex === 6 && !/[\u4e00-\u9fa5]/.test(c2.chart.summary.time))
  ok('重新生成后仍只有 1 张盘', (await svc.listCharts({ personId })).charts.length === 1)
  const chartId2 = c2.chartId

  // 运限查询不传 chartId：自动用唯一盘（且生成对应的 horoscope 与 astrolabe）。
  const hr = await svc.createHoroscope({ personId, targetDate: '2026-3-1', timeIndex: 6, label: '2026 流年' })
  ok('运限查询成功', hr.ok === true && !!hr.record.id)
  const horoscopeId = hr.record.id

  const hl = await svc.listHoroscopes({ personId })
  ok('历史列表 1 条', hl.ok === true && hl.records.length === 1)
  ok('历史含时辰显示名', hl.records[0].timeIndexLabel.includes('午时'))

  const hd = await svc.getHoroscope({ personId, horoscopeId })
  ok('运限详情含完整 JSON', hd.ok === true && !!hd.horoscope.yearly && !!hd.astrolabe)
  ok('详情带对应星盘摘要', hd.chart.id === chartId2)

  ok('运限记录指向唯一盘', hr.record.chartId === chartId2)

  const byChart = await svc.listHoroscopes({ personId, chartId: chartId2 })
  ok('按盘过滤历史', byChart.ok === true && byChart.records.length === 1)

  /* ---------- 编辑 / 删除 ---------- */
  console.log('\n[4] 编辑与删除')
  const upd = await svc.updatePerson({ personId, patch: { name: '张三丰', note: '改过名' } })
  ok('编辑姓名', upd.ok === true && upd.person.name === '张三丰')
  ok('未传字段保持不变', upd.person.birthDate === '2000-8-16' && upd.person.gender === '男')
  ok('计数同步（一人一盘）', upd.person.chartCount === 1 && upd.person.horoscopeCount === 1)

  const badUpd = await svc.updatePerson({ personId, patch: { birthTimeIndex: 99 } })
  ok('非法时辰被拒', badUpd.ok === false)

  // 需求：编辑生辰后旧星盘自动重算
  const beforeEdit = await svc.getChart({ personId })
  const oldChartId = beforeEdit.chart.id
  const oldChineseDate = beforeEdit.chart.summary.chineseDate
  const editBirth = await svc.updatePerson({ personId, patch: { birthDate: '1990-5-5', birthTimeIndex: 9 } })
  ok('编辑生辰返回 chartRegenerated', editBirth.ok === true && editBirth.chartRegenerated === true)
  const afterEdit = await svc.getChart({ personId })
  ok('星盘已自动重算（新 id / 新四柱）', afterEdit.chart.id !== oldChartId
    && afterEdit.chart.summary.chineseDate !== oldChineseDate)
  ok('重算后仍只有一张盘', (await svc.listCharts({ personId })).charts.length === 1)
  const editNameOnly = await svc.updatePerson({ personId, patch: { name: '只改名' } })
  ok('只改姓名不重算星盘', editNameOnly.chartRegenerated === false)

  const delH = await svc.deleteHoroscope({ personId, horoscopeId })
  ok('删除运限记录', delH.ok === true)
  ok('删除后历史为空', (await svc.listHoroscopes({ personId })).records.length === 0)

  // 删除时省略 chartId：自动删唯一盘。删完再 getChart 会重新生成一次（按需）。
  const currentChartId = (await svc.listCharts({ personId })).charts[0].id
  const delC = await svc.deleteChart({ personId })
  ok('删除星盘（省略 chartId）', delC.ok === true && delC.chartId === currentChartId)
  ok('删除后运限记录一并清除', (await svc.listHoroscopes({ personId })).records.length === 0)
  const regenerated = await svc.getChart({ personId })
  ok('删盘后再次查看会按需重生成', regenerated.ok === true && regenerated.generated === true)

  /* ---------- 未来运势快捷查看（服务层）：落库 + 去重 + range 详情 ---------- */
  console.log('\n[4b] getFortune 服务层（写入历史 / 按日期去重 / 未来 N 年详情）')
  const histBefore = (await svc.listHoroscopes({ personId })).records.length
  const fortune = await svc.getFortune({ personId, preset: 'today', years: 10 })
  ok('getFortune Remote 可用', fortune.ok === true && !!fortune.fortune.timeline.length)
  ok('getFortune 带 personId/chartId', fortune.fortune.personId === personId && !!fortune.fortune.chartId)
  ok('getFortune 时间轴 11 项', fortune.fortune.timeline.length === 11)
  ok('getFortune 写入一条历史', (await svc.listHoroscopes({ personId })).records.length === histBefore + 1)
  ok('today 记录 kind=daily', fortune.record.kind === 'daily' && fortune.deduplicated === false)
  ok('getFortune 不重复生成星盘', fortune.fortune.chartId === regenerated.chart.id)

  // 今天重复点：按 (personId, kind=daily, targetDate) 唯一，复用旧记录
  const fToday2 = await svc.getFortune({ personId, preset: 'today' })
  ok('今天重复查询去重', fToday2.ok === true && fToday2.deduplicated === true
    && fToday2.record.id === fortune.record.id)
  ok('去重后历史条数不变', (await svc.listHoroscopes({ personId })).records.length === histBefore + 1)

  // 明天是另一个日期，应新建一条 daily
  const fTomorrow = await svc.getFortune({ personId, preset: 'tomorrow', years: 3 })
  ok('tomorrow 新建另一条 daily', fTomorrow.ok === true && fTomorrow.deduplicated === false
    && fTomorrow.record.kind === 'daily' && fTomorrow.record.targetDate !== fortune.record.targetDate)
  ok('明天时间轴 4 项', fTomorrow.fortune.timeline.length === 4)
  const fTomorrow2 = await svc.getFortune({ personId, preset: 'tomorrow' })
  ok('明天重复查询也去重', fTomorrow2.deduplicated === true && fTomorrow2.record.id === fTomorrow.record.id)

  // 未来 N 年：一条 range 记录，点进去能看详情（fortune 时间轴）
  const fYears = await svc.getFortune({ personId, preset: 'nYears', years: 5 })
  ok('nYears 新建 range 记录', fYears.ok === true && fYears.record.kind === 'range'
    && fYears.record.years === 5 && fYears.deduplicated === false)
  ok('range 记录带 scopeLabel', !!fYears.record.scopeLabel && fYears.record.scopeLabel.includes('5 年'))
  const detailRange = await svc.getHoroscope({ personId, horoscopeId: fYears.record.id })
  ok('range 详情带完整 fortune', detailRange.ok === true && detailRange.fortune
    && detailRange.fortune.timeline.length === 6)
  ok('range 详情时间轴与即时结果一致', detailRange.fortune.scopeLabel === fYears.fortune.scopeLabel)
  const fYears2 = await svc.getFortune({ personId, preset: 'nYears', years: 5 })
  ok('range 每次新建（不去重）', fYears2.deduplicated === false && fYears2.record.id !== fYears.record.id)

  // 列表带类型字段
  const hist = await svc.listHoroscopes({ personId })
  ok('历史列表带 kind/years/scopeLabel', hist.records.every((r) => r.kind)
    && hist.records.some((r) => r.kind === 'range' && r.years === 5 && r.scopeLabel))
  ok('getFortune 对不存在的人报 not-found',
    (await svc.getFortune({ personId: 'nope', preset: 'today' })).error.code === 'ziwei/not-found')

  /* ---------- AI 分析：对话里只放任务，数据靠工具现取 ---------- */
  console.log('\n[4c] buildAnalysisContext（轻提示词） + getAnalysisBrief（工具资料）')
  const ctxDaily = await svc.buildAnalysisContext({ personId, horoscopeId: fortune.record.id })
  ok('daily 记录上下文可用', ctxDaily.ok === true && !!ctxDaily.context)
  ok('上下文含人员标识与姓名', !!ctxDaily.context.person.id && !!ctxDaily.context.person.name)
  ok('上下文含记录元信息 kind', ctxDaily.context.record.kind === 'daily')
  ok('上下文不再内联星盘 JSON', ctxDaily.context.chart?.astrolabe === undefined)
  ok('上下文不再内联运限数据', ctxDaily.context.data === undefined)
  ok('上下文不再有 promptTemplate 占位', ctxDaily.context.promptTemplate === undefined)
  // 提示词必须短：对话里放任务，不放数据。
  ok('起始文本足够短（< 2000 字符）', ctxDaily.context.starterPrompt.length < 2000)
  ok('起始文本不含 JSON 代码块', !ctxDaily.context.starterPrompt.includes('```json'))
  ok('起始文本不含 astrolabe 字样', !ctxDaily.context.starterPrompt.includes('astrolabe'))
  ok('起始文本指向 ziwei_analysis 工具', ctxDaily.context.starterPrompt.includes('ziwei_analysis'))
  ok('起始文本带上两个 id', ctxDaily.context.starterPrompt.includes(personId)
    && ctxDaily.context.starterPrompt.includes(fortune.record.id))
  ok('起始文本提示加载 ziwei-doushu 技能', ctxDaily.context.starterPrompt.includes('ziwei-doushu'))
  // 提示词是**任务说明**，不能预先给出结论性判断。
  // （「不下绝对断语」是禁令本身，属于合规要求，不算违规内容。）
  ok('起始文本不预先下结论', !/大吉|大凶|必发财|必有灾|一定|注定/.test(ctxDaily.context.starterPrompt))
  ok('起始文本含边界约束', ctxDaily.context.starterPrompt.includes('不做医学诊断'))
  ok('起始文本要求回填分析', ctxDaily.context.starterPrompt.includes('ziwei_save_analysis'))
  ok('起始文本回填指令带 confirm', ctxDaily.context.starterPrompt.includes('confirm: true'))
  ok('起始文本回填指令带两个 id', ctxDaily.context.starterPrompt.includes('horoscopeId: "'))

  const ctxRange = await svc.buildAnalysisContext({ personId, horoscopeId: fYears.record.id })
  ok('range 记录元信息带 years/scopeLabel', ctxRange.context.record.years === 5
    && !!ctxRange.context.record.scopeLabel)
  ok('range 提示词同样不含时间轴数据', !ctxRange.context.starterPrompt.includes('timeline'))
  ok('上下文不写入历史（纯读）', (await svc.listHoroscopes({ personId })).records.length
    === hist.records.length)
  ok('不存在的记录报 not-found',
    (await svc.buildAnalysisContext({ personId, horoscopeId: 'nope' })).error.code === 'ziwei/not-found')

  /* ---------- getAnalysisBrief：人话摘要，不是 JSON ---------- */
  console.log('\n[4d] getAnalysisBrief（工具用的紧凑文本）')
  const briefDaily = await svc.getAnalysisBrief({ personId, horoscopeId: fortune.record.id })
  ok('daily 摘要可用', briefDaily.ok === true && typeof briefDaily.brief === 'string')
  ok('摘要含命主段', briefDaily.brief.includes('## 命主') && briefDaily.brief.includes('五行局'))
  ok('摘要含本命十二宫', briefDaily.brief.includes('## 本命十二宫'))
  // 十二宫必须齐全：每宫一行，行首是宫名。
  for (const name of ['命宫', '兄弟宫', '夫妻宫', '子女宫', '财帛宫', '疾厄宫',
    '迁移宫', '仆役宫', '官禄宫', '田宅宫', '福德宫', '父母宫']) {
    ok(`摘要含 ${name}`, new RegExp('^' + name + ' ', 'm').test(briefDaily.brief))
  }
  ok('宫行含主星与亮度标记', /主:\S+\[/.test(briefDaily.brief))
  ok('摘要含六层运限', briefDaily.brief.includes('## 起算日六层运限'))
  // 落宫必须换算成地支 + 本命宫位，不能只重复「命宫」（那是 iztro 的不变量，无信息量）。
  ok('六层落宫显示地支', /命宫在[子丑寅卯辰巳午未申酉戌亥]/.test(briefDaily.brief))
  ok('六层落宫标注本命宫位', /命宫在[子丑寅卯辰巳午未申酉戌亥]（本命\S+宫位）/.test(briefDaily.brief))
  ok('六层不再出现「落命宫宫」', !briefDaily.brief.includes('落命宫宫'))
  for (const layer of ['大限', '小限', '流年', '流月', '流日', '流时']) {
    ok(`六层含${layer}`, new RegExp('^' + layer + ' ', 'm').test(briefDaily.brief))
  }
  ok('daily 摘要无时间轴段', !briefDaily.brief.includes('## 逐年时间轴'))
  // 关键：不是 JSON。没有花括号包裹的整块结构，没有英文键名。
  ok('摘要不是 JSON', !briefDaily.brief.trimStart().startsWith('{'))
  ok('摘要不含 JSON 键名', !briefDaily.brief.includes('"majorStars"')
    && !briefDaily.brief.includes('"palaceNames"'))
  ok('摘要不含代码围栏', !briefDaily.brief.includes('```json'))
  ok('meta 标记无时间轴', briefDaily.meta.hasTimeline === false)
  ok('meta 带长度且非空', briefDaily.meta.length > 500)

  const briefRange = await svc.getAnalysisBrief({ personId, horoscopeId: fYears.record.id })
  ok('range 摘要带逐年时间轴', briefRange.brief.includes('## 逐年时间轴'))
  ok('range 摘要 meta 标记有时间轴', briefRange.meta.hasTimeline === true)
  ok('摘要提示加载技能', briefRange.brief.includes('ziwei-doushu'))

  // 体积对比：摘要必须远小于原始 JSON——这是改用工具取数的根本理由。
  const rawJson = JSON.stringify({
    astrolabe: (await svc.getChart({ personId })).chart.astrolabe,
    horoscope: (await svc.getHoroscope({ personId, horoscopeId: fYears.record.id })).horoscope,
    fortune: (await svc.getHoroscope({ personId, horoscopeId: fYears.record.id })).fortune,
  })
  ok('摘要比原始 JSON 小一个数量级', briefRange.brief.length < rawJson.length / 5)

  ok('不存在的记录报 not-found',
    (await svc.getAnalysisBrief({ personId, horoscopeId: 'nope' })).error.code === 'ziwei/not-found')
  ok('不存在的人员报 not-found',
    (await svc.getAnalysisBrief({ personId: 'nope', horoscopeId: 'x' })).error.code === 'ziwei/not-found')
  ok('取摘要不写入历史', (await svc.listHoroscopes({ personId })).records.length === hist.records.length)

  // iztro 不变量：每层 palaceNames[index] 恒为「命宫」，且 12 宫名唯一。
  // 摘要的「本命宫位」换算依赖这条，所以直接守住它。
  {
    const ho = (await svc.getHoroscope({ personId, horoscopeId: fYears.record.id })).horoscope
    for (const k of ['decadal', 'age', 'yearly', 'monthly', 'daily', 'hourly']) {
      const layer = ho?.[k]
      ok(`六层 ${k} 的 palaceNames[index] 是命宫`, layer?.palaceNames?.[layer.index] === '命宫')
      ok(`六层 ${k} 的 12 宫名唯一`, new Set(layer?.palaceNames ?? []).size === 12)
    }
  }

  /* ---------- 不存在的生日不能被存下来 ---------- */
  console.log('\n[4g] 阳历日期真实性')
  {
    const before = (await svc.listPeople({})).people.length
    for (const bad of ['1990-2-30', '1990-2-29', '1990-4-31']) {
      const r = await svc.addPerson({ name: '坏日期', gender: '男', birthDate: bad, birthTimeIndex: 3 })
      ok(`addPerson 拒绝 ${bad}`, r.ok === false)
    }
    ok('坏日期没有落盘', (await svc.listPeople({})).people.length === before)
    // convertDate 也不能把它"修正"成另一天而不报错
    const conv = svc.convertDate({ calendarType: 'solar', birthDate: '1990-2-30' })
    ok('convertDate 报错而不是静默溢出成 3-2', conv.ok === false)
  }

  /* ---------- 真太阳时 ---------- */
  console.log('\n[4h] 真太阳时（EoT + 经度修正 + 跨日）')
  {
    // EoT 严格对照给定规格的两组样例
    ok('EoT(2026,32) ≈ -13.5', Math.abs(equationOfTimeMinutes(2026, 32) - (-13.5)) < 0.5)
    ok('EoT(2026,315) ≈ 15.8', Math.abs(equationOfTimeMinutes(2026, 315) - 15.8) < 0.5)
    // 全年范围应落在 ±17 分钟内（近似公式的合理区间）
    let lo = 99, hi = -99
    for (let d = 1; d <= daysInYear(2026); d++) {
      const v = equationOfTimeMinutes(2026, d)
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    ok('EoT 全年范围合理', lo > -17 && hi < 17 && lo < -10 && hi > 10)
    // 年积日：1 月 1 日 = 1，闰年 12 月 31 日 = 366
    ok('年积日 1月1日=1', dayOfYear(2026, 1, 1) === 1)
    ok('年积日 2月1日=32', dayOfYear(2026, 2, 1) === 32)
    ok('年积日 11月11日=315', dayOfYear(2026, 11, 11) === 315)
    ok('平年 12月31日=365', dayOfYear(2026, 12, 31) === 365)
    ok('闰年 12月31日=366', dayOfYear(2024, 12, 31) === 366)
    ok('闰年判断正确', isLeapYear(2024) === true && isLeapYear(2100) === false
      && isLeapYear(2000) === true && isLeapYear(2026) === false)

    // 经度修正：每度 4 分钟，以东经 120° 为零点
    ok('经度 120° 无偏移', longitudeCorrectionMinutes(120) === 0)
    ok('经度 121° = +4 分', longitudeCorrectionMinutes(121) === 4)
    ok('经度 119° = -4 分', longitudeCorrectionMinutes(119) === -4)
    ok('乌鲁木齐经度修正 ≈ -129.5', Math.abs(longitudeCorrectionMinutes(87.62444) - (-129.5)) < 0.1)

    // 时辰映射：早子时 1 小时、晚子时 1 小时、其余 2 小时
    ok('00:00 → 早子时', timeIndexFromMinutes(0) === 0)
    ok('00:59 → 早子时', timeIndexFromMinutes(59) === 0)
    ok('01:00 → 丑时', timeIndexFromMinutes(60) === 1)
    ok('12:00 → 午时', timeIndexFromMinutes(720) === 6)
    ok('22:59 → 亥时', timeIndexFromMinutes(1379) === 11)
    ok('23:00 → 晚子时', timeIndexFromMinutes(1380) === 12)
    ok('23:59 → 晚子时', timeIndexFromMinutes(1439) === 12)

    // 换算主流程
    const tst1 = computeTrueSolarTime({ solarDate: '2026-11-11', minutes: 12 * 60, longitude: 116.413384 })
    ok('北京 12:00 校正可用', tst1.ok === true)
    ok('北京经度修正为负', tst1.correction.longitudeMinutes < 0)
    // 11 月中旬 EoT 是 +15.7 分，足以盖过北京 -14.35 分的经度修正，
    // 所以净效果是略晚——这正是必须两项都算、不能只看经度的原因。
    ok('11 月 EoT 为正且与经度修正反号',
      tst1.correction.equationOfTimeMinutes > 10 && tst1.correction.longitudeMinutes < -10)
    ok('北京 11 月净修正接近 0', Math.abs(tst1.correction.totalMinutes) < 5)
    ok('北京当日不跨日', tst1.trueSolar.dayShift === 0)
    ok('校正 = 经度修正 + EoT', Math.abs(
      tst1.correction.totalMinutes
      - (tst1.correction.longitudeMinutes + tst1.correction.equationOfTimeMinutes)) < 0.02)

    // 跨日：乌鲁木齐 00:30 会退到前一天
    const tst2 = computeTrueSolarTime({ solarDate: '2026-11-11', minutes: 30, longitude: 87.62444 })
    ok('乌鲁木齐 00:30 跨日退一天', tst2.trueSolar.dayShift === -1 && tst2.dateChanged === true)
    ok('跨日后日期正确', tst2.trueSolar.solarDate === '2026-11-10')
    ok('跨日后时辰变为亥时（22:36）', tst2.timeIndex === 11 && tst2.trueSolar.clock === '22:36')

    // 无效经度
    ok('经度越界被拒', computeTrueSolarTime({ solarDate: '2026-11-11', minutes: 0, longitude: 200 }).ok === false)

    // resolveTrueSolarTime：给了精确时刻就用时刻，没给用中点
    const r1 = resolveTrueSolarTime({ solarDate: '2026-11-11', clockMinutes: 12 * 60, timeIndex: 6, region: { name: '北京市', longitude: 116.413384 } })
    ok('精确时刻来源标记为 clock', r1.baseSource === 'clock')
    const r2 = resolveTrueSolarTime({ solarDate: '2026-11-11', timeIndex: 6, region: { name: '北京市', longitude: 116.413384 } })
    ok('无时刻时来源标记为 midpoint', r2.baseSource === 'midpoint')
    ok('中点法基准时刻为 12:00', r2.base.clock === '12:00')

    /* ---------- 地区数据 ---------- */
    const rg = svc.listRegions()
    ok('地区列表可用', rg.ok === true && rg.provinces.length >= 30)
    ok('地区含全部城市', rg.cityCount >= 300)
    ok('每个省都有城市', rg.provinces.every((p) => p.cities.length > 0))
    ok('城市带经纬度', rg.provinces.every((p) => p.cities.every((c) =>
      Number.isFinite(c.lng) && Number.isFinite(c.lat))))
    ok('中国境内经度合理', rg.provinces.every((p) => p.cities.every((c) =>
      c.lng > 70 && c.lng < 140)))

    // 数据来源必须标明（开源项目署名，不能悄悄用）
    ok('地区数据带来源署名', /dingyong0214\/city-data/.test(rg.attribution))
    // data/regions.json 是运行期唯一数据文件，必须存在且自洽
    {
      const raw = JSON.parse(await fs.readFile(new URL('../data/regions.json', import.meta.url), 'utf8'))
      ok('数据文件记录上游来源', Array.isArray(raw.source) && raw.source.length === 2)
      ok('数据文件带署名', /dingyong0214\/city-data/.test(raw.attribution))
      ok('matched 与省份聚合数一致',
        raw.matched === raw.provinces.reduce((a, p) => a + p.cities.length, 0))
      ok('skipped 条目结构完整（province/node/cities）',
        raw.skipped.every((x) => x.province && x.node && Array.isArray(x.cities) && x.cities.length))
      ok('skipped 合计 29 个地名', raw.skipped.reduce((a, x) => a + x.cities.length, 0) === 29)
    }

    // 已知缺口必须如实带出去，不能静默少掉。
    // 这 29 个县级市/县在经纬度源表里没坐标，是真实出生地而非无效条目。
    ok('缺口清单非空', Array.isArray(rg.missing) && rg.missing.length === 29)
    const missingNames = rg.missing.map((x) => x.name)
    for (const expected of ['济源市', '仙桃市', '石河子市', '阿拉尔市', '五指山市', '昆玉市']) {
      ok(`缺口含 ${expected}`, missingNames.includes(expected))
    }
    ok('缺口都带省份', rg.missing.every((x) => !!x.province))
    // 缺口地名确实选不到（未混进可选列表）
    const selectable = new Set(rg.provinces.flatMap((p) => p.cities.map((c) => c.name)))
    ok('缺口地名不在可选列表里', missingNames.every((n) => !selectable.has(n)))
    // 反过来：可选城市一个都不在缺口里，两边不重叠
    ok('缺口与可选列表不相交', rg.missing.every((x) => !selectable.has(x.name)))
    // diagnostics 也要暴露缺口数（不然只有翻 JSON 才知道）
    ok('diagnostics 暴露缺口数', svc.diagnostics().regions.missingCities === 29)

    /* ---------- 预览 ---------- */
    const pv = svc.previewTrueSolarTime({
      birthDate: '1990-5-4', birthTimeIndex: 3, birthClock: '06:30', regionName: '乌鲁木齐市',
    })
    ok('预览可用', pv.ok === true)
    ok('预览给出填写值', pv.written.timeIndex === 3 && pv.written.clock === '06:30')
    ok('预览给出校正值', pv.corrected.timeIndex === 2 && pv.corrected.clock === '04:24')
    ok('预览标记时辰已变', pv.timeIndexChanged === true)
    ok('预览给出两项修正', Number.isFinite(pv.correction.longitudeMinutes)
      && Number.isFinite(pv.correction.equationOfTimeMinutes))

    // 无精确时刻时按时辰中点，并在 clockLabel 里说明
    const pv2 = svc.previewTrueSolarTime({ birthDate: '1990-5-4', birthTimeIndex: 3, regionName: '乌鲁木齐市' })
    ok('无时刻走中点', pv2.baseSource === 'midpoint' && /中点/.test(pv2.written.clockLabel))

    ok('预览缺地区被拒', svc.previewTrueSolarTime({ birthDate: '1990-5-4', birthTimeIndex: 3 })
      .error.code === 'ziwei/invalid-region')
    ok('预览坏地区被拒', svc.previewTrueSolarTime({
      birthDate: '1990-5-4', birthTimeIndex: 3, regionName: '火星市',
    }).error.code === 'ziwei/region-not-found')
    ok('预览坏时刻被拒', svc.previewTrueSolarTime({
      birthDate: '1990-5-4', birthTimeIndex: 3, birthClock: '25:99', regionName: '北京市',
    }).error.code === 'ziwei/invalid-clock')
  }

  /* ---------- 建档时真太阳时生效 ---------- */
  console.log('\n[4i] 真太阳时建档与排盘')
  {
    // 未启用：字段应全部为空/关闭
    const plain = await svc.addPerson({
      name: '未启用太阳时', gender: '女', birthDate: '1990-5-4', birthTimeIndex: 3,
    })
    ok('未启用时 useTrueSolarTime=false', plain.person.useTrueSolarTime === false)
    ok('未启用时无地区', plain.person.regionName === '' && plain.person.regionLongitude === null)
    ok('未启用时 solar.enabled=false', plain.person.solar?.enabled === false)

    // 启用：必须选地区
    ok('启用但未选地区被拒', (await svc.addPerson({
      name: 'X', gender: '女', birthDate: '1990-5-4', birthTimeIndex: 3, useTrueSolarTime: true,
    })).error.code === 'ziwei/invalid-region')
    ok('启用但地区不存在被拒', (await svc.addPerson({
      name: 'X', gender: '女', birthDate: '1990-5-4', birthTimeIndex: 3,
      useTrueSolarTime: true, regionName: '火星市',
    })).error.code === 'ziwei/region-not-found')
    ok('坏时刻被拒', (await svc.addPerson({
      name: 'X', gender: '女', birthDate: '1990-5-4', birthTimeIndex: 3,
      useTrueSolarTime: true, regionName: '北京市', birthClock: '9点半',
    })).error.code === 'ziwei/invalid-clock')

    // 启用且合法：档案存住填写值 + 校正值
    const tstPerson = await svc.addPerson({
      name: '乌鲁木齐人', gender: '女', birthDate: '1990-5-4', birthTimeIndex: 3,
      useTrueSolarTime: true, regionName: '乌鲁木齐市', birthClock: '06:30',
    })
    ok('启用建档成功', tstPerson.ok === true)
    ok('档案保留填写时辰', tstPerson.person.birthTimeIndex === 3)
    ok('档案保留填写时刻', tstPerson.person.birthClock === '06:30')
    ok('档案保留地区', tstPerson.person.regionName === '乌鲁木齐市'
      && Math.abs(tstPerson.person.regionLongitude - 87.62444) < 0.01)
    ok('档案带校正结果', tstPerson.person.solar?.enabled === true
      && tstPerson.person.solar.trueSolar.timeIndex === 2
      && tstPerson.person.solar.trueSolar.clock === '04:24')
    ok('校正结果与填写值同时保留', tstPerson.person.birthTimeIndex === 3
      && tstPerson.person.solar.trueSolar.timeIndex === 2)

    // 排盘必须用校正后的时辰，而不是填写的时辰
    const cTst = await svc.getChart({ personId: tstPerson.person.id })
    ok('排盘用校正后时辰', cTst.chart.input.timeIndex === 2)
    ok('排盘记录校正过程', cTst.chart.solar?.correction?.longitudeMinutes < -120)
    const soulTst = cTst.chart.astrolabe.palaces.find((x) => x.name === '命宫')
    ok('校正前后命宫主星不同（证明真的换了盘）', soulTst.majorStars.length > 0)

    // 同一人关掉真太阳时重排，应回到填写时辰
    const off = await svc.updatePerson({
      personId: tstPerson.person.id, patch: { useTrueSolarTime: false },
    })
    ok('关闭后清空地区', off.person.regionName === '' && off.person.regionLongitude === null)
    const cOff = await svc.getChart({ personId: tstPerson.person.id })
    ok('关闭后按填写时辰排盘', cOff.chart.input.timeIndex === 3)

    // 农历 + 跨日：日期必须一起退
    const lunarTst = await svc.addPerson({
      name: '农历跨日', gender: '女', birthDate: '1990-4-10', calendarType: 'lunar',
      birthTimeIndex: 0, useTrueSolarTime: true, regionName: '乌鲁木齐市', birthClock: '00:30',
    })
    ok('农历跨日建档成功', lunarTst.ok === true)
    ok('农历跨日校正到前一天', lunarTst.person.solar.trueSolar.solarDate === '1990-5-3')
    const cLunar = await svc.getChart({ personId: lunarTst.person.id })
    ok('跨日后排盘日期同步', cLunar.chart.input.solarDate === '1990-5-3')
    ok('跨日后排盘时辰为亥时', cLunar.chart.input.timeIndex === 11)

    // diagnostics 暴露地区状态
    ok('diagnostics 带地区信息', svc.diagnostics().regions?.available === true)
  }

  /* ---------- 定盘：同一天全部时辰 ---------- */
  console.log('\n[4f] listTimeCandidates（定盘）')
  const tc = await svc.listTimeCandidates({ gender: '女', birthDate: '1990-5-4' })
  ok('定盘可用', tc.ok === true)
  ok('返回 13 个候选时辰', tc.candidates.length === 13)
  ok('候选顺序与 TIME_OPTIONS 一致', tc.candidates.every((c, i) => c.timeIndex === i))
  ok('每个候选都有时辰名与时段', tc.candidates.every((c) => c.timeLabel && c.timeRange))
  ok('全部候选排盘成功', tc.candidates.every((c) => c.ok === true))
  ok('distinct 为正整数且 ≤13', Number.isInteger(tc.distinct) && tc.distinct > 0 && tc.distinct <= 13)
  ok('note 说明候选数与不同盘数', /13 个时辰/.test(tc.note) && /张不同的盘/.test(tc.note))
  // 每个候选必须带可判读的盘面特征
  for (const c of tc.candidates) {
    ok(`候选 ${c.timeIndex} 有命宫`, c.soulPalace && c.soulPalace.ganzhi)
    ok(`候选 ${c.timeIndex} 有命宫主星数组`, Array.isArray(c.soulPalace.majors))
    ok(`候选 ${c.timeIndex} 有身宫`, !!c.bodyPalace && !!c.bodyPalace.earthlyBranch)
    ok(`候选 ${c.timeIndex} 有五行局/命主/身主`, !!c.fiveElementsClass && !!c.soul && !!c.body)
    // 关键宫必须给出（命宫 + 兄弟/夫妻/迁移/福德）
    const names = c.keyPalaces.map((p) => p.palace)
    ok(`候选 ${c.timeIndex} 关键宫齐全`, ['命宫', '兄弟宫', '夫妻宫', '迁移宫', '福德宫']
      .every((n) => names.includes(n)))
    ok(`候选 ${c.timeIndex} 有指纹`, typeof c.fingerprint === 'string' && c.fingerprint.length > 0)
  }
  // 指纹唯一性与 distinct 一致
  const uniq = new Set(tc.candidates.map((c) => c.fingerprint)).size
  ok('distinct 与唯一指纹数一致', tc.distinct === uniq)
  // 相邻时辰应排出不同的盘（否则定盘无意义）
  ok('至少两个时辰盘面不同', tc.distinct >= 2)
  // 早子时与晚子时是同一时辰的两半，通常同盘；但丑时必然不同于早子时
  ok('不同时辰命宫可不同', tc.candidates[0].soulPalace.ganzhi !== tc.candidates[1].soulPalace.ganzhi
    || tc.candidates[0].soulPalace.majors.join() !== tc.candidates[1].soulPalace.majors.join())

  // 带换算信息
  ok('返回历法换算', !!tc.solarDate && !!tc.lunarText && !!tc.display)
  // 提示词由 Host 生成
  ok('返回定盘提示词', typeof tc.starterPrompt === 'string' && tc.starterPrompt.length > 200)
  ok('提示词指向 ziwei_time_candidates', tc.starterPrompt.includes('ziwei_time_candidates'))
  ok('提示词要求突出差异', tc.starterPrompt.includes('差异'))
  ok('提示词含建档指令', tc.starterPrompt.includes('ziwei_people'))
  ok('提示词含 confirm', tc.starterPrompt.includes('confirm: true'))
  ok('提示词不含候选数据', !tc.starterPrompt.includes('timeIndex=0'))
  ok('提示词足够短（<2000）', tc.starterPrompt.length < 2000)

  // 姓名必须带进提示词的建档指令——否则 AI 只能填占位符或回头问用户。
  const tcNamed = await svc.listTimeCandidates({
    name: '张三', gender: '女', birthDate: '1990-5-4',
  })
  ok('定盘回显姓名', tcNamed.name === '张三')
  ok('提示词带填写姓名', /张三/.test(tcNamed.starterPrompt))
  ok('提示词开场含姓名', /我不确定自己的出生时辰。已知：张三，/.test(tcNamed.starterPrompt))
  ok('建档指令用真实姓名', /name: "张三"/.test(tcNamed.starterPrompt))
  ok('建档指令不含占位符', !/<姓名/.test(tcNamed.starterPrompt)
    && !/用户没给就填/.test(tcNamed.starterPrompt))
  ok('提示词提醒不要再问姓名', /再问用户叫什么/.test(tcNamed.starterPrompt))

  // 没填姓名：用「本人」兜底，仍不能留占位符
  const tcAnon = await svc.listTimeCandidates({ gender: '女', birthDate: '1990-5-4' })
  ok('未填姓名时置空', tcAnon.name === '')
  ok('未填姓名时建档用「本人」', /name: "本人"/.test(tcAnon.starterPrompt))
  ok('未填姓名时仍无占位符', !/<姓名/.test(tcAnon.starterPrompt))
  ok('未填姓名时开场不出现空姓名', !/已知：，/.test(tcAnon.starterPrompt))

  // 姓名为纯空白应视为未填
  const tcBlank = await svc.listTimeCandidates({
    name: '   ', gender: '女', birthDate: '1990-5-4',
  })
  ok('纯空白姓名视为未填', tcBlank.name === '' && /name: "本人"/.test(tcBlank.starterPrompt))

  // 农历输入
  const tcLunar = await svc.listTimeCandidates({
    gender: '男', birthDate: '1990-4-10', calendarType: 'lunar',
  })
  ok('农历定盘可用', tcLunar.ok === true && tcLunar.candidates.length === 13)
  ok('农历回调带阳历换算', !!tcLunar.solarDate && tcLunar.calendarType === 'lunar')

  // 非法输入
  ok('缺性别被拒绝', (await svc.listTimeCandidates({ birthDate: '1990-5-4' }))
    .error.code === 'ziwei/invalid-gender')
  ok('非法性别被拒绝', (await svc.listTimeCandidates({ gender: '未知', birthDate: '1990-5-4' }))
    .error.code === 'ziwei/invalid-gender')
  ok('缺日期被拒绝', (await svc.listTimeCandidates({ gender: '男' }))
    .error.code === 'ziwei/invalid-date')
  ok('非法日期被拒绝', (await svc.listTimeCandidates({ gender: '男', birthDate: '1990-2-30' }))
    .ok !== true)
  ok('不存在的农历闰月被拒绝', (await svc.listTimeCandidates({
    gender: '男', birthDate: '1990-4-1', calendarType: 'lunar', isLeapMonth: true,
  })).ok !== true)

  // 定盘不写盘（用调用前后的数量对比，避免依赖其它用例建了多少人）
  {
    const before = (await svc.listPeople({})).people.length
    await svc.listTimeCandidates({ gender: '女', birthDate: '1990-5-4' })
    ok('定盘不新增人员', (await svc.listPeople({})).people.length === before)
  }

  /* ---------- 分析回填到记录 ---------- */
  console.log('\n[4e] saveAnalysis（AI 分析回填）')
  const targetId = fYears.record.id
  const analysisText = [
    '## 总体判断',
    '',
    '本命命宫天机太阴，思路细腻；本次流年落官禄宫位，工作压力偏大但可控。',
    '',
    '### 依据',
    '- 命宫：天机[得] 太阴[旺科]',
    '- 流年：丙午，命宫在午（本命官禄宫位）',
    '',
    '---',
    '',
    '建议稳守，不宜激进扩张。',
  ].join('\n')

  const saved = await svc.saveAnalysis({ personId, horoscopeId: targetId, content: analysisText })
  ok('回填成功', saved.ok === true && saved.horoscopeId === targetId)
  ok('回填返回摘要', typeof saved.analysis.summary === 'string' && saved.analysis.summary.length > 0)
  ok('摘要为自动截取', saved.analysis.summaryAuto === true)
  ok('摘要长度受限（≤200）', saved.analysis.summary.length <= 200)
  ok('首次回填不算覆盖', saved.analysis.replaced === false && saved.analysis.revisions === 1)
  ok('摘要去掉 Markdown 标记', !saved.analysis.summary.includes('##')
    && !saved.analysis.summary.includes('**')
    && !saved.analysis.summary.includes('---')
    && !/^\s*[-*+]\s/m.test(saved.analysis.summary))

  // 详情能读到全文
  const withAna = await svc.getHoroscope({ personId, horoscopeId: targetId })
  ok('详情带分析全文', withAna.record.analysis?.content === analysisText)
  ok('详情带分析元信息', withAna.record.analysis.revisions === 1
    && !!withAna.record.analysis.createdAt && !!withAna.record.analysis.updatedAt)

  // 列表只带摘要，不带全文
  const listed = await svc.listHoroscopes({ personId })
  const row = listed.records.find((r) => r.id === targetId)
  ok('列表带分析摘要', !!row.analysisSummary)
  ok('列表不带分析全文', row.analysis === undefined && row.analysisSummary !== analysisText)
  ok('列表其他记录无摘要', listed.records.filter((r) => r.id !== targetId)
    .every((r) => !r.analysisSummary))

  // 重复回填：覆盖正文 + 累加版本
  const saved2 = await svc.saveAnalysis({
    personId, horoscopeId: targetId, content: '第二版分析正文', summary: '手工摘要',
  })
  ok('重复回填成功且标记覆盖', saved2.ok === true && saved2.analysis.replaced === true)
  ok('revisions 累加', saved2.analysis.revisions === 2)
  ok('手工摘要优先', saved2.analysis.summary === '手工摘要' && saved2.analysis.summaryAuto === false)
  const after2 = await svc.getHoroscope({ personId, horoscopeId: targetId })
  ok('正文被覆盖为最新版', after2.record.analysis.content === '第二版分析正文')
  ok('createdAt 保持首次时间', after2.record.analysis.createdAt === saved.analysis.createdAt)
  ok('updatedAt 已刷新', after2.record.analysis.updatedAt !== saved.analysis.createdAt)

  // 校验与边界
  ok('空正文被拒绝', (await svc.saveAnalysis({
    personId, horoscopeId: targetId, content: '   ',
  })).error.code === 'ziwei/invalid-analysis')
  ok('缺 horoscopeId 被拒绝', (await svc.saveAnalysis({
    personId, content: 'x',
  })).error.code === 'ziwei/invalid-input')
  ok('不存在的人员报 not-found', (await svc.saveAnalysis({
    personId: 'nope', horoscopeId: targetId, content: 'x',
  })).error.code === 'ziwei/not-found')
  ok('不存在的记录报 not-found', (await svc.saveAnalysis({
    personId, horoscopeId: 'nope', content: 'x',
  })).error.code === 'ziwei/not-found')
  ok('超长正文被拒绝', (await svc.saveAnalysis({
    personId, horoscopeId: targetId, content: 'x'.repeat(60001),
  })).error.code === 'ziwei/analysis-too-long')

  // 回填不影响记录本身的数据（星盘/运限快照不可变）
  ok('回填不改动运限数据', after2.record.horoscope !== undefined
    && after2.record.targetDate === fYears.record.targetDate
    && after2.record.years === fYears.record.years)
  ok('回填不改动记录 id', after2.record.id === targetId)

  const delP = await svc.deletePerson({ personId })
  ok('删除人员', delP.ok === true)
  ok('删除不存在的人员返回 not-found', (await svc.deletePerson({ personId })).error.code === 'ziwei/not-found')

  // 收尾：清掉本轮所有人员，确认列表能清空（顺带验证 deletePerson 连带清理）
  for (const p of (await svc.listPeople({})).people) await svc.deletePerson({ personId: p.id })
  ok('人员列表清空', (await svc.listPeople({})).people.length === 0)

  /* ---------- Remote 契约 ---------- */
  console.log('\n[5] Remote 契约')
  ok('22 个 Remote 方法', REMOTE_METHODS.length === 22)
  ok('末尾八个方法顺序正确', REMOTE_METHODS[14] === 'convertDate'
    && REMOTE_METHODS[15] === 'getFortune' && REMOTE_METHODS[16] === 'buildAnalysisContext'
    && REMOTE_METHODS[17] === 'getAnalysisBrief' && REMOTE_METHODS[18] === 'saveAnalysis'
    && REMOTE_METHODS[19] === 'listTimeCandidates' && REMOTE_METHODS[20] === 'listRegions'
    && REMOTE_METHODS[21] === 'previewTrueSolarTime')
  ok('全部方法在服务实例上存在', REMOTE_METHODS.every((m) => typeof svc[m] === 'function'))
  ok('diagnostics 返回引擎信息', svc.diagnostics().engine.library === 'iztro')

  /* ---------- 持久化 ---------- */
  console.log('\n[6] 持久化')
  const p2 = await svc.addPerson({ name: '李四', gender: '女', birthDate: '1995-2-23', birthTimeIndex: 9 })
  const svc2 = new ZiweiWorkbench({ get: () => null, provide() {}, set() {}, inject() {} }, config)
  const reload = await svc2.getPerson({ personId: p2.person.id })
  ok('重开实例后数据仍在', reload.ok === true && reload.person.name === '李四')

  console.log(`\n全部通过：${passed} 项断言`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
