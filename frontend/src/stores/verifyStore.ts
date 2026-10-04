import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { Cover } from '@/types/cover'
import type { CoverVerification, VerifyStatus } from '@/types/rate'
import { computeRulesVersion, verifyCover } from '@/utils/rateMatch'
import { useCoverStore } from './coverStore'
import { useRateStore } from './rateStore'
import { nowIso } from '@/utils/id'

/**
 * 欠资核验：结论完全由当前封事实与当前资费清单推导。
 * 贴票构成、寄出日期、收件地、给据或清单一变，watch 立即触发重算并落盘，
 * 目录汇总（summary）随计算属性同时失效更新。
 */
export const useVerifyStore = defineStore('verify', () => {
  const coverStore = useCoverStore()
  const rateStore = useRateStore()

  /** 落盘的核验结论（审计留痕：每封一条，含指纹与清单版本） */
  const records = ref<CoverVerification[]>([])
  const lastSyncAt = ref('')
  const loaded = ref(false)

  const rulesVersion = computed(() => computeRulesVersion(rateStore.rules))

  /** 实时核验一封：始终按当前数据推导，不读缓存 */
  function verify(cover: Cover): CoverVerification {
    return verifyCover(cover, rateStore.activeRules, rateStore.pendingRules, rulesVersion.value)
  }

  function ofCover(coverId: number | null | undefined): CoverVerification | null {
    if (coverId == null) return null
    const cover = coverStore.byId(coverId)
    return cover ? verify(cover) : null
  }

  /** 目录汇总：随封与清单的变化即时重算 */
  const summary = computed<Record<VerifyStatus, number> & { total: number }>(() => {
    const acc: Record<VerifyStatus, number> & { total: number } = {
      exact: 0,
      short: 0,
      over: 0,
      pending: 0,
      unrated: 0,
      nodate: 0,
      total: 0
    }
    for (const cover of coverStore.list) {
      acc[verify(cover).status] += 1
      acc.total += 1
    }
    return acc
  })

  async function load(): Promise<void> {
    records.value = await db.verifications.toArray()
    loaded.value = true
    await syncAll()
  }

  /** 把当前结论落盘：指纹或清单版本不一致即重算覆盖，封已删除则清除记录 */
  async function syncAll(): Promise<void> {
    if (!coverStore.loaded || !rateStore.loaded) return
    const now = nowIso()
    const version = rulesVersion.value
    const alive = new Set<number>()
    const puts: CoverVerification[] = []
    for (const cover of coverStore.list) {
      if (cover.id == null) continue
      alive.add(cover.id)
      const next = verify(cover)
      const prev = records.value.find((r) => r.coverId === cover.id)
      if (!prev || prev.fingerprint !== next.fingerprint || prev.rulesVersion !== version) {
        puts.push({ ...next, id: prev?.id, computedAt: now })
      }
    }
    const orphans = records.value
      .filter((r) => !alive.has(r.coverId))
      .map((r) => r.id)
      .filter((v): v is number => typeof v === 'number')
    if (!puts.length && !orphans.length) return
    await db.transaction('rw', db.verifications, async () => {
      if (puts.length) await db.verifications.bulkPut(puts)
      if (orphans.length) await db.verifications.bulkDelete(orphans)
    })
    records.value = await db.verifications.toArray()
    lastSyncAt.value = now
  }

  // 封事实或资费清单一变，结论与汇总立即失效重算
  watch(
    [() => coverStore.list, () => rateStore.rules],
    () => {
      void syncAll()
    },
    { deep: true }
  )

  function recordOf(coverId: number): CoverVerification | null {
    return records.value.find((r) => r.coverId === coverId) ?? null
  }

  return {
    records,
    loaded,
    lastSyncAt,
    rulesVersion,
    summary,
    load,
    verify,
    ofCover,
    recordOf,
    syncAll
  }
})
