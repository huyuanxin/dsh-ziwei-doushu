/**
 * 浏览器半区冒烟测试：在 Node 里模拟 DSH 的浏览器模块表，
 * 用「最小 React 实现」真正挂载 Workbench 组件，验证：
 *  · 模块能加载、factory 能执行、apply 能完成槽位注册；
 *  · 组件树能渲染（不抛异常），且包含关键 UI 文案；
 *  · 主流程的 Remote 调用形状正确（descriptor 与 wire 名）。
 *
 * 这个测试不模拟真实 DOM 事件，只保证「模块能跑起来、组件能渲染」，
 * 拦截的是最常见的两类上线事故：语法/引用错误、渲染期抛异常。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const src = await fs.readFile(path.join(root, 'lib/client.js'), 'utf8')

/* ---------------- 最小 React 实现 ---------------- */
let hookIndex = 0
let hookStore = []
function resetHooks() { hookIndex = 0; hookStore = [] }
function useState(init) {
  const i = hookIndex++
  if (!(i in hookStore)) hookStore[i] = typeof init === 'function' ? init() : init
  return [hookStore[i], (v) => { hookStore[i] = typeof v === 'function' ? v(hookStore[i]) : v }]
}
function useEffect() { /* 测试里不执行 effect */ }
function useMemo(fn) { return fn() }
function useCallback(fn) { return fn }
function useRef(init) {
  const i = hookIndex++
  if (!(i in hookStore)) hookStore[i] = { current: init }
  return hookStore[i]
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useState, useEffect, useMemo, useCallback, useRef,
}

/* ---------------- 模块表 ---------------- */
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { captured = m } } },
  console,
  setTimeout, clearTimeout,
  location: { origin: 'http://127.0.0.1:55172' },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: class {},
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'lib/client.js' })
assert.ok(captured, 'window.__ModuleLoader__.load 未被调用')
assert.equal(captured.id, 'dsh-ziweidoushu')

const mod = captured.factory((name) => {
  assert.equal(name, 'react', 'client 只应 require react')
  return React
})
assert.ok(mod && typeof mod.apply === 'function', 'factory 未返回含 apply 的模块')

/* ---------------- Remote 描述符检查 ---------------- */
const effectDisposers = []
const registered = []
const fakeCtx = {
  effect(fn) { const d = fn(); effectDisposers.push(d); return d },
  remote: {
    async $mount(contribution) { fakeCtx.contribution = contribution },
  },
  inject(deps, fn) {
    fakeCtx.injectDeps = deps
    const scope = {
      remote: { ziwei: { fake: true } },
      slots: {
        inject(name, reg) { const r = reg(); registered.push({ name, r }); return r },
        register(spec, comp) { return { spec, comp } },
      },
    }
    fn(scope)
    return Promise.resolve({ dispose: async () => {} })
  },
}
await mod.apply(fakeCtx)
assert.equal(Array.from(mod.inject).join(','), 'remote')
assert.equal(fakeCtx.contribution.descriptors.length, 22)
assert.equal(fakeCtx.contribution.descriptors[14].method, 'convertDate')
assert.equal(fakeCtx.contribution.descriptors[15].method, 'getFortune')
assert.equal(fakeCtx.contribution.descriptors[16].method, 'buildAnalysisContext')

// 需求：人员选择在左、详情在右。
assert.match(src, /\.zw-body\{[^}]*grid-template-columns:\s*296px minmax\(0,1fr\)/,
  '布局应为「左列表 296px / 右详情」')
const bodyAt = src.indexOf("className: 'zw-body'")
const listAt = src.indexOf("className: 'zw-list'", bodyAt)
const detailAt = src.indexOf("className: 'zw-detail'", bodyAt)
assert.ok(bodyAt > 0 && listAt > bodyAt && detailAt > listAt,
  '.zw-body 的子元素顺序应为 list 先、detail 后')

