<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import TariffTag from '@/components/common/TariffTag.vue'
import { useCoverStore } from '@/stores/coverStore'
import { useTariffStore } from '@/stores/tariffStore'
import { useTariffVerify } from '@/hooks/useTariffVerify'
import type { TariffRule } from '@/types/tariff'
import { createEmptyTariffRule } from '@/types/tariff'
import { nowIso } from '@/utils/id'

const tariffStore = useTariffStore()
const coverStore = useCoverStore()
const { summary } = useTariffVerify()

const importInput = ref<UploadFile | null>(null)
const ruleDialog = ref(false)
const reconcileVisible = ref(false)
const ruleForm = reactive<TariffRule>(createEmptyTariffRule())

onMounted(async () => {
  if (!tariffStore.loaded) await tariffStore.load()
  if (!coverStore.loaded) await coverStore.load()
})

const pending = computed(() => tariffStore.pending)

/** 受冲突影响的实寄封号 */
function coverNosOf(ids: number[]): string {
  return ids
    .map((id) => coverStore.byId(id)?.coverNo)
    .filter((no): no is string => !!no)
    .join('、') || '—'
}

function rulePeriod(r: TariffRule): string {
  return `${r.effectiveFrom} ~ ${r.effectiveTo || '至今'}`
}

function ruleRegions(r: TariffRule): string {
  return r.regions.length ? r.regions.join('、') : '—'
}

function ruleScope(r: TariffRule): string {
  if (r.registeredScope == null) return '皆可'
  return r.registeredScope ? '给据' : '平信'
}

async function onImportChange(file: UploadFile): Promise<void> {
  const raw = file.raw
  if (!raw) return
  const { ok, error } = await tariffStore.prepareImport(raw)
  if (!ok) {
    ElMessage.error(`导入失败：${error}`)
  } else if (tariffStore.pending) {
    reconcileVisible.value = true
    const count = tariffStore.pending.newRules.length
    const conflicts = tariffStore.pending.conflicts.length
    if (conflicts > 0) {
      ElMessage.warning(`已读入 ${count} 条规则，检测到 ${conflicts} 处冲突，请先对账`)
    } else {
      ElMessage.success(`已读入 ${count} 条规则，确认后写入`)
    }
  }
}

async function confirmImport(): Promise<void> {
  const { ok, error } = await tariffStore.confirmImport()
  reconcileVisible.value = false
  if (ok) {
    ElMessage.success('资费清单已更新')
  } else {
    ElMessage.error(error || '写入失败')
  }
}

function cancelImport(): void {
  tariffStore.cancelImport()
  reconcileVisible.value = false
  ElMessage.info('已放弃本次导入')
}

async function retryBatch(batchId: number): Promise<void> {
  const batch = tariffStore.batches.find((b) => b.id === batchId)
  if (!batch) return
  const { ok, error } = await tariffStore.retryBatch(batch)
  if (!ok) {
    ElMessage.error(`重试失败：${error}`)
  } else if (tariffStore.pending) {
    reconcileVisible.value = true
    ElMessage.warning('已重新读入，请确认对账后写入')
  }
}

async function removeRule(id: number): Promise<void> {
  await tariffStore.removeRule(id)
  ElMessage.success('规则已删除')
}

function openRuleDialog(): void {
  Object.assign(ruleForm, createEmptyTariffRule())
  ruleForm.ruleNo = tariffStore.nextRuleNo()
  ruleDialog.value = true
}

async function submitRule(): Promise<void> {
  if (!ruleForm.effectiveFrom) {
    ElMessage.warning('请填写生效日期')
    return
  }
  if (!ruleForm.regions.length) {
    ElMessage.warning('请填写至少一个适用地区')
    return
  }
  if (ruleForm.fee < 0) {
    ElMessage.warning('资费不能为负')
    return
  }
  const now = nowIso()
  // 直接写库：手动新增不经过导入批次
  const { db } = await import('@/utils/db')
  await db.tariffRules.add({ ...ruleForm, createdAt: now, updatedAt: now })
  await tariffStore.load()
  ruleDialog.value = false
  ElMessage.success(`已新增规则 ${ruleForm.ruleNo}`)
}

const failedBatches = computed(() => tariffStore.batches.filter((b) => b.status === 'failed'))
</script>

