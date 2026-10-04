<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { useCoverStore } from '@/stores/coverStore'
import { useRateStore } from '@/stores/rateStore'
import { useVerifyStore } from '@/stores/verifyStore'
import type { Cover } from '@/types/cover'
import type { RateBatch, RateRule } from '@/types/rate'
import {
  BATCH_STATUS_META,
  REGISTERED_LABELS,
  RULE_STATUS_META,
  VERIFY_STATUS_META,
  VERIFY_STATUSES
} from '@/types/rate'
import { diffText, ruleAppliesTo } from '@/utils/rateMatch'
import { truncate } from '@/utils/id'

const router = useRouter()
const coverStore = useCoverStore()
const rateStore = useRateStore()
const verifyStore = useVerifyStore()

onMounted(async () => {
  if (!coverStore.loaded) await coverStore.load()
  if (!rateStore.loaded) await rateStore.load()
  if (!verifyStore.loaded) await verifyStore.load()
})

/* ------------------------------ 欠资核验汇总 ------------------------------ */

const summary = computed(() => verifyStore.summary)

const coverRows = computed(() =>
  coverStore.list.map((cover) => ({ cover, result: verifyStore.verify(cover) }))
)

const historyRules = computed(() =>
  rateStore.rules.filter((r) => r.status === 'archived' || r.status === 'discarded')
)

function openCover(cover: Cover): void {
  if (cover.id != null) void router.push(`/covers/${cover.id}`)
}

/* ------------------------------ 待选定对账池 ------------------------------ */

function conflictRulesOf(rule: RateRule): RateRule[] {
  return rule.conflictWith
    .map((id) => rateStore.rules.find((r) => r.id === id))
    .filter((r): r is RateRule => r != null)
}

/** 落在该待选定规则区间的实寄封（即被列为待复核的封） */
function affectedCovers(rule: RateRule): Cover[] {
  return coverStore.list.filter((c) =>
    ruleAppliesTo(rule, { postDate: c.postDate, sentTo: c.sentTo, registered: c.registered })
  )
}