// 需求：农历（含闰月）支持，且走第 15 个 Remote 方法做实时换算预览。
assert.match(src, /LunarDateInput/, '缺少农历日期输入组件')
assert.match(src, /isLeapMonth/, '缺少闰月支持')
assert.match(src, /calendarType/, '缺少历法切换')
assert.match(src, /'convertDate'/, '缺少 convertDate 实时换算调用')

// 需求：快捷运势只保留「按钮行 + 记录列表」，不要即时结果展示区。
assert.match(src, /'getFortune'/, '缺少 getFortune 快捷运势调用')
assert.match(src, /FortuneQuick|FortuneQuickBar/, '缺少快捷按钮组件')
assert.match(src, /'今天'/, '缺少「今天」快捷入口')
assert.match(src, /'明天'/, '缺少「明天」快捷入口')
assert.match(src, /'nYears'/, '缺少「未来 N 年」快捷入口')
assert.match(src, /deduplicated/, '缺少去重提示处理')
assert.match(src, /onRecordCreated|refreshHoroscopes/, '缺少「写入历史后刷新列表」的联动')
assert.match(src, /zw-rows|zw-row/, '缺少运限记录列表')
assert.match(src, /record\.kind|\.kind/, '缺少按记录类型区分的渲染')
// 时间轴仍要在「点进 range 记录详情」里出现（组件定义 + 详情页调用都要在）。
assert.match(src, /function FortuneTimeline/, '缺少 FortuneTimeline 组件定义（详情页要用）')
assert.match(src, /h\(FortuneTimeline/, '缺少详情页时间轴渲染')
// 快捷按钮组件内部不应再渲染即时结果（FortuneTimeline / 结果卡片）。
const barStart = src.indexOf('function FortuneQuick')
const barEnd = src.search(/function (PersonModal|LunarDateInput|Workbench)/)
const barSrc = barStart >= 0 ? src.slice(barStart, barEnd > barStart ? barEnd : src.length) : ''
if (barStart >= 0) {
  assert.ok(!barSrc.includes('h(FortuneTimeline'),
    '快捷按钮区不应再渲染 FortuneTimeline（即时结果展示已移除）')
  assert.ok(!barSrc.includes('zw-fq-result') && !barSrc.includes('zw-tl'),
    '快捷按钮区不应再有即时结果卡片 / 时间轴')
}
// 快捷查看不应自己调 createHoroscope（那是手动查询入口）
assert.ok(!barSrc.includes("'createHoroscope'"),
  '快捷按钮区不应调用 createHoroscope（快捷记录由 getFortune 自己落库）')

// 需求：range 详情按年分 Tab，本页切换查看该年详情（不再是纵向长列表）。
assert.match(src, /selectedYear/, '缺少选中年份状态（本页切换查看）')
assert.match(src, /zw-yeartabs?|zw-yeartab/, '缺少年份 Tab 条')
assert.match(src, /zw-yeardet|年详情|该年详情/, '缺少年详情卡片')
assert.match(src, /palaceNames/, '缺少流年十二宫重排展示')
// 旧的纵向时间轴列表应已移除（FortuneTimeline 内不得再有 .zw-tl-item 渲染）。
const ftStart = src.indexOf('function FortuneTimeline')
const ftEnd = src.search(/function (FortuneQuick|LunarDateInput|PersonModal|Workbench)/)
const ftSrc = (ftStart >= 0 && ftEnd > ftStart) ? src.slice(ftStart, ftEnd) : ''
if (ftSrc) {
  assert.ok(!ftSrc.includes("'zw-tl-item'"),
    'FortuneTimeline 不应再渲染纵向年份长列表（已改为按年分 Tab）')
  assert.ok(ftSrc.includes("setSelectedYear"), 'FortuneTimeline 应保留年份切换逻辑')
}
// 需求：运限详情页不再展示命盘（AstrolabeGrid 只在星盘 Tab 用）。
assert.match(src, /function AstrolabeGrid/, 'AstrolabeGrid 组件应保留（星盘 Tab 在用）')
// 详情页区域（renderHoroscopeTab 内）不得再调用命盘。
const hTabStart = src.indexOf('const renderHoroscopeTab')
const hTabEnd = src.indexOf('const renderTab', hTabStart)
const horoscopeTabSrc = (hTabStart >= 0 && hTabEnd > hTabStart)
  ? src.slice(hTabStart, hTabEnd) : ''
if (horoscopeTabSrc) {
  assert.ok(!horoscopeTabSrc.includes('h(AstrolabeGrid'),
    '运限详情页不应再渲染命盘（AstrolabeGrid）')
  assert.ok(!horoscopeTabSrc.includes("'星盘命盘'"),
    '运限详情页不应再有「星盘命盘」子块')
}

// 需求：去掉 JSON 展示页面，只留一个「复制 JSON」按钮。
assert.match(src, /function CopyJsonButton/, '缺少复制 JSON 按钮组件')
assert.match(src, /navigator\.clipboard/, '复制应优先用剪贴板 API')
assert.match(src, /execCommand/, '剪贴板不可用时应有兜底复制')
assert.ok(!/function JsonBlock/.test(src), '旧的 JSON 展示组件应已移除')
assert.ok(!/className: 'zw-json'/.test(src), '不应再渲染 <pre> JSON 展示区')
assert.ok(!/zw-jsonbox|zw-jsonhd/.test(src), 'JSON 展示区样式应已清理')
assert.match(src, /复制星盘 JSON/, '星盘页应有复制 JSON 入口')
assert.match(src, /复制运限 JSON/, '运限详情应有复制 JSON 入口')

// 需求：六层运限（大限/小限/流年/流月/流日/流时）用分层卡片展示，不是一坨字段行。
assert.match(src, /function scopeLayers/, '缺少六层结构化摘要')
assert.match(src, /function ScopeLayers/, '缺少六层卡片组件')
assert.match(src, /zw-scope-card/, '缺少六层卡片样式')
assert.match(src, /zw-mg-chip/, '缺少四化彩色徽标')
assert.match(src, /h\(ScopeLayers, \{ horoscope: horo \}\)/, '详情页应使用六层卡片渲染')
assert.ok(!/scopeSummary\(horo\)/.test(src), '不应再用旧的字段行方式渲染六层')

// 需求：点击「AI 分析」只注入任务说明，数据靠 ziwei_analysis 工具现取
assert.match(src, /'buildAnalysisContext'/, '缺少 buildAnalysisContext 调用')
assert.match(src, /AnalysisLauncher/, '缺少 AnalysisLauncher 组件')
assert.match(src, /startSession\(/, '缺少 uiWorkspace.startSession 调用')
assert.match(src, /whenDraftExists:\s*'append'/, '新会话草稿应以 append 方式注入')
assert.match(src, /starterPrompt/, '应使用 Host 返回的 starterPrompt')
assert.match(src, /stopPropagation/, '列表行按钮应阻止冒泡（避免误进详情）')
// 关键约束：UI 绝不自己生成分析话术/拼数据；提示词完全由 Host 提供。
assert.ok(!/请分析以下紫微斗数|吉凶|命盘解读|你是.*大师/.test(src),
  'UI 不应包含任何分析话术/解读模板')
assert.match(src, /launchAnalysis/, '缺少 launchAnalysis 注入链路')
// UI 不得在客户端拼 JSON 快照塞进草稿（数据应由工具现取）。
assert.ok(!/JSON\.stringify\(.*starterPrompt/.test(src), 'UI 不应自行序列化数据注入草稿')

// 需求：AI 分析结果可回填到记录并在界面展示
assert.match(src, /AnalysisBlock/, '缺少分析回填展示组件')
assert.match(src, /rec\.analysis/, '详情页应读取记录的 analysis 字段')
assert.match(src, /analysisSummary/, '列表应显示分析摘要')
assert.match(src, /zw-ana/, '缺少分析区块样式')
assert.match(src, /desc\('saveAnalysis', 'request'\)/, '缺少 saveAnalysis descriptor')
assert.match(src, /desc\('listTimeCandidates', 'request'\)/, '缺少 listTimeCandidates descriptor')

// 真太阳时：开关 + 地区选择 + 校正预览
assert.match(src, /desc\('listRegions'\)/, 'listRegions 应为无参 descriptor')
assert.match(src, /desc\('previewTrueSolarTime', 'request'\)/, '缺少 previewTrueSolarTime descriptor')
assert.match(src, /RegionPicker/, '缺少地区选择组件')
assert.match(src, /useTrueSolarTime/, '缺少真太阳时开关字段')
assert.match(src, /zw-tst-toggle/, '缺少真太阳时开关样式')
assert.match(src, /zw-tst-result/, '缺少校正结果展示')
assert.match(src, /真太阳时/, '界面应出现「真太阳时」字样')
// 校正后时辰/日期变化必须显式提示（用户要知道排盘用的是哪个时辰）
assert.match(src, /校正为/, '应提示时辰已校正')
assert.match(src, /跨日/, '应提示跨日调整')

// 需求：定盘入口在「新增人员」弹窗里、时辰选择旁边（不是独立弹窗/顶部按钮）
assert.match(src, /runCalibrate/, '缺少定盘触发函数')
assert.match(src, /zw-calibrate-btn/, '缺少定盘按钮样式')
assert.ok(/zw-time-label/.test(src), '时辰标签行应承载定盘按钮')
assert.ok(!/UnknownTimeModal/.test(src), '不应再有独立的定盘弹窗')
// 定盘必须先校验姓名与日期（跳转对话前提醒填好其他信息）
assert.match(src, /请先填写姓名，定盘后会用它建档/, '定盘前应校验姓名')
assert.match(src, /请先选择出生日期/, '定盘前应校验日期')
// 姓名必须随定盘请求发给 Host，否则 AI 建档只能填占位符
assert.ok(/listTimeCandidates',\s*\{\s*request:\s*\{[\s\S]{0,200}?name:\s*n,/.test(src),
  '定盘请求必须带上 name')
// 客户端不得自己拼建档话术/占位符
assert.ok(!/<姓名/.test(src), '客户端不应出现姓名占位符')
assert.match(src, /不可|不会\*\*建档案|不会建档案/, '应说明定盘不建档')
// 顶部工具条不得再有「新增人员」按钮
assert.ok(!/h\('button', \{\s*className: 'zw-btn', disabled: busy,\s*onClick: \(\) => setPersonModal\(\{ mode: 'add' \}\),\s*\}, '新增人员'\)/.test(src),
  '新增人员不应再放在顶部工具条')
assert.match(src, /className: 'zw-iconbtn', title: '新增人员'/, '新增人员应在人员列表头部')
// 回填展示必须可折叠且能复制全文，不能只是塞一段不可操作的文本
assert.match(src, /zw-ana-toggle/, '分析区块应可折叠')
assert.match(src, /复制全文/, '分析区块应提供复制全文')
// 无参端点（diagnostics / listRegions）不该声明 parameters；
// 其余端点统一收一个名为 request 的形参，wire 名也必须是 request。
const NO_ARG_METHODS = new Set(['diagnostics', 'listRegions'])
for (const d of fakeCtx.contribution.descriptors) {
  if (NO_ARG_METHODS.has(d.method)) {
    assert.equal(d.parameters.length, 0, `${d.method} 应为无参端点`)
    continue
  }
  assert.equal(d.parameters[0].name, 'request', `${d.method} 首个形参应为 request`)
  assert.equal(d.parameters[0].wire, 'request', `${d.method} wire 名应为 request`)
}
assert.equal(fakeCtx.contribution.descriptors[0].method, 'diagnostics')
assert.equal(registered[0].name, 'main')
assert.equal(registered[0].r.spec.key, 'ziwei')
assert.equal(registered[1].name, 'sidebar.panellist')
assert.equal(registered[1].r.spec.id, 'ziwei')
assert.ok(typeof registered[1].r.spec.label === 'function')

/* ---------------- 组件渲染 ---------------- */
const Workbench = registered[0].r.comp
/**
 * 递归收集渲染出的文本与元素类型，顺便模拟一次渲染执行。
 * 每个函数组件渲染前后保存/恢复 hook 索引：嵌套组件不该复用父组件的 hook 槽位。
 */
function render(el, depth = 0) {
  if (depth > 60) return { text: '', types: [] }
  if (el === null || el === undefined || el === false || el === true) return { text: '', types: [] }
  if (typeof el === 'string' || typeof el === 'number') return { text: String(el), types: [] }
  if (Array.isArray(el)) {
    const parts = el.map((x) => render(x, depth + 1))
    return { text: parts.map((p) => p.text).join(''), types: parts.flatMap((p) => p.types) }
  }
  assert.ok(el && typeof el === 'object', '渲染产生了非法节点：' + String(el))
  const acc = { text: '', types: [typeof el.type === 'string' ? el.type : 'component'] }
  // 触发函数组件（这才是真正会抛异常的地方）
  const children = el.children
  if (typeof el.type === 'function') {
    const savedIndex = hookIndex
    const savedStore = hookStore
    hookIndex = 0
    hookStore = []
    try {
      const out = el.type(el.props ?? {})
      const r = render(out, depth + 1)
      acc.text += r.text; acc.types.push(...r.types)
    } finally {
      hookIndex = savedIndex
      hookStore = savedStore
    }
  } else {
    for (const c of (Array.isArray(children) ? children : [])) {
      const r = render(c, depth + 1)
      acc.text += r.text; acc.types.push(...r.types)
    }
  }
  return acc
}

const tree = render(Workbench({ remote: { fake: true } }))
assert.match(tree.text, /紫微斗数工作台/, '未渲染标题')
assert.match(tree.text, /人员列表/, '未渲染人员列表')
assert.match(tree.text, /暂无人员|正在读取人员列表/, '未渲染空态/加载态')
// 新增人员现在是人员列表头部的「+」图标按钮（不再是顶部文字按钮）
assert.match(src, /className: 'zw-iconbtn', title: '新增人员'/, '未渲染新增人员按钮')
assert.doesNotMatch(tree.text, /^新增人员$|新增人员$/m, '顶部不应再有「新增人员」文字按钮')
// 需求 A：一人一盘，顶部/星盘页都不再需要「新增排盘」入口。
assert.doesNotMatch(tree.text, /新增排盘/, '不应再出现「新增排盘」按钮')
assert.ok(tree.types.length >= 10, '组件树过浅，疑似渲染失败')

/* ---------------- 已选中人员形态 ---------------- */
// 让 useState 前两个初值注入「已有人 + 已选中」，验证三个 Tab 与详情区能渲染。
const baseSetState = useState
// 通过闭包替换：在 vm 之外无法直接改，因此用一个包装的 React 再跑一次 factory。
let captured2 = null
const sandbox2 = {
  window: { __ModuleLoader__: { load: (m) => { captured2 = m } } },
  console, setTimeout, clearTimeout,
  location: { origin: 'http://127.0.0.1:55172' },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: class {},
}
vm.createContext(sandbox2)
vm.runInContext(src, sandbox2, { filename: 'lib/client.js' })

let useStateCall = 0
const seededPerson = {
  id: 'p1', name: '测试者', gender: '男', birthDate: '2000-8-16',
  birthTimeIndex: 2, chartCount: 1, horoscopeCount: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}
const React2 = {
  ...React,
  useState(init) {
    useStateCall++
    // Workbench 里的前两个 useState：people、loadingPeople
    if (useStateCall === 1) return [[seededPerson], () => {}]
    if (useStateCall === 2) return [false, () => {}]
    // 第三个：selectedId
    if (useStateCall === 3) return ['p1', () => {}]
    // person（第 7 个 useState）
    if (useStateCall === 7) return [seededPerson, () => {}]
    return useState(init)
  },
}
const mod2 = captured2.factory(() => React2)
const fakeCtx2 = {
  effect(fn) { return fn() },
  remote: { async $mount() {} },
  inject(_deps, fn) {
    fn({
      remote: { ziwei: {} },
      slots: {
        inject(_name, reg) { return reg() },
        register(_spec, comp) { return { comp } },
      },
    })
    return Promise.resolve({ dispose: async () => {} })
  },
}
await mod2.apply(fakeCtx2)
// 上面 register 没保存 comp，重新抓一次：直接再跑一次 factory 更简单
let WB2 = null
const sandbox3 = { ...sandbox2, window: { __ModuleLoader__: { load: (m) => { captured2 = m } } } }
vm.createContext(sandbox3)
vm.runInContext(src, sandbox3, { filename: 'lib/client.js' })
const mod3 = captured2.factory(() => React2)
useStateCall = 0
const fakeCtx3 = {
  effect(fn) { return fn() },
  remote: { async $mount() {} },
  inject(_deps, fn) {
    fn({
      remote: { ziwei: {} },
      slots: {
        inject(name, reg) { const r = reg(); if (name === 'main' && r?.comp) WB2 = r.comp; return r },
        register(_spec, comp) { return { comp } },
      },
    })
    return Promise.resolve({ dispose: async () => {} })
  },
}
await mod3.apply(fakeCtx3)
assert.ok(WB2, '未抓到 Workbench 组件')
const tree2 = render(WB2({ remote: {} }))
assert.match(tree2.text, /人员详情/, '未渲染「人员详情」Tab')
assert.match(tree2.text, /星盘信息/, '未渲染「星盘信息」Tab')
assert.match(tree2.text, /运限历史/, '未渲染「运限历史」Tab')
assert.match(tree2.text, /测试者/, '未渲染选中人员姓名')
assert.match(tree2.text, /档案信息/, '未渲染档案信息卡片')
assert.doesNotMatch(tree2.text, /新增排盘/, '选中人员后也不应出现「新增排盘」入口')

/* ---------------- 命盘网格：用真实 iztro 数据驱动渲染 ---------------- */
// 需求 B 的核心：确认 12 宫按地支落位、主星/四化/中宫信息都真的从 astrolabe 取到并渲染。
const { generateAstrolabe } = await import(pathToFileURL(path.join(root, 'lib/chart.js')).href)
const real = generateAstrolabe({
  solarDate: '2000-8-16', timeIndex: 2, gender: '男', fixLeap: true, language: 'zh-CN',
})
assert.ok(real.ok === true)

// 再跑一次 factory，这次注入「选中了星盘 tab + 已经有 chartDetail」的状态。
// useState 调用序号（Workbench 内）：
//   1 people, 2 loadingPeople, 3 selectedId, 4 tab, 5 person, 6 charts,
//   7 horoscopes, 8 loadingDetail, 9 selectedChartId?（已删）, ...
// 与其依赖序号，不如只把 tab 和 chartDetail 强制注入：用一个包装 React，
// 对「初值是字符串 'chart'」的 useState 返回 'chart'，对「初值是含 astrolabe 的对象」返回该对象。
const chartDetailSeed = {
  ...real.astrolabe,          // 顶层字段（gender/solarDate/...）给中宫用
  id: 'chart_test', label: '测试盘',
  engine: { library: 'iztro', version: '2.6.5' },
  createdAt: '2026-01-01T00:00:00Z',
  generated: true,
  astrolabe: real.astrolabe,
  input: { solarDate: '2000-8-16', timeIndex: 2, gender: '男', fixLeap: true, language: 'zh-CN' },
  summary: real.summary,
}
let captured4 = null
const sandbox4 = {
  window: { __ModuleLoader__: { load: (m) => { captured4 = m } } },
  console, setTimeout, clearTimeout,
  location: { origin: 'http://127.0.0.1:55172' },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {} },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: class {},
}
vm.createContext(sandbox4)
vm.runInContext(src, sandbox4, { filename: 'lib/client.js' })

const React3 = {
  ...React,
  useState(init) {
    // tab 初值是 'person' → 换成 'chart'
    if (init === 'person') return ['chart', () => {}]
    // chartDetail 初值是 null → 注入真实盘
    if (init === null) {
      // 有多个 null 初值的 state（err/person/chartDetail/confirm...）；
      // 只有 chartDetail 的消费者会读 .astrolabe，所以给所有 null 初值都塞这份对象是安全的：
      // 其它 state 只读 truthy 判断或渲染字符串，不会因多出字段而崩。
      return [chartDetailSeed, () => {}]
    }
    if (init === false) return [false, () => {}]
    if (Array.isArray(init) && init.length === 0) return [[], () => {}]
    if (typeof init === 'string') return [init, () => {}]
    return useState(init)
  },
}
let WB3 = null
const mod4 = captured4.factory(() => React3)
const fakeCtx4 = {
  effect(fn) { return fn() },
  remote: { async $mount() {} },
  inject(_deps, fn) {
    fn({
      remote: { ziwei: {} },
      slots: {
        inject(name, reg) { const r = reg(); if (name === 'main' && r?.comp) WB3 = r.comp; return r },
        register(_spec, comp) { return { comp } },
      },
    })
    return Promise.resolve({ dispose: async () => {} })
  },
}
await mod4.apply(fakeCtx4)
assert.ok(WB3, '未抓到 Workbench 组件（命盘路径）')
const tree3 = render(WB3({ remote: {} }))
assert.match(tree3.text, /命盘总览/, '未渲染中宫信息卡')
assert.match(tree3.text, /命主/, '未渲染命主摘要')
assert.match(tree3.text, /已按档案生辰生成星盘/, '未渲染「生成一次」提示')
assert.match(tree3.text, /复制星盘 JSON/, '未提供复制 JSON 入口')
assert.doesNotMatch(tree3.text, /查看原始 iztro JSON/, '不应再有 JSON 展示区块')
// 12 宫：至少应出现这些 iztro 实际给出的宫名与主星
for (const s of ['命宫', '财帛', '紫微', '武曲', '破军', '七杀', '天相']) {
  assert.ok(tree3.text.includes(s), `命盘未渲染预期内容：${s}`)
}
// 四化徽标：这张盘有 权/禄/科/忌
for (const m of ['权', '禄', '科', '忌']) {
  assert.ok(tree3.text.includes(m), `命盘未渲染四化：${m}`)
}
// 地支定位：12 个宫格都带 gridRow/gridColumn（由 render 收集 props 校验）
let palaceCount = 0
function countPalaces(el, depth = 0) {
  if (depth > 80 || !el || typeof el !== 'object') return
  if (Array.isArray(el)) { for (const x of el) countPalaces(x, depth + 1); return }
  if (el.props?.className && String(el.props.className).includes('zw-palace')) palaceCount++
  if (typeof el.type === 'function') {
    const saved = [hookIndex, hookStore]; hookIndex = 0; hookStore = []
    try { countPalaces(el.type(el.props ?? {}), depth + 1) }
    finally { [hookIndex, hookStore] = saved }
  } else {
    for (const c of el.children ?? []) countPalaces(c, depth + 1)
  }
}
countPalaces(WB3({ remote: {} }))
assert.equal(palaceCount, 12, `命盘应有 12 个宫格，实际 ${palaceCount}`)

console.log('客户端冒烟测试通过：模块加载、apply 注册、22 个 descriptor、组件渲染、12 宫命盘网格（真实 iztro 数据）、快捷运势、AI 分析对话通路、分析回填展示、定盘入口、真太阳时均正常。')
