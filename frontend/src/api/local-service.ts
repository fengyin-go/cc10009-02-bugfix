import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { listTemplateVersions, resetTemplateStore } from '@/data/template-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TemplateVersionRow,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 状态严格按元数据顺序单向推进的模块（含分支的 spider/rpaflow 不在此列，保留其业务分支）。
// template 走独立的模板版本引擎，也不经过通用动作通道。
const STRICT_LINEAR_KEYS = new Set([
  'site',
  'schedule',
  'antibot',
  'ratelimit',
  'retry',
  'extractor',
  'pipeline',
  'validator',
  'storage',
  'monitor',
  'cleanse',
  'export',
  'auth',
  'delta',
  'proxy',
])

// 通用动作的短窗口在途锁：同一模块同一行的快速连点只放行第一个，窗口结束自动释放。
const inflightActions = new Set<string>()

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === 'template') {
    // 模板统一从版本库取数，通用链路看到的永远是每个模板编号的当前有效版本。
    const payload = listTemplateVersions(filters)
    const canonical: EntryRow[] = payload.items.filter(
      (row) =>
        row.rowVersion ===
        payload.items
          .filter((item) => item.模板编号 === row.模板编号)
          .reduce((max, item) => Math.max(max, item.rowVersion), 0),
    )
    return { items: canonical, total: canonical.length, page: 1, size: canonical.length }
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === 'template') {
    return {
      ok: false,
      message: '网页模板动作必须走模板版本引擎（runTemplateAction），通用动作通道已拒绝越级调用',
    }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const inflightKey = `${key}:${id}:${action}`
  if (inflightActions.has(inflightKey)) {
    return { ok: false, message: `${meta.entity}#${id} 的「${action}」正在处理，重复点击已被拦截` }
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  if (STRICT_LINEAR_KEYS.has(key)) {
    const currentIdx = meta.statuses.indexOf(current)
    const targetIdx = meta.statuses.indexOf(target)
    if (targetIdx < 0 || currentIdx < 0 || targetIdx !== currentIdx + 1) {
      const next = currentIdx >= 0 && currentIdx + 1 < meta.statuses.length
        ? `，下一步只允许进入「${meta.statuses[currentIdx + 1]}」`
        : '，当前已是终态'
      return {
        ok: false,
        message:
          `${meta.entity}#${id} 当前为「${current}」，不能执行「${action}」跳到「${target}」${next}；` +
          `状态只能按 ${meta.statuses.join('→')} 单向推进，越级或倒序操作已拒绝`,
      }
    }
  }

  inflightActions.add(inflightKey)
  try {
    const lastStatus = meta.statuses[meta.statuses.length - 1]
    const updated: EntryRow = {
      ...rows[index],
      status: target,
      pending: target !== lastStatus,
      abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    }
    const next = [...rows]
    next[index] = updated
    saveRows(key, next)
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  } finally {
    // 同步动作完成后保留一个短窗口，覆盖快速连续点击产生的同步重入。
    setTimeout(() => inflightActions.delete(inflightKey), 400)
  }
}

export function resetModule(key: string): PageResult {
  if (key === 'template') {
    resetTemplateStore()
    return listEntries(key)
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === 'template') {
    // 历史版本按原口径全部导出，版本号/校验结论/同步信息随清单呈现。
    const { items } = listTemplateVersions()
    const header = [
      '编号',
      ...meta.fields,
      '版本序号',
      '校验结论',
      '校验缺失项',
      '字段映射契约',
      '启用时间',
      '废弃时间',
      '当前状态',
    ]
    const lines = [header.join(',')]
    for (const row of items as TemplateVersionRow[]) {
      lines.push(
        [
          row.id,
          ...meta.fields.map((field) => row[field] ?? ''),
          `v${row.rowVersion}`,
          row.校验结论,
          row.校验缺失项,
          row.字段映射契约,
          row.启用时间,
          row.废弃时间,
          row.status,
        ]
          .map((cell) => String(cell).replace(/"/g, '""'))
          .map((cell) => `"${cell}"`)
          .join(','),
      )
    }
    return { filename: `${meta.name}-版本清单.csv`, content: `\uFEFF${lines.join('\n')}` }
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
