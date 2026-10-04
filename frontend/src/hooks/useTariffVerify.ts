/**
 * 响应式资费核验：随实寄封贴票 / 寄出日期与资费规则变动即时重算。
 * 被目录页、详情页与资费管理页复用。
 */
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useCoverStore } from '@/stores/coverStore'
import { useTariffStore } from '@/stores/tariffStore'
import type { Cover } from '@/types/cover'
import type { TariffRule, VerifyResult } from '@/types/tariff'
import { verifyCover } from '@/utils/tariff'

export interface TariffSummary {
  total: number
  matched: number
  underpaid: number
  overpaid: number
  pending: number
  notariff: number
  /** 欠资总额（元） */
  totalShortfall: number
}

export function useTariffVerify() {
  const coverStore = useCoverStore()
  const tariffStore = useTariffStore()
  const { list: covers } = storeToRefs(coverStore)
  const { rules } = storeToRefs(tariffStore)

  /** 待确认导入中的新规则（对账期间参与核验，使相关封列待复核） */
  const pendingRules = computed<TariffRule[]>(() => tariffStore.pending?.newRules ?? [])
  /** 参与核验的全部规则：库内规则 + 待确认规则 */
  const allRules = computed<TariffRule[]>(() => [...rules.value, ...pendingRules.value])

  /** 单封核验（响应式） */
  function verifyOf(cover: Cover | null | undefined): VerifyResult | null {
    if (!cover) return null
    return verifyCover(cover, allRules.value)
  }

  /** 按封 id 核验（响应式） */
  function verifyOfId(id: number | null | undefined): VerifyResult | null {
    if (id == null) return null
    const cover = covers.value.find((c) => c.id === id)
    return cover ? verifyCover(cover, allRules.value) : null
  }

  /** 目录汇总：各核验状态的封数与欠资总额（响应式） */
  const summary = computed<TariffSummary>(() => {
    const s: TariffSummary = {
      total: covers.value.length,
      matched: 0,
      underpaid: 0,
      overpaid: 0,
      pending: 0,
      notariff: 0,
      totalShortfall: 0
    }
    for (const c of covers.value) {
      const v = verifyCover(c, allRules.value)
      s[v.status] += 1
      if (v.status === 'underpaid') s.totalShortfall += v.shortfall
    }
    return s
  })

  return { rules, verifyOf, verifyOfId, summary }
}
