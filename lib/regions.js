/**
 * 地区与经纬度。
 *
 * 数据来源：开源项目 https://github.com/dingyong0214/city-data
 * 该项目的省市县树与城市经纬度两张表已于构建期合并、精简
 * （只保留真太阳时需要的 名称/编码/经纬度，剔除区县层级），
 * 结果签入 `data/regions.json` 作为本插件的静态数据。
 *
 * 为什么不再保留原始两份 CommonJS 表：
 *   · 运行期只读 `data/regions.json`，源表从未被加载过；
 *   · 本包是 ESM（`type: module`），那两份 `module.exports = [...]` 无法
 *     直接 import，每次合并还得靠 vm 包装求值；
 *   · 合并结果已核对（337 市 / 31 省 / 29 个缺坐标缺口），源表不再有信息增量。
 *
 * 数据是静态的：`data/regions.json` 就是事实来源。若将来需要更新，
 * 重新从上游取表、按同样字段合并即可（README 有字段说明与缺口清单）。
 *
 * 已知缺口：省直辖行政单位（河南/湖北/海南/新疆）下挂的 29 个县级市/县
 * 在上游经纬度表里没有坐标——**它们是真实出生地，只是源数据缺这几条**。
 * 缺失清单存在 `data/regions.json` 的 `skipped` 字段里，可追溯。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 数据文件路径。 */
const REGIONS_PATH = fileURLToPath(new URL('../data/regions.json', import.meta.url))

/** @type {{provinces: Array<{name:string, cities: Array<{name:string, code:number, lng:number, lat:number}>}>} | null} */
let CACHE = null

/** 扁平索引：城市名 → { province, name, code, lng, lat }。 */
let BY_NAME = null

/** 读一次，之后复用（地区数据是静态的）。 */
function load() {
  if (CACHE) return CACHE
  try {
    CACHE = JSON.parse(readFileSync(REGIONS_PATH, 'utf8'))
  } catch {
    CACHE = { provinces: [], matched: 0 }
  }
  BY_NAME = new Map()
  for (const p of CACHE.provinces ?? []) {
    for (const c of p.cities ?? []) {
      // 同名城市理论上可能出现（如「市辖区」），保留第一个即可。
      if (!BY_NAME.has(c.name)) BY_NAME.set(c.name, { ...c, province: p.name })
    }
  }
  return CACHE
}

/**
 * 全部省份（含其城市）。UI 的地区选择器用这个。
 *
 * 同时返回 `attribution` 与 `missing`：数据来源要标明，
 * 已知缺口也要如实带出去，避免使用者以为这就是全量。
 */
export function listRegions() {
  const d = load()
  const missing = (d.skipped ?? []).flatMap((x) =>
    (x.cities ?? []).map((name) => ({ province: x.province, name })))
  return {
    ok: true,
    provinces: (d.provinces ?? []).map((p) => ({
      name: p.name,
      cities: (p.cities ?? []).map((c) => ({ name: c.name, code: c.code, lng: c.lng, lat: c.lat })),
    })),
    cityCount: d.matched ?? 0,
    attribution: d.attribution ?? '',
    /** 经纬度源表缺坐标、因此选不到的地名（当前 29 个县级市/县）。 */
    missing,
  }
}

/**
 * 按城市名查经纬度。
 *
 * @param {string} name 城市名，如「北京市」「乌鲁木齐市」
 * @returns {{ok:true, region:{name,province,code,lng,lat}} | {ok:false,error:object}}
 */
export function findRegion(name) {
  load()
  const key = String(name ?? '').trim()
  if (!key) {
    return { ok: false, error: { code: 'ziwei/invalid-region', message: '请选择地区' } }
  }
  const hit = BY_NAME.get(key)
  if (!hit) {
    return { ok: false, error: { code: 'ziwei/region-not-found', message: '未找到该地区：' + key } }
  }
  return { ok: true, region: { ...hit } }
}

/** 地区数据是否可用（文件缺失时插件其余功能不受影响）。 */
export function regionsAvailable() {
  const d = load()
  return (d.provinces?.length ?? 0) > 0
}

/** 给 diagnostics 用的摘要。 */
export function describeRegions() {
  const d = load()
  const missing = (d.skipped ?? []).reduce((a, x) => a + (x.cities?.length ?? 0), 0)
  return {
    available: regionsAvailable(),
    provinces: d.provinces?.length ?? 0,
    cities: d.matched ?? 0,
    /** 经纬度源表缺坐标的地名数量（不静默隐藏）。 */
    missingCities: missing,
    attribution: d.attribution ?? '',
  }
}