<template>
  <div class="gb-page tariff-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">资费清单</h1>
        <p class="gb-page__subtitle">
          按寄出日期、收件地与给据状态选定当期资费，核验封上贴票合计；导入冲突先对账、选定后再写入。
        </p>
      </div>
      <div class="tariff-page__actions">
        <el-upload
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,.csv,application/json,text/csv"
          :on-change="onImportChange"
        >
          <el-button type="primary">导入资费清单</el-button>
        </el-upload>
        <el-button @click="openRuleDialog">手动新增规则</el-button>
      </div>
    </header>

    <section class="gb-panel tariff-summary">
      <h2 class="gb-panel__title">目录汇总</h2>
      <dl class="tariff-summary__stats">
        <div><dt>在库实寄封</dt><dd>{{ summary.total }}</dd></div>
        <div><dt>资符</dt><dd class="is-matched">{{ summary.matched }}</dd></div>
        <div><dt>欠资</dt><dd class="is-underpaid">{{ summary.underpaid }}</dd></div>
        <div><dt>溢贴</dt><dd class="is-overpaid">{{ summary.overpaid }}</dd></div>
        <div><dt>待复核</dt><dd class="is-pending">{{ summary.pending }}</dd></div>
        <div><dt>无资费</dt><dd>{{ summary.notariff }}</dd></div>
        <div><dt>欠资总额</dt><dd class="is-underpaid">{{ summary.totalShortfall }} 元</dd></div>
      </dl>
      <p class="tariff-summary__hint">
        核验结论随贴票与寄出日期改动即时重算；待复核封请在导入对账选定后自动刷新。
      </p>
    </section>

    <section class="gb-panel">
      <h2 class="gb-panel__title">资费规则（{{ tariffStore.rules.length }} 条）</h2>
      <p v-if="!tariffStore.rules.length" class="gb-empty">
        尚无资费规则，点击右上角「导入资费清单」接收研究会清单，或手动新增。
      </p>
      <el-table v-else :data="tariffStore.rules" border stripe size="small">
        <el-table-column prop="ruleNo" label="规则编号" width="110" />
        <el-table-column label="生效期间" min-width="200">
          <template #default="{ row }">{{ rulePeriod(row) }}</template>
        </el-table-column>
        <el-table-column label="适用地区" min-width="140">
          <template #default="{ row }">{{ ruleRegions(row) }}</template>
        </el-table-column>
        <el-table-column label="给据状态" width="90">
          <template #default="{ row }">{{ ruleScope(row) }}</template>
        </el-table-column>
        <el-table-column label="资费(元)" width="90">
          <template #default="{ row }">{{ row.fee }}</template>
        </el-table-column>
        <el-table-column prop="batchNo" label="来源批次" width="150" show-overflow-tooltip />
        <el-table-column prop="note" label="备注" min-width="120" show-overflow-tooltip />
        <el-table-column label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="danger" @click="removeRule(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="gb-panel">
      <h2 class="gb-panel__title">导入批次（{{ tariffStore.batches.length }} 批）</h2>
      <p v-if="!tariffStore.batches.length" class="gb-empty">尚无导入记录。</p>
      <el-table v-else :data="tariffStore.batches" border stripe size="small">
        <el-table-column prop="batchNo" label="批次号" width="170" />
        <el-table-column prop="fileName" label="来源文件" min-width="160" show-overflow-tooltip />
        <el-table-column label="导入时间" width="180">
          <template #default="{ row }">{{ row.importedAt.replace('T', ' ').slice(0, 19) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'success'" type="success" size="small">成功</el-tag>
            <el-tag v-else type="danger" size="small">失败</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="ruleCount" label="规则数" width="80" />
        <el-table-column prop="error" label="失败原因" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'failed'"
              size="small"
              link
              type="primary"
              @click="retryBatch(row.id)"
            >
              重试
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 对账对话框 -->
    <el-dialog
      v-model="reconcileVisible"
      title="导入对账"
      width="860px"
      :close-on-click-modal="false"
      @close="cancelImport"
    >
      <template v-if="pending">
        <p class="reconcile__lead">
          批次 <strong>{{ pending.batchNo }}</strong>（{{ pending.fileName }}）共读入
          <strong>{{ pending.newRules.length }}</strong> 条规则，检测到
          <strong>{{ pending.conflicts.length }}</strong> 处冲突。请按生效日与适用地区选定后再写入；
          选定前不写库，相关实寄封暂列待复核。
        </p>

        <p v-if="!pending.conflicts.length" class="reconcile__ok">
          本批次规则与库内现有规则无冲突，确认后写入 {{ pending.newRules.length }} 条规则。
        </p>

        <div v-else class="reconcile__groups">
          <div v-for="g in pending.conflicts" :key="g.key" class="reconcile__group">
            <div class="reconcile__pair">
              <div
                class="reconcile__rule"
                :class="{ 'is-chosen': pending.choices[g.key] === 'existing' }"
                @click="pending.choices[g.key] = 'existing'"
              >
                <header>
                  <el-radio :model-value="pending.choices[g.key]" value="existing">
                    现有规则
                  </el-radio>
                </header>
                <dl>
                  <div><dt>编号</dt><dd>{{ g.existing?.ruleNo || '—' }}</dd></div>
                  <div><dt>生效期间</dt><dd>{{ g.existing ? rulePeriod(g.existing) : '—' }}</dd></div>
                  <div><dt>适用地区</dt><dd>{{ g.existing ? ruleRegions(g.existing) : '—' }}</dd></div>
                  <div><dt>给据状态</dt><dd>{{ g.existing ? ruleScope(g.existing) : '—' }}</dd></div>
                  <div><dt>资费</dt><dd>{{ g.existing?.fee ?? '—' }} 元</dd></div>
                </dl>
              </div>
              <div class="reconcile__vs">VS</div>
              <div
                class="reconcile__rule"
                :class="{ 'is-chosen': pending.choices[g.key] === 'incoming' }"
                @click="pending.choices[g.key] = 'incoming'"
              >
                <header>
                  <el-radio :model-value="pending.choices[g.key]" value="incoming">
                    新导入规则
                  </el-radio>
                </header>
                <dl>
                  <div><dt>编号</dt><dd>{{ g.incoming.ruleNo }}</dd></div>
                  <div><dt>生效期间</dt><dd>{{ rulePeriod(g.incoming) }}</dd></div>
                  <div><dt>适用地区</dt><dd>{{ ruleRegions(g.incoming) }}</dd></div>
                  <div><dt>给据状态</dt><dd>{{ ruleScope(g.incoming) }}</dd></div>
                  <div><dt>资费</dt><dd>{{ g.incoming.fee }} 元</dd></div>
                </dl>
              </div>
            </div>
            <p class="reconcile__affected">
              涉及实寄封（{{ g.coverIds.length }}）：{{ coverNosOf(g.coverIds) }}
            </p>
          </div>
        </div>
      </template>
      <template #footer>
        <el-button @click="cancelImport">取消</el-button>
        <el-button type="primary" @click="confirmImport">确认写入</el-button>
      </template>
    </el-dialog>

    <!-- 手动新增规则对话框 -->
    <el-dialog v-model="ruleDialog" title="手动新增资费规则" width="560px">
      <el-form label-width="96px">
        <el-form-item label="规则编号">
          <el-input v-model="ruleForm.ruleNo" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="生效日期">
          <el-date-picker
            v-model="ruleForm.effectiveFrom"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="失效日期">
          <el-date-picker
            v-model="ruleForm.effectiveTo"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="适用地区">
          <el-select
            v-model="ruleForm.regions"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="输入后回车添加"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="给据状态">
          <el-radio-group v-model="ruleForm.registeredScope">
            <el-radio :value="null">皆可</el-radio>
            <el-radio :value="true">给据</el-radio>
            <el-radio :value="false">平信</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="资费(元)">
          <el-input-number v-model="ruleForm.fee" :min="0" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="ruleForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDialog = false">取消</el-button>
        <el-button type="primary" @click="submitRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.tariff-summary__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px 18px;
  margin: 0;
}
.tariff-summary__stats div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tariff-summary__stats dt {
  font-size: 12px;
  color: var(--gb-muted);
}
.tariff-summary__stats dd {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--gb-ink);
}
.tariff-summary__stats .is-matched {
  color: #1f7a4d;
}
.tariff-summary__stats .is-underpaid {
  color: #b02a1e;
}
.tariff-summary__stats .is-overpaid {
  color: #b06f16;
}
.tariff-summary__stats .is-pending {
  color: #1f4d8f;
}
.tariff-summary__hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.tariff-page__actions {
  display: flex;
  gap: 10px;
}
.reconcile__lead {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--gb-ink);
  line-height: 1.7;
}
.reconcile__ok {
  margin: 0 0 12px;
  font-size: 13px;
  color: #1f7a4d;
}
.reconcile__groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.reconcile__group {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  padding: 12px;
  background: #fffdf8;
}
.reconcile__pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 10px;
  align-items: stretch;
}
.reconcile__rule {
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  padding: 10px;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.reconcile__rule:hover {
  border-color: #8c3b2e;
}
.reconcile__rule.is-chosen {
  border-color: #8c3b2e;
  background: #fbf1ec;
}
.reconcile__rule header {
  margin-bottom: 6px;
}
.reconcile__rule dl {
  margin: 0;
  display: grid;
  gap: 4px;
}
.reconcile__rule dl div {
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.reconcile__rule dt {
  color: var(--gb-muted);
  min-width: 56px;
}
.reconcile__rule dd {
  margin: 0;
  color: var(--gb-ink);
  font-weight: 600;
}
.reconcile__vs {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--gb-muted);
}
.reconcile__affected {
  margin: 10px 0 0;
  font-size: 12px;
  color: #b06f16;
}
</style>
