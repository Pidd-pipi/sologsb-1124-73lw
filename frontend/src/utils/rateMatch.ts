/**
 * 资费匹配与欠资核验的纯函数：
 * 按寄出日期、收件地、给据状态选出当期资费，再与封上贴票合计比对。
 * 目录、详情、汇总三处共用同一套结论，保证任何改动后重算结果一致。
 */
import type { Cover } from '@/types/cover'
import type { CoverVerification, RateRule, RuleRegistered } from '@/types/rate'
import { isValidDate } from '@/utils/dateRange'

/** 止用日留空时按该日期处理（沿用至今） */
export const OPEN_END = '9999-12-31'

/** 适用地区填这些词（或留空）时视为通配 */
const WILDCARD_REGIONS = ['', '通用', '全国', '国内', '国内互寄']

/** 参与匹配 / 冲突判断的规则字段子集 */
export type RuleScope = Pick<
  RateRule,
  'effectiveFrom' | 'effectiveTo' | 'region' | 'registered' | 'rate' | 'unit'
>

/** 一封实寄封参与选资费的寄递事实 */
export interface CoverKey {
  postDate: string
  sentTo: string
  registered: boolean
}

function ruleEnd(rule: RuleScope): string {
  return rule.effectiveTo || OPEN_END
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function isWildcardRegion(region: string): boolean {
  return WILDCARD_REGIONS.includes((region || '').trim())
}

/** 规则地区是否覆盖收件地：通配，或字面互相包含（如「上海」覆盖「上海市」） */
export function regionMatches(region: string, sentTo: string): boolean {
  if (isWildcardRegion(region)) return true
  const to = (sentTo || '').trim()
  if (!to) return false
  const r = region.trim()
  return to.includes(r) || r.includes(to)
}

function registeredMatches(scope: RuleRegistered, registered: boolean): boolean {
  if (scope === 'any') return true
  return scope === 'yes' ? registered : !registered
}

/** 规则是否适用于某封的寄递事实（寄出日期落在生效区间内、地区与给据都覆盖） */
export function ruleAppliesTo(rule: RuleScope, key: CoverKey): boolean {
  if (!isValidDate(key.postDate)) return false
  if (key.postDate < rule.effectiveFrom || key.postDate > ruleEnd(rule)) return false
  if (!regionMatches(rule.region, key.sentTo)) return false
  return registeredMatches(rule.registered, key.registered)
}

function regionsOverlap(a: string, b: string): boolean {
  if (isWildcardRegion(a) || isWildcardRegion(b)) return true
  const ra = a.trim()
  const rb = b.trim()
  return ra === rb || ra.includes(rb) || rb.includes(ra)
}

function registeredScopesOverlap(a: RuleRegistered, b: RuleRegistered): boolean {
  return a === 'any' || b === 'any' || a === b
}

function datesOverlap(a: RuleScope, b: RuleScope): boolean {
  return a.effectiveFrom <= ruleEnd(b) && b.effectiveFrom <= ruleEnd(a)
}

/** 两套规则是否构成冲突：日期区间、适用地区、给据状态都重叠且资费互异 */
export function rulesConflict(a: RuleScope, b: RuleScope): boolean {
  if (!datesOverlap(a, b)) return false
  if (!regionsOverlap(a.region, b.region)) return false
  if (!registeredScopesOverlap(a.registered, b.registered)) return false
  return a.rate !== b.rate || a.unit !== b.unit
}

/** 是否重复条目：适用范围重叠且资费一致（导入时跳过，不进清单也不进对账池） */
export function isDuplicateRule(a: RuleScope, b: RuleScope): boolean {
  if (!datesOverlap(a, b)) return false
  if (!regionsOverlap(a.region, b.region)) return false
  if (!registeredScopesOverlap(a.registered, b.registered)) return false
  return a.rate === b.rate && a.unit === b.unit
}

/** 贴票合计（面值 × 枚数累加，按票面所记单位） */
export function frankingValue(cover: Cover): number {
  const total = (cover.franking ?? []).reduce(
    (sum, f) => sum + (Number(f.denomination) || 0) * (Number(f.count) || 0),
    0
  )
  return round2(total)
}

/** 从在效规则中选出当期资费：生效日晚者优先，其次适用地区更具体者 */
export function matchRate(key: CoverKey, activeRules: RateRule[]): RateRule | null {
  const matched = activeRules.filter((r) => ruleAppliesTo(r, key))
  if (!matched.length) return null
  return matched.sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1
    const wa = isWildcardRegion(a.region) ? 0 : 1
    const wb = isWildcardRegion(b.region) ? 0 : 1
    if (wa !== wb) return wb - wa
    return (b.id ?? 0) - (a.id ?? 0)
  })[0]
}

