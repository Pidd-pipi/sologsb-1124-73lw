import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { ImportResult, RateBatch, RateRule } from '@/types/rate'
import { isDuplicateRule, parseRateList, rulesConflict, type RuleScope } from '@/utils/rateMatch'
import { nextSerialNo, nowIso } from '@/utils/id'

export const useRateStore = defineStore('rate', () => {
  const rules = ref<RateRule[]>([])
  const batches = ref<RateBatch[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  const activeRules = computed(() => rules.value.filter((r) => r.status === 'active'))
  const pendingRules = computed(() => rules.value.filter((r) => r.status === 'pending'))

  async function load(): Promise<void> {
    loading.value = true
    try {
      // 导入中断的恢复：规则写入在事务内，中断即整体回滚、清单保持原样；
      // 残留的「导入中」批次在此标记为已中断，原文保留，可修正后重试。
      const stuck = await db.rateBatches.where('status').equals('importing').toArray()
      for (const batch of stuck) {
        if (batch.id == null) continue
        await db.rateBatches.update(batch.id, {
          status: 'interrupted',
          error: batch.error || '导入中断，清单已自动回滚到导入前状态',
          finishedAt: nowIso()
        })
      }
      rules.value = await db.rateRules.orderBy('ruleNo').toArray()
      batches.value = (await db.rateBatches.toArray()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      )
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  function nextBatchNo(): string {
    return nextSerialNo('RB-', batches.value.map((b) => b.batchNo))
  }

  /**
   * 执行导入：先整批校验、与在效清单对账分类，再在一个事务内写入。
   * 任一行校验失败一行都不写；写入过程中断则事务回滚，清单恢复原样。
   */
  async function executeImport(batchId: number, rawText: string): Promise<ImportResult> {
    const batch = await db.rateBatches.get(batchId)
    if (!batch) {
      return { ok: false, batchNo: '', added: 0, pending: 0, duplicates: 0, error: '批次不存在' }
    }
    const parsed = parseRateList(rawText)
    if (parsed.errors.length) {
      // 校验失败：一行都不写，批次标记失败并保留原文，供修正后重试
      const error = parsed.errors.join('；')
      await db.rateBatches.update(batchId, {
        status: 'failed',
        totalRows: parsed.total,
        error,
        finishedAt: nowIso()
      })
      return { ok: false, batchNo: batch.batchNo, added: 0, pending: 0, duplicates: 0, error }
    }

    const now = nowIso()
    const actives = await db.rateRules.where('status').equals('active').toArray()
    const usedNos = (await db.rateRules.toArray()).map((r) => r.ruleNo)
    const toAdd: RateRule[] = []
    const toHold: { rule: RateRule; incomingNos: string[] }[] = []
    let duplicates = 0
    // 查重与冲突都对「在效规则 + 本批次已分类行」做，保证批次内也不自相矛盾
    const prior: RuleScope[] = [...actives]

    for (const row of parsed.rows) {
      if (prior.some((p) => isDuplicateRule(p, row))) {
        duplicates += 1
        continue
      }
      const ruleNo = nextSerialNo('RL-', usedNos)
      usedNos.push(ruleNo)
      const conflictActives = actives.filter((a) => rulesConflict(a, row))
      const conflictIncoming = [...toAdd, ...toHold.map((h) => h.rule)].filter((r) =>
        rulesConflict(r, row)
      )
      const isPending = conflictActives.length > 0 || conflictIncoming.length > 0
      const rule: RateRule = {
        ...row,
        ruleNo,
        source: batch.source,
        batchNo: batch.batchNo,
        status: isPending ? 'pending' : 'active',
        conflictWith: conflictActives
          .map((a) => a.id)
          .filter((v): v is number => typeof v === 'number'),
        conflictNote: conflictIncoming.length
          ? `与本批次 ${conflictIncoming.map((r) => r.ruleNo).join('、')} 互异，待一并核对`
          : '',
        createdAt: now,
        updatedAt: now
      }
      // 选定前不写入在效清单：冲突行进入待选定池
      if (isPending) {
        toHold.push({ rule, incomingNos: conflictIncoming.map((r) => r.ruleNo) })
      } else {
        toAdd.push(rule)
      }
      prior.push(rule)
    }

    await db.transaction('rw', db.rateRules, db.rateBatches, async () => {
      const idByNo = new Map<string, number>()
      for (const rule of toAdd) {
        const id = await db.rateRules.add(rule)
        idByNo.set(rule.ruleNo, id)
      }
      for (const { rule, incomingNos } of toHold) {
        // 批次内冲突的对象此时才有真实 id，补齐到冲突清单里
        const extra = incomingNos
          .map((no) => idByNo.get(no))
          .filter((v): v is number => typeof v === 'number')
        rule.conflictWith = [...rule.conflictWith, ...extra]
        const id = await db.rateRules.add(rule)
        idByNo.set(rule.ruleNo, id)
      }
      await db.rateBatches.update(batchId, {
        status: 'imported',
        totalRows: parsed.rows.length,
        added: toAdd.length,
        pending: toHold.length,
        duplicates,
        error: '',
        finishedAt: nowIso()
      })
    })

    return {
      ok: true,
      batchNo: batch.batchNo,
      added: toAdd.length,
      pending: toHold.length,
      duplicates
    }
  }

  /** 接住研究会送来的资费清单：整批导入 */
  async function importList(rawText: string, source: string): Promise<ImportResult> {
    const batchId = await db.rateBatches.add({
      batchNo: nextBatchNo(),
      source,
      status: 'importing',
      totalRows: 0,
      added: 0,
      pending: 0,
      duplicates: 0,
      error: '',
      rawText,
      attempts: 1,
      createdAt: nowIso(),
      finishedAt: ''
    })
    const result = await executeImport(batchId, rawText)
    await load()
    return result
  }

  /** 从失败 / 中断的批次重试：沿用原批次号与原文（可带修正后的文本） */
  async function retryBatch(batchId: number, rawText?: string): Promise<ImportResult> {
    const batch = await db.rateBatches.get(batchId)
    if (!batch) {
      return { ok: false, batchNo: '', added: 0, pending: 0, duplicates: 0, error: '批次不存在' }
    }
    const text = (rawText ?? batch.rawText).trim()
    await db.rateBatches.update(batchId, {
      status: 'importing',
      rawText: text,
      error: '',
      attempts: batch.attempts + 1
    })
    const result = await executeImport(batchId, text)
    await load()
    return result
  }

  /** 对账选定：采用则冲突的在效规则下架归档、本规则升为在效；作废则不进清单 */
  async function resolvePending(id: number, choice: 'adopt' | 'discard'): Promise<void> {
    await db.transaction('rw', db.rateRules, async () => {
      const rule = await db.rateRules.get(id)
      if (!rule || rule.status !== 'pending') return
      const now = nowIso()
      if (choice === 'discard') {
        await db.rateRules.update(id, { status: 'discarded', updatedAt: now })
        return
      }
      // 按当前在效清单重新对账，凡与本规则冲突的一律归档
      const actives = await db.rateRules.where('status').equals('active').toArray()
      for (const other of actives) {
        if (other.id != null && rulesConflict(other, rule)) {
          await db.rateRules.update(other.id, { status: 'archived', updatedAt: now })
        }
      }
      await db.rateRules.update(id, {
        status: 'active',
        conflictWith: [],
        conflictNote: '',
        updatedAt: now
      })
    })
    await load()
  }

  /** 停用在效规则（归档留痕，不删记录） */
  async function archiveRule(id: number): Promise<void> {
    await db.rateRules.update(id, { status: 'archived', updatedAt: nowIso() })
    await load()
  }

  return {
    rules,
    batches,
    loading,
    loaded,
    activeRules,
    pendingRules,
    load,
    importList,
    retryBatch,
    resolvePending,
    archiveRule
  }
})
