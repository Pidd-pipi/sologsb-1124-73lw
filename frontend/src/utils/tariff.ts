/**
 * 资费核验的纯逻辑：贴票合计、当期资费选定、冲突检测、导入解析与对账。
 * 不依赖 Vue / Pinia，可被 store、hook 与页面复用。
 */
import type { Cover } from '@/types/cover'
import type {
  ConflictGroup,
  PendingImport,
  RegisteredScope,
  TariffBatch,
  TariffRule,
  VerifyResult
} from '@/types/tariff'
import { isValidDate, compareDate } from './dateRange'
import { nextSerialNo } from './id'

/** 保留两位小数，避免浮点误差 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** 贴票合计（元）：Σ 面值 × 枚数 */
export function stampTotalOf(cover: Cover): number {
  return round2(
    cover.franking.reduce(
      (sum, f) => sum + (Number(f.denomination) || 0) * (Number(f.count) || 0),
      0
    )
  )
}

/** 规则在指定日期是否有效（effectiveFrom <= date <= effectiveTo） */
export function ruleIsActiveOn(rule: TariffRule, date: string): boolean {
  if (!isValidDate(date)) return false
  if (rule.effectiveFrom && compareDate(date, rule.effectiveFrom) < 0) return false
  if (rule.effectiveTo && compareDate(date, rule.effectiveTo) > 0) return false
  return true
}

/** 规则是否适用于该收件地（地区名互相包含） */
export function ruleMatchesRegion(rule: TariffRule, region: string): boolean {
  const target = (region || '').trim()
  if (!target) return false
  return rule.regions.some((r) => {
    const name = r.trim()
    return name && (target.includes(name) || name.includes(target))
  })
}

/** 规则是否适用于该给据状态 */
export function ruleMatchesRegistered(rule: TariffRule, registered: boolean): boolean {
  if (rule.registeredScope == null) return true
  return rule.registeredScope === registered
}

/** 选出当期资费规则：返回命中的规则与全部候选 */
export function selectTariff(
  cover: Cover,
  rules: TariffRule[]
): { rule: TariffRule | null; candidates: TariffRule[] } {
  const candidates = rules.filter(
    (r) =>
      ruleIsActiveOn(r, cover.postDate) &&
      ruleMatchesRegion(r, cover.sentTo) &&
      ruleMatchesRegistered(r, cover.registered)
  )
  if (candidates.length === 0) return { rule: null, candidates: [] }
  if (candidates.length === 1) return { rule: candidates[0], candidates }
  // 多条候选：取生效日最晚者（最新规则优先）
  const sorted = [...candidates].sort((a, b) => compareDate(b.effectiveFrom, a.effectiveFrom))
  return { rule: sorted[0], candidates }
}

/** 单封核验 */
export function verifyCover(cover: Cover, rules: TariffRule[]): VerifyResult {
  const stampTotal = stampTotalOf(cover)
  const base: VerifyResult = {
    status: 'pending',
    stampTotal,
    tariff: null,
    shortfall: 0,
    rule: null,
    reason: '',
    conflicts: []
  }
  if (!cover.postDate || !isValidDate(cover.postDate)) {
    return { ...base, reason: '寄出日期缺失，无法选定资费' }
  }
  if (!cover.sentTo.trim()) {
    return { ...base, reason: '收件地缺失，无法选定资费' }
  }
  const { rule, candidates } = selectTariff(cover, rules)
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'pending',
      reason: '存在多条冲突资费规则，待对账选定',
      conflicts: candidates
    }
  }
  if (!rule) {
    return { ...base, status: 'notariff', reason: '未找到适用的资费规则' }
  }
  const tariff = rule.fee
  if (stampTotal < tariff) {
    return {
      ...base,
      status: 'underpaid',
      tariff,
      shortfall: round2(tariff - stampTotal),
      rule,
      reason: '贴票不足，欠资'
    }
  }
  if (stampTotal > tariff) {
    return { ...base, status: 'overpaid', tariff, rule, reason: '贴票逾额，溢贴' }
  }
  return { ...base, status: 'matched', tariff, rule, reason: '资费相符' }
}

/* ------------------------------ 冲突检测 ------------------------------ */

/** 两条规则在日期区间上是否重叠 */
function dateRangesOverlap(a: TariffRule, b: TariffRule): boolean {
  const aEnd = a.effectiveTo || '9999-12-31'
  const bEnd = b.effectiveTo || '9999-12-31'
  return compareDate(a.effectiveFrom, bEnd) <= 0 && compareDate(b.effectiveFrom, aEnd) <= 0
}

/** 两条规则在适用地区上是否重叠 */
function regionsOverlap(a: TariffRule, b: TariffRule): boolean {
  if (!a.regions.length || !b.regions.length) return true
  return a.regions.some((ar) =>
    b.regions.some((br) => {
      const x = ar.trim()
      const y = br.trim()
      return x === y || x.includes(y) || y.includes(x)
    })
  )
}

