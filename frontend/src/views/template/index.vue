<template>
  <section class="page" data-module="template">
    <header class="page-head">
      <div>
        <h2>抽取模板管理</h2>
        <p class="page-desc">
          网页模板按「草稿 → 待校验 → 已启用 → 已废弃」单向推进，越级与倒序操作会被拒绝；
          重新校验生成新版本，历史版本只读保留，启用结果同步到字段映射清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记网页模板</button>
        <button class="btn" type="button" @click="exportRows">导出模板版本清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-hint">同编号只允许一个当前有效版本，其余为只读历史版本</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>校验结论</th>
          <th>当前状态</th>
          <th>版本性质</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'history-row': !isCurrent(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['badge', validationClass(row.校验结论)]">{{ row.校验结论 }}</span>
            <span v-if="row.校验缺失项" class="missing-hint">缺：{{ row.校验缺失项 }}</span>
          </td>
          <td><span :class="['status-pill', `status-${statusOrder(row.status)}`]">{{ row.status }}</span></td>
          <td>
            <span v-if="isCurrent(row)" class="badge badge-current">当前版本</span>
            <span v-else class="badge badge-history">历史版本（只读）</span>
          </td>
          <td class="row-actions">
            <template v-if="isCurrent(row)">
              <button
                v-for="action in availableActions(row)"
                :key="action"
                class="link"
                type="button"
                :disabled="busyKey === actionKey(row, action)"
                @click="runAction(action, row)"
              >
                {{ busyKey === actionKey(row, action) ? '处理中…' : action }}
              </button>
              <span v-if="!availableActions(row).length" class="muted-text">已到终态，无可用动作</span>
            </template>
            <span v-else class="muted-text">历史版本不可操作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无抽取模板数据，可先登记网页模板</td>
        </tr>
      </tbody>
    </table>

    <section v-if="syncs.length" class="sync-panel">
      <h3>字段映射清单同步留痕</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th><th>模板编号</th><th>模板版本</th><th>动作</th><th>结果</th><th>映射规则编号</th><th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, idx) in syncs" :key="idx">
            <td>{{ item.时间 }}</td>
            <td>{{ item.模板编号 }}</td>
            <td>{{ item.模板版本 }}</td>
            <td>{{ item.动作 }}</td>
            <td><span :class="['badge', item.结果 === '成功' ? 'badge-pass' : 'badge-fail']">{{ item.结果 }}</span></td>
            <td>{{ item.映射规则编号 }}</td>
            <td>{{ item.信息 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条模板版本记录（{{ templateCount }} 个模板编号）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  availableActions,
  getTemplateStats,
  listTemplateSyncs,
  listTemplateVersions,
  runTemplateAction,
} from '@/data/template-store'
import type { TemplateSyncRecord, TemplateVersionRow } from '@/data/types'

const meta = moduleMeta('template')
const columns = [
  '模板编号',
  '模板版本',
  '入口地址',
  '列表选择器',
  '详情选择器',
  '分页规则',
  '字段映射',
  '数据格式',
]
const statuses = ['草稿', '待校验', '已启用', '已废弃']

const rows = ref<TemplateVersionRow[]>([])
const syncs = ref<TemplateSyncRecord[]>([])
const total = ref(0)
const templateCount = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const busyKey = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => {
  const s = getTemplateStats()
  return [
    { label: '模板编号数 / 版本总数', value: `${s.templateCount} / ${s.versionCount}` },
    { label: '草稿', value: s.draft },
    { label: '待校验', value: s.pending },
    { label: '已启用', value: s.enabled },
    { label: '已废弃', value: s.deprecated },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => isCurrent(row) && String(row.status) === status).length,
  })),
)

const latestVersionByCode = computed(() => {
  const map = new Map<string, number>()
  for (const row of rows.value) {
    map.set(row.模板编号, Math.max(map.get(row.模板编号) ?? 0, row.rowVersion))
  }
  return map
})

function isCurrent(row: TemplateVersionRow): boolean {
  return latestVersionByCode.value.get(row.模板编号) === row.rowVersion
}

function statusOrder(status: string): number {
  const idx = statuses.indexOf(status)
  return idx < 0 ? 0 : idx
}

function validationClass(conclusion: string): string {
  if (conclusion === '通过') {
    return 'badge-pass'
  }
  if (conclusion === '未通过') {
    return 'badge-fail'
  }
  return 'badge-idle'
}

function actionKey(row: TemplateVersionRow, action: string): string {
  return `${row.id}:${action}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '网页模板登记入口尚未接入审批流'
  successMessage.value = ''
}

async function runAction(action: string, row: TemplateVersionRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const key = actionKey(row, action)
  if (busyKey.value === key) {
    return
  }
  busyKey.value = key
  try {
    const result = await runTemplateAction(Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.retryFrom
        ? `${result.message}（可恢复位置：${result.retryFrom}）`
        : result.message
      return
    }
    successMessage.value = result.message
    reload()
  } finally {
    busyKey.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  const payload = listTemplateVersions(filters.value)
  rows.value = payload.items
  total.value = payload.total
  templateCount.value = new Set(payload.items.map((row) => row.模板编号)).size
  syncs.value = listTemplateSyncs()
}

onMounted(reload)
</script>
