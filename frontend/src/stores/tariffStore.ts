/**
 * 资费规则与导入批次的 Pinia store。
 * 导入流程：prepareImport（解析+冲突检测，不写库）→ 对账 → confirmImport（事务写库）。
 * 失败批次保留原文，可 retryBatch 重试。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { Cover } from '@/types/cover'
import type {
  PendingImport,
  TariffBatch,
  TariffRule,
  VerifyResult
} from '@/types/tariff'
import {
  assignRuleNos,
  detectConflicts,
  nextBatchNo,
  parseImportFile,
  resolveImport,
  verifyCover
} from '@/utils/tariff'
import { nextSerialNo, nowIso } from '@/utils/id'

export const useTariffStore = defineStore('tariff', () => {
  const rules = ref<TariffRule[]>([])
  const batches = ref<TariffBatch[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  /** 待确认的导入（内存态，对账期间不写库） */
  const pending = ref<PendingImport | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    try {
      rules.value = await db.tariffRules.orderBy('effectiveFrom').toArray()
      batches.value = await db.tariffBatches.orderBy('importedAt').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个规则编号，如 ZF-0001 */
  function nextRuleNo(): string {
    return nextSerialNo('ZF-', rules.value.map((r) => r.ruleNo))
  }

  /** 读取文件并准备导入：解析 → 校验 → 冲突检测。不写库。 */
  async function prepareImport(file: File): Promise<{ ok: boolean; error: string }> {
    const text = await file.text()
    const { rules: parsed, source, error } = parseImportFile(text, file.name)
    const batchNo = nextBatchNo(batches.value)
    if (error) {
      // 记录失败批次，保留原文用于重试；不触碰现有资费清单
      await recordBatch({
        batchNo,
        fileName: file.name,
        status: 'failed',
        ruleCount: 0,
        error,
        rawPayload: text,
        note: source
      })
      return { ok: false, error }
    }
    // 补齐规则编号，保证批次内唯一
    const existingNos = rules.value.map((r) => r.ruleNo)
    const newRules = assignRuleNos(parsed, existingNos).map((r) => ({ ...r, batchNo }))
    const covers = await db.covers.toArray()
    const conflicts = detectConflicts(newRules, rules.value, covers)
    const choices: Record<string, 'existing' | 'incoming'> = {}
    for (const g of conflicts) choices[g.key] = 'existing'
    pending.value = { batchNo, fileName: file.name, source, newRules, conflicts, choices }
    return { ok: true, error: '' }
  }

  /** 放弃本次导入（不写库） */
  function cancelImport(): void {
    pending.value = null
  }

  /** 确认对账选择并写库（事务：删旧规则 + 写新规则 + 记批次） */
  async function confirmImport(): Promise<{ ok: boolean; error: string }> {
    const p = pending.value
    if (!p) return { ok: false, error: '没有待确认的导入' }
    const { toAdd, toDeleteExisting } = resolveImport(p)
    const now = nowIso()
    try {
      await db.transaction('rw', db.tariffRules, db.tariffBatches, async () => {
        if (toDeleteExisting.length) await db.tariffRules.bulkDelete(toDeleteExisting)
        await db.tariffRules.bulkPut(
          toAdd.map((r) => ({ ...r, createdAt: now, updatedAt: now }))
        )
        await recordBatch({
          batchNo: p.batchNo,
          fileName: p.fileName,
          status: 'success',
          ruleCount: toAdd.length,
          error: '',
          rawPayload: '',
          note: p.source
        })
      })
      pending.value = null
      await load()
      return { ok: true, error: '' }
    } catch (e) {
      return { ok: false, error: `写入失败：${(e as Error).message}` }
    }
  }

  /** 重试失败批次：用保存的原文重新走解析 → 冲突检测 */
  async function retryBatch(batch: TariffBatch): Promise<{ ok: boolean; error: string }> {
    if (!batch.rawPayload) return { ok: false, error: '该批次没有保存原文，无法重试' }
    const file = new File([batch.rawPayload], batch.fileName || 'retry.json', {
      type: 'text/plain'
    })
    return prepareImport(file)
  }

  async function recordBatch(input: Omit<TariffBatch, 'id' | 'importedAt'>): Promise<number> {
    const record: TariffBatch = { ...input, importedAt: nowIso() }
    const id = await db.tariffBatches.add(record)
    await load()
    return id
  }

  async function removeRule(id: number): Promise<void> {
    await db.tariffRules.delete(id)
    await load()
  }

  async function clearAll(): Promise<void> {
    await db.tariffRules.clear()
    await load()
  }

  /** 单封核验（读取当前资费规则；在 computed 内调用即响应式） */
  function verifyOf(cover: Cover | null): VerifyResult | null {
    if (!cover) return null
    return verifyCover(cover, rules.value)
  }

  /** 规则总数 */
  const total = computed(() => rules.value.length)
  /** 失败批次数（目录页角标用） */
  const failedBatchCount = computed(
    () => batches.value.filter((b) => b.status === 'failed').length
  )

  return {
    rules,
    batches,
    loading,
    loaded,
    pending,
    total,
    failedBatchCount,
    load,
    nextRuleNo,
    prepareImport,
    cancelImport,
    confirmImport,
    retryBatch,
    removeRule,
    clearAll,
    verifyOf
  }
})