/** 封事实指纹：贴票构成、寄出日期、收件地、给据任一变化即改变，用于结论失效判断 */
export function coverFingerprint(cover: Cover): string {
  const frank = (cover.franking ?? []).map((f) => `${f.denomination}x${f.count}`).join(',')
  return [cover.postDate, cover.sentTo, cover.registered ? 'R' : 'P', frank].join('|')
}

/** 清单版本：在效与待选定规则的内容任一变化即改变 */
export function computeRulesVersion(rules: RateRule[]): string {
  return rules
    .filter((r) => r.status === 'active' || r.status === 'pending')
    .map((r) => `${r.id ?? 0}:${r.status}:${r.updatedAt}`)
    .sort()
    .join('|')
}

/**
 * 逐封核验：寄出日期待考则无法选期；有待选定规则覆盖该封则列待复核；
 * 否则选出当期资费与贴票合计比对，得出相符 / 欠资 / 溢付。
 */
export function verifyCover(
  cover: Cover,
  activeRules: RateRule[],
  pendingRules: RateRule[],
  rulesVersion: string
): CoverVerification {
  const result: CoverVerification = {
    coverId: cover.id ?? 0,
    coverNo: cover.coverNo,
    status: 'unrated',
    ruleId: null,
    ruleNo: '',
    required: null,
    paid: frankingValue(cover),
    diff: null,
    unit: '分',
    fingerprint: coverFingerprint(cover),
    rulesVersion,
    computedAt: ''
  }
  if (!isValidDate(cover.postDate)) {
    result.status = 'nodate'
    return result
  }
  const key: CoverKey = {
    postDate: cover.postDate,
    sentTo: cover.sentTo,
    registered: cover.registered
  }
  // 同一日期区间存在两套规则且尚未选定：该封暂列待复核，不出结论
  if (pendingRules.some((r) => ruleAppliesTo(r, key))) {
    result.status = 'pending'
    return result
  }
  const rule = matchRate(key, activeRules)
  if (!rule) return result
  const diff = round2(result.paid - rule.rate)
  result.status = diff === 0 ? 'exact' : diff < 0 ? 'short' : 'over'
  result.ruleId = rule.id ?? null
  result.ruleNo = rule.ruleNo
  result.required = rule.rate
  result.diff = diff
  result.unit = rule.unit
  return result
}

/** 差额展示：欠 6分 / 溢 2分 / 刚好相符 */
export function diffText(result: Pick<CoverVerification, 'diff' | 'unit'>): string {
  if (result.diff == null) return '—'
  if (result.diff === 0) return '刚好相符'
  return result.diff < 0 ? `欠 ${-result.diff}${result.unit}` : `溢 ${result.diff}${result.unit}`
}

/* ------------------------------ 清单文本解析 ------------------------------ */

/** 解析出的一行资费（尚未入库） */
export interface ParsedRateRow {
  eraName: string
  effectiveFrom: string
  effectiveTo: string
  region: string
  registered: RuleRegistered
  rate: number
  unit: string
  note: string
}

export interface ParseOutcome {
  rows: ParsedRateRow[]
  errors: string[]
  total: number
}

const FIELD_ALIASES: Record<keyof ParsedRateRow, string[]> = {
  eraName: ['eraName', '资费期', '资费期名称', '名称'],
  effectiveFrom: ['effectiveFrom', '生效日', '起始日', '起'],
  effectiveTo: ['effectiveTo', '止用日', '终止日', '止'],
  region: ['region', '适用地区', '地区', '收件地'],
  registered: ['registered', '给据', '给据状态'],
  rate: ['rate', '资费', '费率'],
  unit: ['unit', '单位'],
  note: ['note', '备注']
}

function pickField(obj: Record<string, unknown>, aliases: string[]): unknown {
  for (const key of aliases) {
    if (key in obj) return obj[key]
  }
  return undefined
}

