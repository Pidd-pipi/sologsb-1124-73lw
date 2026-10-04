<script setup lang="ts">
import { computed } from 'vue'
import { VERIFY_STATUS_META, type VerifyResult } from '@/types/tariff'

const props = withDefaults(
  defineProps<{
    result: VerifyResult | null
    /** 是否显示短欠金额 */
    showShortfall?: boolean
  }>(),
  { showShortfall: false }
)

const meta = computed(() => (props.result ? VERIFY_STATUS_META[props.result.status] : null))
</script>

<template>
  <el-tag v-if="meta" :type="meta.type" size="small" effect="plain">
    {{ meta.label }}
    <template v-if="showShortfall && result?.status === 'underpaid'">
      欠 {{ result.shortfall }} 元
    </template>
  </el-tag>
  <span v-else class="tariff-tag--empty">—</span>
</template>

<style scoped>
.tariff-tag--empty {
  color: var(--gb-muted);
}
</style>