/** 两条规则在给据状态上是否重叠 */
function registeredOverlap(a: TariffRule, b: TariffRule): boolean {
  if (a.registeredScope == null || b.registeredScope == null) return true
  return a.registeredScope === b.registeredScope
}

/** 两条规则是否冲突（日期、地区、给据三维度均重叠） */
export function rulesConflict(a: TariffRule, b: TariffRule): boolean {
  if (a.id != null && b.id != null && a.id === b.id) return false
  return dateRangesOverlap(a, b) && regionsOverlap(a, b) && registeredOverlap(a, b)
}

/** 检测导入冲突：新规则与库内规则、新规则两两之间的冲突 */
export function detectConflicts(
  newRules: TariffRule[],
  existingRules: TariffRule[],
  covers: Cover[]
): ConflictGroup[] {
  const groups: ConflictGroup[] = []
  const seen = new Set<string>()
  const push = (
    existing: TariffRule | null,
    incoming: TariffRule,
    kind: 'existing' | 'incoming'
  ): void => {
    const key = `${kind}:${existing?.id ?? 'new'}:${incoming.ruleNo || incoming.effectiveFrom}`
    if (seen.has(key)) return
    seen.add(key)
    const coverIds = covers
      .filter((c) => {
        if (!isValidDate(c.postDate) || !c.sentTo.trim()) return false
        if (!ruleIsActiveOn(incoming, c.postDate)) return false
        if (!ruleMatchesRegion(incoming, c.sentTo)) return false
        if (!ruleMatchesRegistered(incoming, c.registered)) return false
        if (existing) {
          if (!ruleIsActiveOn(existing, c.postDate)) return false
          if (!ruleMatchesRegion(existing, c.sentTo)) return false
          if (!ruleMatchesRegistered(existing, c.registered)) return false
        }
        return true
      })
      .map((c) => c.id)
      .filter((id): id is number => typeof id === 'number')
    groups.push({ key, existing, incoming, kind, coverIds })
  }
  for (const nr of newRules) {
    for (const er of existingRules) {
      if (rulesConflict(nr, er)) push(er, nr, 'existing')
    }
  }
  for (let i = 0; i < newRules.length; i += 1) {
    for (let j = i + 1; j < newRules.length; j += 1) {
      if (rulesConflict(newRules[i], newRules[j])) push(null, newRules[j], 'incoming')
    }
  }
  return groups
}

/** 根据对账选择，计算最终写入的新规则与需删除的库内规则 */
export function resolveImport(pending: PendingImport): {
  toAdd: TariffRule[]
  toDeleteExisting: number[]
} {
  const toAdd: TariffRule[] = []
  const toDeleteExisting: number[] = []
  const droppedIncoming = new Set<string>()
  for (const g of pending.conflicts) {
    const choice = pending.choices[g.key] ?? 'existing'
    if (choice === 'existing') {
      // 保留现有规则，丢弃新规则
      droppedIncoming.add(g.incoming.ruleNo || g.incoming.effectiveFrom)
    } else {
      // 采用新规则：库内规则让位
      if (g.existing && typeof g.existing.id === 'number') {
        toDeleteExisting.push(g.existing.id)
      }
    }
  }
  for (const nr of pending.newRules) {
    const key = nr.ruleNo || nr.effectiveFrom
    if (!droppedIncoming.has(key)) toAdd.push(nr)
  }
  return { toAdd, toDeleteExisting }
}

/* ------------------------------ 批次号 ------------------------------ */

