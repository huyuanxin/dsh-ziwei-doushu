# dsh-ziweidoushu · 紫微斗数工作台

DeepSeek Harness 插件：管理人员档案，调用 [iztro](https://www.npmjs.com/package/iztro) 排盘，查看星盘 JSON 与运限查询历史。

## 功能

| 功能 | 说明 |
| --- | --- |
| 人员管理 | 新增人员需填 **姓名 / 性别 / 出生年月日 / 出生时辰**，保存后落盘；支持编辑、删除、二次确认 |
| 农历支持 | 生辰可选 **阳历 / 农历（含闰月）**；表单实时显示阴阳历对照预览，Host 用 `lunar-typescript` 校验闰月与每月天数，排盘走 iztro 原生 `type:'lunar'` + `isLeapMonth` |
| 左右分栏 | **左侧**人员选择列表，**右侧**详情区 |
| 多 Tab 详情 | 右侧详情区用 Tab 分隔：`人员详情` / `星盘信息` / `运限历史` |
| 一人一盘 | 星盘由生辰唯一决定：首次查看时自动生成并落盘，之后复用；**编辑生辰后自动重算**；另有显式「重新生成」入口 |
| 命盘界面 | 4×4 网格 12 宫命盘（按地支定位）：宫名/干支、主星（亮度+四化）、辅星、杂曜、大限/小限、长生十二神；中宫显示四柱、五行局、命主身主、生肖星座等。不展示 JSON 正文，只提供一个「复制星盘 JSON」按钮 |
| 运限历史 | 列表 → 详情两级视图；详情展示 iztro 完整 `horoscope` 的**六层卡片**与对应命盘；不展示 JSON 正文，只提供「复制运限 JSON」按钮。查询时自动使用唯一盘，无需先选盘 |
| 快捷运势 | 一条轻量工具条：**今天 / 明天 / 未来 N 年（1~30）/ 自定义起算日** 四个按钮。**不展示即时结果**，只生成运限历史记录，点下方列表里的记录进详情看内容。**今天/明天按日期唯一去重**（重复点复用旧记录），**未来 N 年每次新建一条 `range` 记录** |
| 运势时间轴 | `range` 记录详情页把每年做成**横向年份 Tab 条**（可平滑横滚，大限切换处有竖分隔，上方分组标题随选中项显示所属大限）。点任意年份 Tab，下方即切换到该年详情卡片：虚岁、代表日期、流年干支/落宫/四化、所属大限（年段/岁段/四化）、流年十二宫重排；当年 Tab 带「今」角标。详情页不展示命盘（命盘只在「星盘信息」Tab） |
| 六层运限 | 详情页把大限/小限/流年/流月/流日/流时做成**分层卡片**：干支大字 + 落宫（`palaceNames[index]`）+ 宫序 + 四化彩色徽标（禄绿/权紫/科青/忌红）+ 虚岁角标，缺数据显示占位而非整片字段行 |
| 点击 AI 分析 | 历史列表每行 + 运限详情页的「✦ 分析」按钮：把**一段约 500 字的任务说明**放进新会话草稿（只建草稿、不自动发送）。**对话里不带任何 JSON 数据**——数据由 Agent 工具 `ziwei_analysis` 现取，返回已排版的人话摘要 |
| 分析回填 | 模型分析完会调 `ziwei_save_analysis` 把结果写回该条记录：详情页显示可折叠的 **AI 分析** 区块（Markdown 轻量渲染 + 复制全文），列表行带 **✎** 标记与摘要。重复分析覆盖正文并累加版本号 |
| 真太阳时 | 新增人员时可勾选「使用真太阳时」并选择出生地区（337 个城市，含经纬度）。按 **真太阳时 = 北京时间 + (经度−120°)×4 分钟 + 均时差 EoT** 校正，**同时调整日期与时辰**（乌鲁木齐可能退到前一天）。界面明示「填写值 → 校正值」与两项修正各占多少；档案同时保留填写值和校正值 |
| 技能包 | 把 `learn/` 讲义生成成 DSH 技能 `ziwei-doushu`：**SKILL.md 只放方法论骨架**（约 3 千字符），11 个 `reference/*.md` 按需读取。模型需要解盘时才加载，不写进每次分析的提示词 |

## 技术结构

```
package.json          插件清单（dsh.bundle.patch / dsh.client.platform）
cordis.patch.yml      Host 插件行 + 默认配置（dataDir / language / fixLeap）
icon.svg / locale/    侧栏图标与多语言元数据
lib/
  index.js            Host 服务 ZiweiWorkbench：Config schema、18 个 Remote 方法、Cordis apply
  analysis.js         解盘资料渲染：十二宫行、六层运限、逐年时间轴、对话提示词
  solar-time.js       真太阳时：EoT 双正弦近似、经度修正、时刻↔时辰、跨日处理
  regions.js          地区与经纬度（读 data/regions.json）
data/regions.json     31 省 / 337 市 + 经纬度（静态数据，来源见「真太阳时」节）
  store.js            持久化：原子写 + 串行写队列 + profile/DSH_HOME/cwd 多候选目录
  chart.js            iztro 封装：输入校验、toJSON 盘面、horoscope 运限、历法换算、未来运势、13 时辰表
  model.js            一人一盘数据模型：get-or-create 语义、显式 force 重新生成
  tools.js            Agent 工具：ziwei_query / ziwei_chart / ziwei_people
  skills.js           SkillProvider：把 skills/ 挂进 ctx.skills（插件内置技能来源）
  client.js           浏览器半区：React 组件 + Remote 描述符 + 侧栏/主面板槽位
skills/ziwei-doushu/  技能包产物（SKILL.md + reference/*.md，由 learn/ 生成）
learn/                原始讲义（VitePress 站点源，仅供查阅，不再参与构建）
test/run.mjs          140 项断言的端到端冒烟测试（临时目录，不污染用户数据）
test/skills.mjs       123 项：frontmatter 契约、文件完整性、provider 契约、体积预算
```

### 数据目录

`<profile>/ziwei-doushu/`（无数据时回退 `DSH_HOME` → cwd），可用环境变量
`DSH_ZIWEI_DOUSHU_DIR` 覆盖。文件：

```
people.json
<personId>/
  person.json        人员档案
  charts.json        唯一星盘（含完整 astrolabe JSON，最多一项）
  horoscopes.json    运限查询历史（含完整 horoscope JSON）
```

### iztro 调用（阳历 / 农历）

```js
import { astro } from 'iztro'

// 阳历
const a = astro.withOptions({
  dateStr: '2000-8-16', type: 'solar',
  timeIndex: 2,            // 0=早子时 … 12=晚子时
  gender: '男', fixLeap: true, language: 'zh-CN',
})

// 农历（含闰月）：走 iztro 原生 lunar 入口，不先转阳历
const b = astro.withOptions({
  dateStr: '2023-2-15', type: 'lunar', isLeapMonth: true,
  timeIndex: 2, gender: '女', fixLeap: true, language: 'zh-CN',
})
// b.solarDate === '2023-4-5'

const chartJson = a.toJSON()                  // 12 宫 / 星曜 / 四化 …
const horoscopeJson = a.horoscope('2026-3-1', 6).toJSON()
```

- 用 `withOptions` 而不是 `bySolar`：把语言、闰月、历法配置绑在单张盘上，
  避免全局 `astro.config()` 在多人并发排盘时串味。
- 农历合法性（该年是否有此闰月、该月天数）在 Host 用 `lunar-typescript`
  预先校验，报错给可读中文；`convertDate` 负责阴阳历换算与展示文案。

### 未来运势快捷查看

`getFortune` 组合 iztro 的三组**官方 API**（都是星盘实例方法，`toJSON()` 后不存在，
所以用已存的排盘输入 `withOptions` 重建实例）：

- `horoscope(date)` — 起算日的六层运限快照（大限/小限/流年/流月/流日/流时）
- `decadalList()` — 12 个大限（**起运顺序**，带 `yearRange`，农历年口径）
- `yearlyList(i)` — 第 i 个大限那 10 年的**逐年流年**（库内部自选农历六月初一作代表日）

逐年数据**全部取自 `yearlyList()`**，不自己造代表日。两个容易踩的口径：

- **斗数的"年"是农历年**。时间轴按农历年枚举（起算日的农历年往后取 N 年），
  年份匹配也用农历年。若改用「阳历周年日」当代表日，起算日落在阳历 1~2 月中
  （农历新年前）时会**整整漏掉一年**——已实测复现并加回归测试。
- 大限归属按 `yearRange` 覆盖匹配，而不是 `horoscope().decadal.index`——后者是
  **宫位 index**，与 `decadalList()` 的起运序号不是一回事（逆行盘会对不上）。
- 历法换算与代表日走 `lunar-lite` 的 `lunar2solar` / `solar2lunar`（iztro 自己调用的
  历法层），中文月/日名用 `LunarUtil.MONTH` / `LunarUtil.DAY`。

`preset`: `today` / `tomorrow` / `nYears` / `custom`；`years` 为 1~30（默认 10），
时间轴含当年共 `years+1` 项。

**记录语义**：`getFortune` 会落库一条运限历史记录，`record.kind` 区分三类：

| kind | 触发 | 去重 | 详情 |
| --- | --- | --- | --- |
| `daily` | 今天 / 明天 | 按 `(personId, kind='daily', targetDate)` 唯一，重复点复用旧记录（`deduplicated=true`） | 起算日六层运限 JSON + 命盘 |
| `range` | 未来 N 年 / 自定义日 | 每次新建 | 完整 `fortune` 时间轴（点历史列表进入） + 六层运限 JSON + 命盘 |
| `manual` | 手动「新增运限查询」 | 不去重 | 原六层运限 JSON + 命盘 |

`getHoroscope` 对 `range` 记录额外返回 `fortune` 字段；列表记录带
`kind` / `years` / `scopeLabel` / `deduplicated` 供 UI 分类显示。

### 点击 AI 分析：对话放任务，数据走工具

点「✦ 分析」时 UI 调 `buildAnalysisContext({ personId, horoscopeId })`，
拿到的 `starterPrompt` 只有 **约 500 字**：一句任务说明 + 两个 id + 分析要求。
然后通过 `ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })`
放进**新会话草稿**（只建草稿、不自动发送）。

**关键：提示词里没有任何数据。** 模型拿到草稿后会先调 `ziwei_analysis`：

```
ziwei_analysis({ personId, horoscopeId })
```

它返回**已经排版好的人话摘要**（`lib/analysis.js` 的 `renderAnalysisBrief`）：

| 段 | 内容 |
| --- | --- |
| 命主 | 姓名/性别/阳历生辰/时辰/农历/四柱/五行局/命主身主 |
| 本命十二宫 | 每宫一行：`宫名 干支｜主:天机[得] 太阴[旺科]｜辅:｜杂:｜大限5-14` |
| 本次记录 | 类型（daily/range/manual）、目标日期、覆盖范围 |
| 起算日六层运限 | `大限 丁亥 · 命宫在亥（本命子女宫位）· 四化 …` |
| 逐年时间轴 | 仅 range 记录：`2026 丙午 37岁 流年命宫在午(本命官禄宫) 大限… 四化…` |

### 为什么不让模型读 JSON

| 方式 | 30 年记录的数据量 |
| --- | --- |
| 完整 JSON 写进提示词 | ~43,600 字符 |
| 工具返回人话摘要 | ~1,600 字符 |

除了体积，还有两个更重要的理由：

1. **模型不用解析嵌套数组**。`palaces[i].majorStars[j].brightness` 这种结构要模型自己
   遍历；摘要里已经摊平成 `天机[得] 太阴[旺科]`，直接可读。
2. **数据永远是最新的**。提示词是点击那一刻的快照，工具是实时读库。

### 真太阳时

紫微斗数传统按**当地真太阳时**定时辰，而用户报的是北京时间（东八区标准时，
以东经 120° 为准）。两者有两处系统偏差：

| 偏差 | 来源 | 量级 |
| --- | --- | --- |
| 经度差 | 每偏离 120° 一度差 4 分钟 | 乌鲁木齐 −129.5 分（跨两个时辰） |
| 均时差 EoT | 地球轨道偏心 + 黄赤交角 | 全年 −14.4 ~ +16.5 分 |

```
真太阳时 = 北京时间 + (当地经度 − 120°) × 4 分钟 + EoT(当天)
```

EoT 用双正弦近似（严格按给定规格实现，不改常数、不做角度转换）：

```
D   = 6.24004077 + 0.01720197 × (365.25 × (year − 2000) + dayOfYear)
EoT = −7.659·sin(D) + 9.863·sin(2D + 3.5932)      单位：分钟
```

校验：`EoT(2026, 32) ≈ −13.49`、`EoT(2026, 315) ≈ 15.73`（规格样例 −13.5 / 15.8）。

**两项必须都算。** 11 月中旬北京：经度修正 −14.35 分，但 EoT 是 +15.73 分，
净效果反而略晚。只看经度会算错方向。

**跨日是真问题。** 乌鲁木齐 00:30 校正后是**前一天 22:36**——时辰从早子时
变成亥时，**日期必须一起退一天**，否则农历月都可能算错。`computeTrueSolarTime`
返回 `dayShift` 明确给出偏移，`resolvePersonBirth` 据此改写排盘用的
`birthDate` 与 `timeIndex`。

基准时刻的取法（两者都支持）：

- 填了 `birthClock`（HH:MM）→ 用精确时刻，分钟级校正；
- 没填 → 用所选时辰的**区间中点**（早子时 00:30、丑时 02:00…），
  并在界面标注「按时辰中点推定」。

**填写值与校正值都保留**：档案里存用户报的 `birthDate`/`birthTimeIndex`/
`birthClock`/`regionName`，`personView().solar` 另给一份校正结果
（`trueSolar` / `correction` / `timeIndexChanged` / `dateChanged`），
界面对照展示。排盘只用校正后的值。

#### 完整公式与实现

```
输入：北京时间（阳历日期 + 时刻 HH:MM 或时辰中点）、出生地经度、当日年积日

步骤 1  经度修正（分钟）
        lngMin = (经度 − 120) × 4
        · 120° 是东八区标准经线
        · 每偏离 1° = 4 分钟（地球 4 分钟转 1°）
        · 东经 >120° 为正（当地更早），<120° 为负

步骤 2  均时差 EoT（分钟）
        D   = 6.24004077 + 0.01720197 × (365.25 × (year − 2000) + dayOfYear)
        EoT = −7.659·sin(D) + 9.863·sin(2D + 3.5932)

        · D 已是**弧度**，直接传 Math.sin，不要转角度、不要取模
        · dayOfYear：1 月 1 日 = 1；平年 1..365，闰年 1..366
        · 闰年：year % 4 == 0 且 (year % 100 != 0 或 year % 400 == 0)
        · 返回值不四舍五入，浮点分钟由调用方决定显示精度

步骤 3  合成
        真太阳时 = 北京时间 + lngMin + EoT

步骤 4  跨日归一
        若合成结果 < 0 或 ≥ 1440，按 1440 分钟取模并给出 dayShift = −1 / 0 / +1；
        日期必须同步 ±1 天，否则农历月会算错。

步骤 5  定时辰
        由校正后的分钟数映射到 0~12：
        00:00~00:59 → 0（早子时，仅 1 小时）
        01:00~22:59 → 每 2 小时一档，1（丑）… 11（亥）
        23:00~23:59 → 12（晚子时，仅 1 小时）
```

校验（规格给定的两组样例，误差 < 0.5 分钟）：

| 日期 | year | dayOfYear | 期望 EoT | 实测 |
| --- | ---: | ---: | ---: | ---: |
| 2026-02-01 | 2026 | 32 | ≈ −13.5 分 | **−13.4920** |
| 2026-11-11 | 2026 | 315 | ≈ +15.8 分 | **+15.7259** |

#### 数据来源与已知缺口

**数据来源**：省市县行政区划与经纬度取自开源项目
[**dingyong0214/city-data**](https://github.com/dingyong0214/city-data)。

上游项目的两张表（省市区树 + 城市经纬度）已在构建期合并、精简，
结果签入 `data/regions.json`（31 省 / **337 市**），**这就是运行期的
唯一数据文件**：

```json
{ "source": [...], "attribution": "https://github.com/dingyong0214/city-data",
  "matched": 337, "skipped": [...], "provinces": [...] }
```

只保留真太阳时需要的字段（省名 / 市名 / 行政编码 / 经纬度），剔除区县层级。

**不再随仓库保留上游原始文件。** 原因：运行期从未加载它们；本包是 ESM
（`"type": "module"`）而它们是 `module.exports = [...]` 的 CommonJS，
每次合并还得靠 `vm` 包装求值；合并结果已核对，源表不再有信息增量。

需要更新地区数据时，重新从上游取表，按 `data/regions.json` 的字段结构合并即可
（`provinces[].name` / `cities[].name|code|lng|lat`，`skipped` 记缺口）。

**已知缺口（重要，请按需处理）**

上游的省市区树里有 4 个「**省直辖行政单位**」节点，其下 **29 个县级市/县**
在上游城市经纬度表里**没有坐标**，因此无法纳入 `data/regions.json`：

| 省份 | 未收录的下辖城市/县（29 个） |
| --- | --- |
| 河南省 | 济源市 |
| 湖北省 | 仙桃市、潜江市、天门市、神农架林区 |
| 海南省 | 五指山市、琼海市、文昌市、万宁市、东方市、定安县、屯昌县、澄迈县、临高县、白沙黎族自治县、昌江黎族自治县、乐东黎族自治县、陵水黎族自治县、保亭黎族苗族自治县、琼中黎族苗族自治县 |
| 新疆维吾尔自治区 | 石河子市、阿拉尔市、图木舒克市、五家渠市、北屯市、铁门关市、双河市、可克达拉市、昆玉市 |

**这不是「非实体条目」——它们都是真实的出生地。** 之所以跳过，纯粹是因为
两份源表在这 29 项上不匹配。

**影响评估**：

- 这 29 个地方的经度从 **79.07°（昆玉市）到 113.60°（济源市）**，
  对应经度修正 **−164 ~ −26 分钟**。忽略真太阳时会让时辰最多偏 1.4 个时辰。
- 若用户改选邻近城市，误差量级：石河子市（86.04°）填成乌鲁木齐市（87.62°）
  差 **6.3 分钟**——占一个时辰（120 分钟）的 5.3%，通常不改变时辰。
  但**阿拉尔市（81.28°）与乌鲁木齐差 25 分钟**，就可能在边界上翻档。

**当前处理方式与风险提示**：

1. 这 29 个地方**不会出现在地区下拉里**。用户看不到、也选不到。
2. 若用户出生地在其中，只能选邻近城市（一般够用，但边界时辰可能不准），
   或者**不勾选真太阳时**（等于按北京时间定时辰）。
3. 界面不做特殊提示——因为插件无从判断「用户是不是住在这 29 个地方」。
   **这是已知限制，不是 bug。** 若需要覆盖，直接往 `data/regions.json`
   的对应省份 `cities` 里补一条 `{name, code, lng, lat}` 并同步清理
   `skipped` 中对应条目即可，**无需改任何代码**。

> 数据仅供紫微斗数定时辰参考，不作为地理/测量用途。若与官方行政区划或
> 实际坐标有出入，以官方数据为准。

缺口的可追溯性：`data/regions.json` 的 `skipped` 字段保留来源节点与下辖地名，
`listRegions()` 返回 `attribution`（来源署名）与 `missing`（29 个缺坐标地名），
`diagnostics.regions.missingCities` 给出数量。`test/run.mjs` 有断言锁住这些，
避免以后改数据时又静默丢失。

### 分析回填

模型分析完会调用 `ziwei_save_analysis` 把结果写回记录：

```
ziwei_save_analysis({
  personId, horoscopeId,
  content: "<完整分析 Markdown>",
  summary: "<100 字内摘要>",
  confirm: true
})
```

记录上新增可选字段 `analysis`：

| 字段 | 说明 |
| --- | --- |
| `content` | 完整分析正文（Markdown），上限 60000 字符 |
| `summary` | ≤200 字摘要，列表展示用；不传则从正文自动截取前 100 字 |
| `createdAt` / `updatedAt` | 首次回填时间 / 最近一次回填时间 |
| `revisions` | 回填次数，重复分析会覆盖正文并累加 |

**为什么只留最新一版**：运限记录是「一次查询的快照」，分析是对它的解读。
用户重跑分析通常是想换个说法，保留多版反而难找；`revisions` 计数让人知道
被覆盖过。

界面上：详情页显示可折叠的「AI 分析」区块（标题/列表/分隔线做轻量 Markdown
渲染，正文原样保留），列表行显示摘要并带 **✎** 标记。回填**不改动**记录里的
星盘与运限数据——那是不可重算的历史快照。

### 落宫为什么显示地支而不显示「命宫」

`palaceNames[index] === '命宫'` 是 iztro 的**不变量**（每层都成立），
只显示它等于没信息。摘要里换算成「这个槽位是哪个地支 + 该地支在本命盘上是哪一宫」，
这才是解读要用的：

```
流年 · 丙午 · 命宫在午（本命官禄宫位）· 四化 天同/天机/文昌/廉贞
```

`test/run.mjs` 里有断言守住这条不变量（六层 × 12 宫唯一），换算错了会直接失败。

### 技能包（learn/ → DSH Skill）

`learn/` 是 17 篇原始讲义（222,576 字符 / 115,726 汉字）。整包塞进提示词会占满
上下文且信噪比极低，所以转成 DSH 技能，**按需加载**：

```
skills/ziwei-doushu/
├── SKILL.md            方法论骨架（约 3 千字符）
└── reference/*.md      11 篇参考资料
```

从 `learn/` 一次性整理而来，转换做了这些事：

| 处理 | 原因 |
| --- | --- |
| 剥离 frontmatter / `:::tip` 容器 / `<Badge>` / 相对链接 / 图片 | 站点排版对模型是纯噪音 |
| `<table class="astrolabe">` 示意图 → 一行「地支宫名：星曜」 | 原占 `pattern.md` 65.6% 字符，转换后降到 9% |
| `<table class="star-card">` 键值卡 → `- 键：值` 列表 | 同上 |
| 古籍只留**篇目索引**，不注入正文 | 原书论断夸张、自相矛盾，易被当权威引用 |
| 按「一次分析需要多少」重新切分 | SKILL.md 约 3 千字符，其余按需读 |

注册方式（`lib/skills.js` → `lib/index.js`）：

```js
ctx.inject(['skills'], (skillCtx) => {
  const dispose = registerSkills(skillCtx)   // ctx.skills.registerProvider
  skillCtx.effect(() => dispose, 'ziwei:skills')
})
```

`rank = 550`：低于官方 bundled（600）和项目/用户目录（100~500），所以用户可在
`~/.dsh/skills/` 放同名技能覆盖它；`resourceBase` 指向技能目录，模型按
`SKILL.md` 里的索引用相对路径读 `reference/*.md`。

`skills/` 是**手写维护的正文**，与 `learn/` 没有构建关系：`learn/` 保留为原始
讲义备查，两者此后各自独立演进。改技能内容直接编辑 `skills/` 下的文件即可。

### Remote 契约

Host 的 `REMOTE_METHODS` 与 `lib/client.js` 的 `CONTRIBUTION.descriptors`
**顺序完全一致**（22 个，末尾依次是 `convertDate`、`getFortune`、
`buildAnalysisContext`、`getAnalysisBrief`、`saveAnalysis`、`listTimeCandidates`、
`listRegions`、`previewTrueSolarTime`）。除 `diagnostics`、`listRegions` 两个
无参端点外，所有方法形参名均为 `request`，descriptor 的 wire 名也必须是
`request`。

## 开发

```bash
npm install iztro      # 用户指定的安装方式
npm test               # 5 组测试：host / contract / client / scopes / skills
```

插件通过 profile 的 `package.json` 以 `link:` 引入（与 dsh-bid-workbench 相同）：

```json
"dsh-ziweidoushu": "link:C:/code/my/dsh-ziwei-doushu"
```

并把包名加进 `dsh.profile.bundles`。修改 `lib/client.js` 后，若客户端 HMR 未生效，
需刷新浏览器页面；Host 侧改动由 DSH 的 HMR 自动重载。
