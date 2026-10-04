/** 资费清单（RateRule）、导入批次（RateBatch）与欠资核验结论（CoverVerification）数据模型。 */

/** 给据状态适用范围：any 通用 / yes 仅给据 / no 仅平信 */
export type RuleRegistered = 'any' | 'yes' | 'no'

/** 规则状态：active 在效 / pending 冲突待选定（选定前不参与核验）/ archived 对账下架 / discarded 作废 */
export type RuleStatus = 'active' | 'pending' | 'archived' | 'discarded'

/** 资费规则：研究会资费清单中的一行 */
export interface RateRule {
  id?: number
  /** 规则号，如 RL-0001 */
  ruleNo: string
  /** 资费期名称，如 清末国内挂号资费 */
  eraName: string
  /** 生效日 YYYY-MM-DD */
  effectiveFrom: string
  /** 止用日 YYYY-MM-DD，空表示沿用至今 */
  effectiveTo: string
  /** 适用地区（收件地）；通用 / 全国 / 国内 视为通配 */
  region: string
  /** 给据状态适用范围 */
  registered: RuleRegistered
  /** 应贴资费（与 unit 同单位，与封上贴票面值同口径比较） */
  rate: number
  /** 资费单位，如 分 / 角 / 元 */
  unit: string
  /** 清单来源 */
  source: string
  /** 导入批次号 */
  batchNo: string
  status: RuleStatus
  /** 对账冲突的规则 id 列表 */
  conflictWith: number[]
  /** 冲突说明（批次内互异等） */
  conflictNote: string
  note: string
  createdAt: string
  updatedAt: string
}

/** 导入批次状态：importing 导入中 / imported 已导入 / failed 校验失败 / interrupted 中断已回滚 */
export type BatchStatus = 'importing' | 'imported' | 'failed' | 'interrupted'

/** 导入批次：一次清单导入的全过程记录，原文留档供失败后修正重试 */
export interface RateBatch {
  id?: number
  /** 批次号，如 RB-0001 */
  batchNo: string
  source: string
  status: BatchStatus
  totalRows: number
  added: number
  pending: number
  duplicates: number
  error: string
  /** 原始清单文本，失败 / 中断后据此修正重试 */
  rawText: string
  attempts: number
  createdAt: string
  finishedAt: string
}

/** 核验结论：exact 相符 / short 欠资 / over 溢付 / pending 待复核 / unrated 无适用资费 / nodate 寄出日期待考 */
export type VerifyStatus = 'exact' | 'short' | 'over' | 'pending' | 'unrated' | 'nodate'

/** 一封实寄封的欠资核验结论（按封事实指纹与清单版本落盘，任一变化即失效重算） */
export interface CoverVerification {
  id?: number
  coverId: number
  coverNo: string
  status: VerifyStatus
  /** 适用资费规则 id，无适用规则为 null */
  ruleId: number | null
  ruleNo: string
  /** 应贴资费，无适用规则为 null */
  required: number | null
  /** 贴票合计（面值 × 枚数） */
  paid: number
  /** 差额 paid - required，负数为欠资 */
  diff: number | null
  unit: string
  /** 封事实指纹：贴票构成 / 寄出日期 / 收件地 / 给据 一改即变 */
  fingerprint: string
  /** 资费清单版本：在效与待选定规则一改即变 */
  rulesVersion: string
  computedAt: string
}

/** 导入结果回执 */
export interface ImportResult {
  ok: boolean
  batchNo: string
  added: number
  pending: number
  duplicates: number
  error?: string
}

export type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger'

export const VERIFY_STATUSES: VerifyStatus[] = [
  'exact',
  'short',
  'over',
  'pending',
  'unrated',
  'nodate'
]

export const VERIFY_STATUS_META: Record<VerifyStatus, { label: string; tagType: TagType }> = {
  exact: { label: '相符', tagType: 'success' },
  short: { label: '欠资', tagType: 'danger' },
  over: { label: '溢付', tagType: 'warning' },
  pending: { label: '待复核', tagType: 'primary' },
  unrated: { label: '无适用资费', tagType: 'info' },
  nodate: { label: '日期待考', tagType: 'info' }
}

export const RULE_STATUS_META: Record<RuleStatus, { label: string; tagType: TagType }> = {
  active: { label: '在效', tagType: 'success' },
  pending: { label: '待选定', tagType: 'warning' },
  archived: { label: '已归档', tagType: 'info' },
  discarded: { label: '已作废', tagType: 'info' }
}

export const BATCH_STATUS_META: Record<BatchStatus, { label: string; tagType: TagType }> = {
  importing: { label: '导入中', tagType: 'primary' },
  imported: { label: '已导入', tagType: 'success' },
  failed: { label: '失败', tagType: 'danger' },
  interrupted: { label: '已中断回滚', tagType: 'warning' }
}

export const REGISTERED_LABELS: Record<RuleRegistered, string> = {
  any: '通用',
  yes: '给据',
  no: '平信'
}