function normalizeRegistered(value: unknown): RuleRegistered | null {
  const text = String(value ?? '').trim()
  if (!text || ['any', '通用', '不限', '均可'].includes(text)) return 'any'
  if (['yes', '给据', '挂号', '是', 'true'].includes(text)) return 'yes'
  if (['no', '平信', '否', 'false'].includes(text)) return 'no'
  return null
}

/** 兼容 1910-6-8 / 1910.6.8 / 1910年6月8日 等写法，统一为 YYYY-MM-DD */
function normalizeDate(value: unknown): string {
  const text = String(value ?? '')
    .trim()
    .replace(/[./]/g, '-')
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (!m) return text
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function toRow(obj: Record<string, unknown>, lineNo: number): { row?: ParsedRateRow; error?: string } {
  const eraName = String(pickField(obj, FIELD_ALIASES.eraName) ?? '').trim()
  const effectiveFrom = normalizeDate(pickField(obj, FIELD_ALIASES.effectiveFrom))
  const effectiveTo = normalizeDate(pickField(obj, FIELD_ALIASES.effectiveTo))
  const region = String(pickField(obj, FIELD_ALIASES.region) ?? '').trim() || '通用'
  const registered = normalizeRegistered(pickField(obj, FIELD_ALIASES.registered))
  const rate = Number(pickField(obj, FIELD_ALIASES.rate))
  const unit = String(pickField(obj, FIELD_ALIASES.unit) ?? '').trim() || '分'
  const note = String(pickField(obj, FIELD_ALIASES.note) ?? '').trim()
  if (!eraName) return { error: `第 ${lineNo} 行：资费期名称缺失` }
  if (!isValidDate(effectiveFrom)) return { error: `第 ${lineNo} 行：生效日「${effectiveFrom}」无效` }
  if (effectiveTo && !isValidDate(effectiveTo)) {
    return { error: `第 ${lineNo} 行：止用日「${effectiveTo}」无效` }
  }
  if (effectiveTo && effectiveTo < effectiveFrom) {
    return { error: `第 ${lineNo} 行：止用日早于生效日` }
  }
  if (registered == null) {
    return { error: `第 ${lineNo} 行：给据状态无法识别（应填 通用 / 给据 / 平信）` }
  }
  if (!Number.isFinite(rate) || rate <= 0) return { error: `第 ${lineNo} 行：资费必须为正数` }
  return {
    row: { eraName, effectiveFrom, effectiveTo, region, registered, rate, unit, note }
  }
}

/** 解析一行 CSV（支持双引号包裹与转义） */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

/**
 * 解析研究会送来的资费清单文本（JSON 数组或带表头的 CSV）。
 * 返回全部行与逐行错误；有任何错误时调用方应整批拒绝，保证清单不被写坏。
 */
export function parseRateList(text: string): ParseOutcome {
  const trimmed = (text || '').trim()
  if (!trimmed) return { rows: [], errors: ['清单内容为空'], total: 0 }
  const objects: Record<string, unknown>[] = []
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const data: unknown = JSON.parse(trimmed)
      const arr = Array.isArray(data) ? data : [data]
      for (const item of arr) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          objects.push(item as Record<string, unknown>)
        } else {
          return { rows: [], errors: ['JSON 清单中存在非对象条目'], total: arr.length }
        }
      }
    } catch (err) {
      return { rows: [], errors: [`JSON 解析失败：${(err as Error).message}`], total: 0 }
    }
  } else {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) {
      return { rows: [], errors: ['CSV 清单至少需要表头与一行数据'], total: lines.length }
    }
    const headers = parseCsvLine(lines[0]).map((h) => h.trim())
    for (let i = 1; i < lines.length; i += 1) {
      const cells = parseCsvLine(lines[i])
      const obj: Record<string, unknown> = {}
      headers.forEach((h, idx) => {
        obj[h] = (cells[idx] ?? '').trim()
      })
      objects.push(obj)
    }
  }
  const rows: ParsedRateRow[] = []
  const errors: string[] = []
  objects.forEach((obj, idx) => {
    const { row, error } = toRow(obj, idx + 1)
    if (row) rows.push(row)
    if (error) errors.push(error)
  })
  return { rows, errors, total: objects.length }
}
