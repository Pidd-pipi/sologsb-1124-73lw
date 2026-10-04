/** 资费规则（TariffRule）数据模型：某一时期、某地区、某给据状态下的邮件资费标准。 */

/** 给据状态适用范围：true 仅给据，false 仅平信，null 两者皆适用 */
export type RegisteredScope = boolean | null

/** 资费规则 */
export interface TariffRule {
  id?: number
  /** 规则编号，如 ZF-0001 */
  ruleNo: string
  /** 生效日期 YYYY-MM-DD */
  effectiveFrom: string
  /** 失效日期 YYYY-MM-DD，空串表示仍生效 */
  effectiveTo: string
  /** 适用地区（收件地匹配，省 / 市名） */
  regions: string[]
  /** 给据状态适用范围：true 仅给据，false 仅平信，null 皆适用 */
  registeredScope: RegisteredScope
  /** 资费（元） */
  fee: number
  /** 来源批次号 */
  batchNo: string
  note: string
  createdAt: string
  updatedAt: string
}

/** 导入批次状态 */
export type BatchStatus = 'success' | 'failed'

/** 导入批次记录 */
export interface TariffBatch {
  id?: number
  /** 批次号，如 ZF-20261004-001 */
  batchNo: string
  /** 来源文件名 */
  fileName: string
  importedAt: string
  status: BatchStatus
  /** 本批次规则条数 */
  ruleCount: number
  /** 失败原因（status=failed 时） */
  error: string
  /** 原始文件文本（用于重试） */
  rawPayload: string
  note: string
}

/** 核验状态 */
export type VerifyStatus = 'matched' | 'underpaid' | 'overpaid' | 'pending' | 'notariff'

/** 单封核验结果 */
export interface VerifyResult {
  status: VerifyStatus
  /** 贴票合计（元） */
  stampTotal: number
  /** 适用资费（元），无则 null */
  tariff: number | null
  /** 短欠金额（元），underpaid 时为正 */
  shortfall: number
  /** 适用的规则 */
  rule: TariffRule | null
  /** 原因说明（待复核 / 无资费等） */
  reason: string
  /** 冲突的规则（待复核时） */
  conflicts: TariffRule[]
}

/** 对账冲突组 */
export interface ConflictGroup {
  key: string
  /** 库内现有规则（与新规则冲突）；null 表示两条都是新导入的规则 */
  existing: TariffRule | null
  /** 新导入的规则 */
  incoming: TariffRule
  /** 冲突类型：existing 新规则与库内规则冲突；incoming 两条新规则互斥 */
  kind: 'existing' | 'incoming'
  /** 受影响的实寄封 id（落在两条规则共同命中范围内） */
  coverIds: number[]
}

/** 待确认的导入（内存态，未写库） */
export interface PendingImport {
  batchNo: string
  fileName: string
  source: string
  newRules: TariffRule[]
  conflicts: ConflictGroup[]
  /** 每个冲突组的选择：key -> 'existing' 保留现有 / 'incoming' 采用新规则 */
  choices: Record<string, 'existing' | 'incoming'>
}

export const VERIFY_STATUS_META: Record<
  VerifyStatus,
  { label: string; type: 'success' | 'warning' | 'danger' | 'info' }
> = {
  matched: { label: '资符', type: 'success' },
  underpaid: { label: '欠资', type: 'danger' },
  overpaid: { label: '溢贴', type: 'warning' },
  pending: { label: '待复核', type: 'info' },
  notariff: { label: '无资费', type: 'info' }
}

/** 生成一条空白资费规则，供表单初始化使用。 */
export function createEmptyTariffRule(): TariffRule {
  return {
    ruleNo: '',
    effectiveFrom: '',
    effectiveTo: '',
    regions: [],
    registeredScope: null,
    fee: 0,
    batchNo: '',
    note: '',
    createdAt: '',
    updatedAt: ''
  }
}