/** 生成导入批次号，如 ZF-20261004-001 */
export function nextBatchNo(existing: TariffBatch[]): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `ZF-${today}-`
  let max = 0
  for (const b of existing) {
    if (b.batchNo.startsWith(prefix)) {
      const n = Number.parseInt(b.batchNo.slice(prefix.length), 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

/* ------------------------------ 导入解析 ------------------------------ */

/** 把原始对象数组规范化为资费规则；返回错误信息（首条） */
function normalizeRules(raw: unknown[]): { rules: TariffRule[]; error: string } {
  const rules: TariffRule[] = []
  const errors: string[] = []
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      errors.push(`第 ${i + 1} 行不是有效对象`)
      return
    }
    const r = item as Record<string, unknown>
    const effectiveFrom = String(r.effectiveFrom ?? '').trim()
    const effectiveTo = String(r.effectiveTo ?? '').trim()
    if (!isValidDate(effectiveFrom)) {
      errors.push(`第 ${i + 1} 行生效日期无效：${effectiveFrom}`)
      return
    }
    if (effectiveTo && !isValidDate(effectiveTo)) {
      errors.push(`第 ${i + 1} 行失效日期无效：${effectiveTo}`)
      return
    }
    if (effectiveTo && compareDate(effectiveFrom, effectiveTo) > 0) {
      errors.push(`第 ${i + 1} 行生效日晚于失效日`)
      return
    }
    let regions: string[] = []
    if (Array.isArray(r.regions)) {
      regions = r.regions.map((x) => String(x).trim()).filter(Boolean)
    } else if (typeof r.regions === 'string') {
      regions = r.regions
        .split(/[;；、]/)
        .map((x) => x.trim())
        .filter(Boolean)
    }
    if (!regions.length) {
      errors.push(`第 ${i + 1} 行缺少适用地区`)
      return
    }
    let registeredScope: RegisteredScope = null
    const rs = r.registeredScope
    if (rs === true || rs === 'true' || rs === '给据' || rs === '是') registeredScope = true
    else if (rs === false || rs === 'false' || rs === '平信' || rs === '否') registeredScope = false
    const fee = Number(r.fee)
    if (!Number.isFinite(fee) || fee < 0) {
      errors.push(`第 ${i + 1} 行资费无效：${String(r.fee)}`)
      return
    }
    rules.push({
      ruleNo: String(r.ruleNo ?? '').trim(),
      effectiveFrom,
      effectiveTo,
      regions,
      registeredScope,
      fee: round2(fee),
      batchNo: '',
      note: String(r.note ?? '').trim(),
      createdAt: '',
      updatedAt: ''
    })
  })
  if (errors.length) return { rules: [], error: errors.join('；') }
  return { rules, error: '' }
}

function parseJson(text: string): { rules: TariffRule[]; source: string; error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { rules: [], source: '', error: `JSON 解析失败：${(e as Error).message}` }
  }
  let rawRules: unknown[] = []
  let source = ''
  if (Array.isArray(data)) {
    rawRules = data
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.rules)) rawRules = obj.rules as unknown[]
    else if (Array.isArray(obj.tariffs)) rawRules = obj.tariffs as unknown[]
    if (typeof obj.source === 'string') source = obj.source
    else if (typeof obj.note === 'string') source = obj.note
  }
  const { rules, error } = normalizeRules(rawRules)
  return { rules, source, error }
}

function parseCsv(text: string): { rules: TariffRule[]; source: string; error: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { rules: [], source: '', error: 'CSV 缺少表头或数据行' }
  const header = lines[0].split(',').map((h) => h.trim())
  const idx = (names: string[]): number => header.findIndex((h) => names.includes(h))
  const iRuleNo = idx(['ruleNo', '规则编号', '编号'])
  const iFrom = idx(['effectiveFrom', '生效日期', '生效日'])
  const iTo = idx(['effectiveTo', '失效日期', '失效日'])
  const iRegions = idx(['regions', '适用地区', '地区'])
  const iReg = idx(['registeredScope', '给据', '给据状态'])
  const iFee = idx(['fee', '资费', '资费(元)', '金额'])
  const iNote = idx(['note', '备注'])
  if (iFrom < 0 || iRegions < 0 || iFee < 0) {
    return { rules: [], source: '', error: 'CSV 缺少必需列（生效日期、适用地区、资费）' }
  }
  const rawRules: unknown[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(',').map((c) => c.trim())
    const regions = (cols[iRegions] || '')
      .split(/[;；、]/)
      .map((s) => s.trim())
      .filter(Boolean)
    let registeredScope: RegisteredScope = null
    if (iReg >= 0) {
      const v = cols[iReg]
      if (v === '是' || v === '给据' || v === 'true' || v === '1') registeredScope = true
      else if (v === '否' || v === '平信' || v === 'false' || v === '0') registeredScope = false
    }
    rawRules.push({
      ruleNo: iRuleNo >= 0 ? cols[iRuleNo] : '',
      effectiveFrom: cols[iFrom],
      effectiveTo: iTo >= 0 ? cols[iTo] : '',
      regions,
      registeredScope,
      fee: Number.parseFloat(cols[iFee]) || 0,
      note: iNote >= 0 ? cols[iNote] : ''
    })
  }
  const { rules, error } = normalizeRules(rawRules)
  return { rules, source: '', error }
}

/** 解析导入文件文本，返回规则数组或错误信息 */
export function parseImportFile(
  text: string,
  fileName: string
): { rules: TariffRule[]; source: string; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { rules: [], source: '', error: '文件为空' }
  const isJson = /\.json$/i.test(fileName) || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (isJson) return parseJson(trimmed)
  return parseCsv(trimmed)
}

/** 为缺少编号的规则补齐编号，保证批次内唯一 */
export function assignRuleNos(rules: TariffRule[], existingNos: string[]): TariffRule[] {
  const used = new Set(existingNos)
  return rules.map((r) => {
    let ruleNo = r.ruleNo
    if (!ruleNo || used.has(ruleNo)) {
      ruleNo = nextSerialNo('ZF-', [...used])
    }
    used.add(ruleNo)
    return { ...r, ruleNo }
  })
}