async function adoptRule(rule: RateRule): Promise<void> {
  if (rule.id == null) return
  try {
    await ElMessageBox.confirm(
      `选定采用 ${rule.ruleNo}（${rule.rate}${rule.unit}）后，与之冲突的在效规则将下架归档，涉及实寄封的核验结论会立即重算。`,
      '对账选定',
      { confirmButtonText: '选定采用', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  await rateStore.resolvePending(rule.id, 'adopt')
  ElMessage.success(`已选定 ${rule.ruleNo} 为当期资费，涉及实寄封已重算`)
}

async function discardRule(rule: RateRule): Promise<void> {
  if (rule.id == null) return
  try {
    await ElMessageBox.confirm(
      `作废 ${rule.ruleNo} 后它不再参与核验，涉及实寄封将按在效清单重算。`,
      '作废规则',
      { confirmButtonText: '作废', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  await rateStore.resolvePending(rule.id, 'discard')
  ElMessage.success(`已作废 ${rule.ruleNo}`)
}

async function archiveRule(rule: RateRule): Promise<void> {
  if (rule.id == null) return
  try {
    await ElMessageBox.confirm(
      `停用 ${rule.ruleNo} 后，相关实寄封将改按其余在效规则重算。`,
      '停用规则',
      { confirmButtonText: '停用', cancelButtonText: '再想想', type: 'warning' }
    )
  } catch {
    return
  }
  await rateStore.archiveRule(rule.id)
  ElMessage.success(`已停用 ${rule.ruleNo}`)
}

/* ------------------------------ 导入与重试 ------------------------------ */

const importDialog = ref(false)
const importSource = ref('研究会资费清单')
const importText = ref('')
const importError = ref('')
const importing = ref(false)
const retryBatchId = ref<number | null>(null)

function openImport(): void {
  retryBatchId.value = null
  importSource.value = '研究会资费清单'
  importText.value = ''
  importError.value = ''
  importDialog.value = true
}

/** 从失败 / 中断批次重试：原文回填，修正后重新导入 */
function openRetry(batch: RateBatch): void {
  retryBatchId.value = batch.id ?? null
  importSource.value = batch.source
  importText.value = batch.rawText
  importError.value = batch.error
  importDialog.value = true
}

function onFileChange(file: UploadFile): void {
  const raw = file.raw
  if (!raw) return
  const reader = new FileReader()
  reader.onload = () => {
    importText.value = String(reader.result ?? '')
  }
  reader.readAsText(raw)
}

async function submitImport(): Promise<void> {
  if (!importText.value.trim()) {
    importError.value = '请先粘贴清单文本或从文件读取'
    return
  }
  importing.value = true
  try {
    const result =
      retryBatchId.value != null
        ? await rateStore.retryBatch(retryBatchId.value, importText.value)
        : await rateStore.importList(importText.value, importSource.value.trim() || '研究会资费清单')
    if (!result.ok) {
      importError.value = result.error ?? '导入失败'
      ElMessage.error(`批次 ${result.batchNo} 未写入，清单已保持原样，可修正后重试`)
      return
    }
    importDialog.value = false
    const parts = [`写入 ${result.added} 条`]
    if (result.pending) parts.push(`待选定 ${result.pending} 条`)
    if (result.duplicates) parts.push(`重复跳过 ${result.duplicates} 条`)
    ElMessage.success(`批次 ${result.batchNo} 导入完成：${parts.join('，')}`)
    if (result.pending) {
      ElMessage.warning('存在与在效规则冲突的资费，请先在「待选定规则」对账选定')
    }
  } finally {
    importing.value = false
  }
}

async function resync(): Promise<void> {
  await verifyStore.syncAll()
  ElMessage.success('已按当前清单重新核验全部实寄封')
}

function formatTs(ts: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="gb-page rate-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">资费清单与欠资核验</h1>
        <p class="gb-page__subtitle">
          在效规则 {{ rateStore.activeRules.length }} 条 · 待选定 {{ rateStore.pendingRules.length }} 条；
          按寄出日期、收件地与给据状态选定当期资费，与封上贴票合计逐封核对。
        </p>
      </div>
      <div class="rate-page__actions">
        <el-button @click="resync">重新核验全部</el-button>
        <el-button type="primary" @click="openImport">导入资费清单</el-button>
      </div>
    </header>

    <section class="gb-panel">
      <div class="rate-page__section-head">
        <h2 class="gb-panel__title">欠资核验汇总（{{ summary.total }} 封）</h2>
        <span class="rate-page__sync">最近重算：{{ formatTs(verifyStore.lastSyncAt) }}</span>
      </div>
      <div class="rate-page__chips">
        <el-tag
          v-for="key in VERIFY_STATUSES"
          :key="key"
          :type="VERIFY_STATUS_META[key].tagType"
          effect="plain"
        >
          {{ VERIFY_STATUS_META[key].label }} {{ summary[key] }}
        </el-tag>
      </div>
      <el-table :data="coverRows" border stripe>
        <el-table-column label="封号" width="100">
          <template #default="{ row }">{{ row.cover.coverNo }}</template>
        </el-table-column>
        <el-table-column label="收寄地" min-width="150">
          <template #default="{ row }">{{ row.cover.sentFrom }} → {{ row.cover.sentTo }}</template>
        </el-table-column>
        <el-table-column label="寄出" width="112">
          <template #default="{ row }">{{ row.cover.postDate || '待考' }}</template>
        </el-table-column>
        <el-table-column label="给据" width="66" align="center">
          <template #default="{ row }">{{ row.cover.registered ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="贴票合计" width="90" align="center">
          <template #default="{ row }">{{ row.result.paid }}</template>
        </el-table-column>
        <el-table-column label="应贴资费" width="110" align="center">
          <template #default="{ row }">
            <template v-if="row.result.required != null">
              {{ row.result.required }}{{ row.result.unit }}
              <span class="rate-page__rule-no">{{ row.result.ruleNo }}</span>
            </template>
            <template v-else>—</template>
          </template>
        </el-table-column>
        <el-table-column label="差额" width="110" align="center">
          <template #default="{ row }">{{ diffText(row.result) }}</template>
        </el-table-column>
        <el-table-column label="结论" width="106" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="VERIFY_STATUS_META[row.result.status as keyof typeof VERIFY_STATUS_META].tagType">
              {{ VERIFY_STATUS_META[row.result.status as keyof typeof VERIFY_STATUS_META].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openCover(row.cover)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="rateStore.pendingRules.length" class="gb-panel">
      <h2 class="gb-panel__title">待选定规则（对账池 {{ rateStore.pendingRules.length }} 条）</h2>
      <p class="rate-page__hint">
        同一日期区间收到两套规则：按生效日与适用地区对账，选定前不写入在效清单；落在重叠区间的实寄封暂列「待复核」。
      </p>
      <article v-for="rule in rateStore.pendingRules" :key="rule.id" class="rate-page__pending">
        <header class="rate-page__pending-head">
          <strong>{{ rule.ruleNo }} · {{ rule.eraName }}</strong>
          <el-tag size="small" :type="RULE_STATUS_META[rule.status].tagType">
            {{ RULE_STATUS_META[rule.status].label }}
          </el-tag>
        </header>
        <dl class="gb-facts">
          <div>
            <dt>生效区间</dt>
            <dd>{{ rule.effectiveFrom }} ~ {{ rule.effectiveTo || '沿用至今' }}</dd>
          </div>
          <div><dt>适用地区</dt><dd>{{ rule.region }}</dd></div>
          <div><dt>给据状态</dt><dd>{{ REGISTERED_LABELS[rule.registered] }}</dd></div>
          <div><dt>资费</dt><dd>{{ rule.rate }}{{ rule.unit }}</dd></div>
          <div>
            <dt>来源</dt>
            <dd>{{ rule.source || '未注' }}<template v-if="rule.batchNo">（{{ rule.batchNo }}）</template></dd>
          </div>
          <div><dt>备注</dt><dd>{{ rule.note || '—' }}</dd></div>
        </dl>
        <div class="rate-page__conflict">
          <span class="rate-page__label">冲突对象：</span>
          <template v-if="conflictRulesOf(rule).length">
            <span
              v-for="other in conflictRulesOf(rule)"
              :key="other.id"
              class="rate-page__conflict-item"
            >
              {{ other.ruleNo }}（{{ other.rate }}{{ other.unit }} ·
              {{ RULE_STATUS_META[other.status].label }}）
            </span>
          </template>
          <span v-else>—</span>
          <p v-if="rule.conflictNote" class="rate-page__conflict-note">{{ rule.conflictNote }}</p>
        </div>
        <div class="rate-page__affected">
          <span class="rate-page__label">涉及实寄封（待复核 {{ affectedCovers(rule).length }} 封）：</span>
          <template v-if="affectedCovers(rule).length">
            <el-tag
              v-for="cover in affectedCovers(rule)"
              :key="cover.id"
              size="small"
              type="primary"
              effect="plain"
              class="rate-page__cover-tag"
              @click="openCover(cover)"
            >
              {{ cover.coverNo }}
            </el-tag>
          </template>
          <span v-else class="rate-page__none">暂无实寄封落在该区间</span>
        </div>
        <footer class="rate-page__pending-actions">
          <el-button size="small" type="primary" @click="adoptRule(rule)">选定采用</el-button>
          <el-button size="small" type="danger" plain @click="discardRule(rule)">作废</el-button>
        </footer>
      </article>
    </section>

    <section class="gb-panel">
      <h2 class="gb-panel__title">在效资费规则（{{ rateStore.activeRules.length }} 条）</h2>
      <p v-if="!rateStore.activeRules.length" class="gb-empty">
        尚未导入资费清单，点击右上角「导入资费清单」接住研究会送来的清单。
      </p>
      <el-table v-else :data="rateStore.activeRules" border stripe>
        <el-table-column prop="ruleNo" label="规则号" width="96" />
        <el-table-column prop="eraName" label="资费期" min-width="180" />
        <el-table-column label="生效区间" width="200">
          <template #default="{ row }">
            {{ row.effectiveFrom }} ~ {{ row.effectiveTo || '沿用至今' }}
          </template>
        </el-table-column>
        <el-table-column prop="region" label="适用地区" width="100" />
        <el-table-column label="给据" width="76" align="center">
          <template #default="{ row }">{{ REGISTERED_LABELS[row.registered as keyof typeof REGISTERED_LABELS] }}</template>
        </el-table-column>
        <el-table-column label="资费" width="90" align="center">
          <template #default="{ row }">{{ row.rate }}{{ row.unit }}</template>
        </el-table-column>
        <el-table-column prop="source" label="来源" min-width="130" />
        <el-table-column prop="batchNo" label="批次" width="90">
          <template #default="{ row }">{{ row.batchNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="danger" @click="archiveRule(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section v-if="historyRules.length" class="gb-panel">
      <h2 class="gb-panel__title">历史规则（{{ historyRules.length }} 条）</h2>
      <el-table :data="historyRules" border stripe>
        <el-table-column prop="ruleNo" label="规则号" width="96" />
        <el-table-column prop="eraName" label="资费期" min-width="170" />
        <el-table-column label="生效区间" width="200">
          <template #default="{ row }">
            {{ row.effectiveFrom }} ~ {{ row.effectiveTo || '沿用至今' }}
          </template>
        </el-table-column>
        <el-table-column prop="region" label="适用地区" width="100" />
        <el-table-column label="资费" width="90" align="center">
          <template #default="{ row }">{{ row.rate }}{{ row.unit }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="RULE_STATUS_META[row.status as keyof typeof RULE_STATUS_META].tagType">
              {{ RULE_STATUS_META[row.status as keyof typeof RULE_STATUS_META].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" min-width="130" />
      </el-table>
    </section>

    <section class="gb-panel">
      <h2 class="gb-panel__title">导入批次（{{ rateStore.batches.length }}）</h2>
      <p v-if="!rateStore.batches.length" class="gb-empty">尚无导入记录。</p>
      <el-table v-else :data="rateStore.batches" border stripe>
        <el-table-column prop="batchNo" label="批次号" width="92" />
        <el-table-column prop="source" label="来源" min-width="130" />
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="BATCH_STATUS_META[row.status as keyof typeof BATCH_STATUS_META].tagType">
              {{ BATCH_STATUS_META[row.status as keyof typeof BATCH_STATUS_META].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="行数" width="220" align="center">
          <template #default="{ row }">
            共 {{ row.totalRows }} · 写入 {{ row.added }} · 待选定 {{ row.pending }} · 重复
            {{ row.duplicates }}
          </template>
        </el-table-column>
        <el-table-column label="错误" min-width="170">
          <template #default="{ row }">
            <span :title="row.error">{{ truncate(row.error, 42) || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="attempts" label="尝试" width="64" align="center" />
        <el-table-column label="发起时间" width="160">
          <template #default="{ row }">{{ formatTs(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'failed' || row.status === 'interrupted'"
              size="small"
              link
              type="primary"
              @click="openRetry(row)"
            >
              修正重试
            </el-button>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog
      v-model="importDialog"
      :title="retryBatchId != null ? '修正重试失败批次' : '导入资费清单'"
      width="720px"
    >
      <el-form label-width="96px">
        <el-form-item label="清单来源">
          <el-input
            v-model="importSource"
            placeholder="如 研究会 2024 资费清单"
            :disabled="retryBatchId != null"
          />
        </el-form-item>
        <el-form-item label="清单文本">
          <el-input
            v-model="importText"
            type="textarea"
            :rows="12"
            placeholder="支持 JSON 数组或 CSV（首行表头）。字段：资费期/eraName、生效日/effectiveFrom、止用日/effectiveTo、适用地区/region、给据/registered（通用/给据/平信）、资费/rate、单位/unit、备注/note。"
          />
        </el-form-item>
        <el-form-item label="从文件读取">
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept=".json,.csv,.txt"
            :on-change="onFileChange"
          >
            <el-button>选择清单文件</el-button>
          </el-upload>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="importError"
        type="error"
        :title="`导入未写入：${importError}`"
        :closable="false"
        show-icon
        class="rate-page__import-error"
      />
      <p class="rate-page__hint">
        与在效规则区间重叠且资费互异的行将进入「待选定」对账池，不会直接写入；任一行校验失败则整批回滚，清单保持原样。
      </p>
      <template #footer>
        <el-button @click="importDialog = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="submitImport">
          {{ retryBatchId != null ? '重试导入' : '开始导入' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rate-page__actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.rate-page__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.rate-page__sync {
  font-size: 12px;
  color: var(--gb-muted);
}
.rate-page__chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.rate-page__rule-no {
  display: block;
  font-size: 11px;
  color: var(--gb-muted);
}
.rate-page__hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--gb-muted);
}
.rate-page__label {
  font-size: 13px;
  color: var(--gb-muted);
}
.rate-page__pending {
  border: 1px dashed var(--gb-line);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: #fffaf0;
}
.rate-page__pending-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  color: #5d3325;
}
.rate-page__conflict,
.rate-page__affected {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 13px;
}
.rate-page__conflict-item {
  color: #8c3b2e;
  font-weight: 600;
}
.rate-page__conflict-note {
  width: 100%;
  margin: 4px 0 0;
  font-size: 12px;
  color: #b06f16;
}
.rate-page__cover-tag {
  cursor: pointer;
}
.rate-page__none {
  font-size: 12px;
  color: var(--gb-muted);
}
.rate-page__pending-actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.rate-page__import-error {
  margin-bottom: 10px;
}
</style>
