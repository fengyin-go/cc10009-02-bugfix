import { listRows, saveRows } from './local-store'
import { SEED_ROWS } from './seed'
import type {
  ActionResult,
  EntryRow,
  MappingContractItem,
  TemplateSyncRecord,
  TemplateVersionRow,
  ValidationSummary,
} from './types'

/**
 * 网页模板版本领域引擎。
 *
 * 修复要点（对应现场问题）：
 * - 状态只能按 草稿 -> 待校验 -> 已启用 -> 已废弃 单向推进，越级/倒序一律拒绝；
 * - 提交校验前强制校验入口地址、列表选择器、分页规则三个必填入口，缺失项逐条说明；
 * - 重新校验生成新 rowVersion 的新记录，旧版本只读保留，编号与历史字段不改写；
 * - 同一模板的写动作加进程内互斥锁，并发只接受首个请求，重复点击不会生成第二版本；
 * - 启用结果（含字段映射契约）同步写入字段映射业务面，提交失败整体回滚并给出可恢复位置。
 */

export const TEMPLATE_STATUSES = ['草稿', '待校验', '已启用', '已废弃'] as const
const TEMPLATE_ACTION_TARGET: Record<string, string> = {
  提交校验: '待校验',
  启用模板: '已启用',
  废弃模板: '已废弃',
}
/** 三个必填入口：校验缺失提示与现场口径保持一致。 */
export const TEMPLATE_REQUIRED_FIELDS = ['入口地址', '列表选择器', '分页规则'] as const
const TEMPLATE_STORAGE_KEY = 'scraper-config-studio:template-versions'
const TEMPLATE_SYNC_KEY = 'scraper-config-studio:template-sync-records'
const EXTRACTOR_KEY = 'extractor'

type PersistState = {
  versions: TemplateVersionRow[]
  nextId: number
  syncs: TemplateSyncRecord[]
}

/** 同模板同动作的在途锁：纯前端没有后端事务，用进程内互斥模拟「只接受首个请求」。 */
const inflight = new Set<string>()

/** 测试用故障注入：置位后 persist 抛错，用来验证事务回滚与可恢复位置。 */
let faultInjection = false
export function __setFaultInjection(enabled: boolean): void {
  faultInjection = enabled
}

let cache: PersistState | null = null

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fail(message: string, version?: string, retryFrom?: string): ActionResult {
  return { ok: false, message, version, retryFrom }
}

/** 把模板上的「字段映射」文本解析成契约；新模板可直接写 JSON 数组，老样例按顿号/逗号拆分。 */
export function buildContract(input: Record<string, unknown>): MappingContractItem[] {
  const raw = String(input.字段映射 ?? '').trim()
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is MappingContractItem => !!item && typeof item === 'object')
        .map((item) => ({
          源字段: String(item.源字段 ?? ''),
          目标字段: String(item.目标字段 ?? ''),
          数据类型: String(item.数据类型 ?? '字符串'),
          必填: Boolean(item.必填),
        }))
    }
  } catch {
    // 不是 JSON 就走文本拆分，兼容历史样例数据。
  }
  return raw
    .split(/[、,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ 源字段: part, 目标字段: part, 数据类型: '字符串', 必填: true }))
}

/** 模板校验：三个必填入口缺一不可，通过时同时固化字段映射契约。 */
export function validateTemplate(input: Record<string, unknown>): ValidationSummary {
  const missing = TEMPLATE_REQUIRED_FIELDS.filter((field) =>
    String(input[field] ?? '').trim() === '',
  )
  return {
    结论: missing.length === 0 ? '通过' : '未通过',
    缺失项: [...missing],
    校验时间: nowText(),
    契约: missing.length === 0 ? buildContract(input) : [],
  }
}

function makeVersionRow(
  base: EntryRow,
  rowVersion: number,
  status: string,
  validation: ValidationSummary,
  extra: Partial<TemplateVersionRow> = {},
): TemplateVersionRow {
  return {
    ...clone(base),
    id: extra.id ?? base.id,
    模板编号: String(base.模板编号 ?? ''),
    status,
    pending: status !== TEMPLATE_STATUSES[TEMPLATE_STATUSES.length - 1],
    校验结论: validation.结论,
    校验时间: validation.校验时间,
    校验缺失项: validation.缺失项.join('、'),
    字段映射契约: JSON.stringify(validation.契约),
    启用时间: extra.启用时间 ?? '',
    废弃时间: extra.废弃时间 ?? '',
    rowVersion,
    模板版本: `v${rowVersion}`,
    原始模板版本: extra.原始模板版本 ?? String(base.模板版本 ?? ''),
    ...extra,
  }
}

/**
 * 首次播种：迁移既有三条模板（编号/历史字段原样保留），并补两条现场样本——
 * TEMP-0017 列表选择器为空的草稿；TEMP-0003 追加已废弃 v1，与已启用 v2 分成两条版本记录。
 */
function seedState(): PersistState {
  const baseRows = SEED_ROWS.template ?? []
  const versions: TemplateVersionRow[] = []
  const seededTime = '2026-11-10 09:00:00'
  let id = 1

  for (const base of baseRows) {
    const code = String(base.模板编号 ?? '')
    const validation: ValidationSummary = {
      结论: base.status === '草稿' ? '未校验' : '通过',
      缺失项: [],
      校验时间: base.status === '草稿' ? '' : seededTime,
      契约: base.status === '草稿' ? [] : buildContract(base),
    }
    if (code === 'TEMP-0003') {
      // 现场复测 T-03：废弃后再启用不能共用同一版本，v1 废弃留痕、v2 启用为当前版本。
      const deprecated = makeVersionRow(base, 1, '已废弃', {
        结论: '通过',
        缺失项: [],
        校验时间: seededTime,
        契约: buildContract(base),
      }, {
        id: id++,
        abnormal: false,
        pending: false,
        启用时间: seededTime,
        废弃时间: seededTime,
        原始模板版本: String(base.模板版本 ?? ''),
      })
      versions.push(deprecated)
      versions.push(
        makeVersionRow(base, 2, '已启用', {
          结论: '通过',
          缺失项: [],
          校验时间: seededTime,
          契约: buildContract(base),
        }, {
          id: id++,
          abnormal: Boolean(base.abnormal),
          pending: false,
          启用时间: seededTime,
          原始模板版本: String(base.模板版本 ?? ''),
        }),
      )
      continue
    }
    versions.push(
      makeVersionRow(base, 1, String(base.status), validation, {
        id: id++,
        abnormal: Boolean(base.abnormal),
        原始模板版本: String(base.模板版本 ?? ''),
      }),
    )
  }

  // 现场样本 T-17：列表选择器为空，提交校验必须被拒绝并指明缺失项。
  const t17: EntryRow = {
    id: id,
    status: '草稿',
    pending: true,
    abnormal: false,
    模板编号: 'TEMP-0017',
    入口地址: 'https://example.test/t17/list',
    列表选择器: '',
    详情选择器: '.detail-card',
    分页规则: 'page={{page}}',
    字段映射: 'title、publishTime',
    数据格式: 'HTML',
    模板版本: 'v1',
  }
  versions.push(
    makeVersionRow(t17, 1, '草稿', {
      结论: '未校验',
      缺失项: [],
      校验时间: '',
      契约: [],
    }, { id: id++, 原始模板版本: '' }),
  )

  return { versions, nextId: id, syncs: [] }
}

function readState(): PersistState {
  const seeded = seedState()
  if (!hasStorage()) {
    return seeded
  }
  try {
    const raw = window.localStorage.getItem(TEMPLATE_STORAGE_KEY)
    const syncRaw = window.localStorage.getItem(TEMPLATE_SYNC_KEY)
    if (!raw) {
      return seeded
    }
    const parsed = JSON.parse(raw) as Pick<PersistState, 'versions' | 'nextId'>
    const syncs = syncRaw ? (JSON.parse(syncRaw) as TemplateSyncRecord[]) : []
    return {
      versions: Array.isArray(parsed.versions) ? parsed.versions : seeded.versions,
      nextId: typeof parsed.nextId === 'number' ? parsed.nextId : seeded.nextId,
      syncs: Array.isArray(syncs) ? syncs : [],
    }
  } catch {
    return seeded
  }
}

function persist(state: PersistState): void {
  mirrorCanonical(state)
  if (faultInjection) {
    throw new Error('注入的存储提交故障')
  }
  if (!hasStorage()) {
    return
  }
  window.localStorage.setItem(
    TEMPLATE_STORAGE_KEY,
    JSON.stringify({ versions: state.versions, nextId: state.nextId }),
  )
  window.localStorage.setItem(TEMPLATE_SYNC_KEY, JSON.stringify(state.syncs))
}

function ensure(): PersistState {
  if (cache === null) {
    cache = readState()
    mirrorCanonical(cache)
  }
  return cache
}

function versionOf(row: TemplateVersionRow): string {
  return `v${row.rowVersion}`
}

function maxRowVersion(versions: TemplateVersionRow[], code: string): number {
  return versions
    .filter((row) => row.模板编号 === code)
    .reduce((max, row) => Math.max(max, row.rowVersion), 0)
}

/** 每个模板编号只保留 rowVersion 最大的一条作为当前版本，其余都是只读历史版本。 */
export function canonicalRows(versions: TemplateVersionRow[]): TemplateVersionRow[] {
  const picked = new Map<string, TemplateVersionRow>()
  for (const row of versions) {
    const current = picked.get(row.模板编号)
    if (!current || row.rowVersion > current.rowVersion) {
      picked.set(row.模板编号, row)
    }
  }
  return versions.filter((row) => picked.get(row.模板编号)?.id === row.id)
}

function mirrorCanonical(state: PersistState): void {
  // 通用取数链路（列表/概览/导出）读到的 template 数据永远是当前有效版本。
  saveRows('template', clone(canonicalRows(state.versions)) as EntryRow[])
}

function matches(row: TemplateVersionRow, filters: Record<string, string>): boolean {
  return Object.entries(filters)
    .filter(([, value]) => value.trim() !== '')
    .every(([field, value]) => String(row[field] ?? '').includes(value.trim()))
}

export function listTemplateVersions(filters: Record<string, string> = {}): {
  items: TemplateVersionRow[]
  total: number
  page: number
  size: number
} {
  const state = ensure()
  const items = state.versions.filter((row) => matches(row, filters))
  return { items, total: items.length, page: 1, size: items.length }
}

export function getTemplateStats(): {
  templateCount: number
  versionCount: number
  draft: number
  pending: number
  enabled: number
  deprecated: number
} {
  const state = ensure()
  const canonical = canonicalRows(state.versions)
  const count = (status: string) => canonical.filter((row) => row.status === status).length
  return {
    templateCount: canonical.length,
    versionCount: state.versions.length,
    draft: count('草稿'),
    pending: count('待校验'),
    enabled: count('已启用'),
    deprecated: count('已废弃'),
  }
}

export function listTemplateSyncs(): TemplateSyncRecord[] {
  return ensure().syncs
}

export function latestEnabledTemplates(): TemplateVersionRow[] {
  return canonicalRows(ensure().versions).filter((row) => row.status === '已启用')
}

export function availableActions(row: TemplateVersionRow): string[] {
  const state = ensure()
  if (row.rowVersion < maxRowVersion(state.versions, row.模板编号)) {
    return []
  }
  switch (row.status) {
    case '草稿':
      return ['提交校验']
    case '待校验':
      return ['启用模板', '重新校验']
    case '已启用':
      return ['废弃模板', '重新校验']
    case '已废弃':
    default:
      return []
  }
}

function parseContract(row: TemplateVersionRow): MappingContractItem[] {
  try {
    const parsed = JSON.parse(row.字段映射契约) as unknown
    return Array.isArray(parsed) ? (parsed as MappingContractItem[]) : []
  } catch {
    return []
  }
}

function mappingRuleCode(row: TemplateVersionRow): string {
  return `EXTR-${row.模板编号.replace('TEMP-', 'T')}-${versionOf(row)}`
}

/** 启用模板：契约落成字段映射清单的新启用行，同模板旧映射行停用留痕。 */
function syncExtractorOnEnable(
  state: PersistState,
  row: TemplateVersionRow,
): TemplateSyncRecord {
  const extractorRows = listRows(EXTRACTOR_KEY)
  const nextExtractor = extractorRows.map((item) => {
    if (item.关联模板编号 !== row.模板编号 || item.status !== '已启用') {
      return item
    }
    return {
      ...item,
      status: '已停用',
      pending: false,
      同步状态: '被新版本替换',
      同步时间: nowText(),
    }
  })
  const contract = parseContract(row)
  const nextId = nextExtractor.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  nextExtractor.push({
    id: nextId,
    status: '已启用',
    pending: false,
    abnormal: false,
    规则编号: mappingRuleCode(row),
    源字段名称: contract.map((item) => item.源字段).join('、'),
    目标字段名称: contract.map((item) => item.目标字段).join('、'),
    数据类型转换: contract.map((item) => item.数据类型).join('、'),
    默认填充值: '',
    清洗表达式: '',
    必填标识: contract.every((item) => item.必填) ? '是' : '否',
    唯一性校验: '否',
    关联模板编号: row.模板编号,
    关联模板版本: versionOf(row),
    同步来源: '网页模板启用',
    同步状态: '已同步',
    同步时间: nowText(),
  })
  saveRows(EXTRACTOR_KEY, nextExtractor)
  const record: TemplateSyncRecord = {
    时间: nowText(),
    模板编号: row.模板编号,
    模板版本: versionOf(row),
    动作: '启用模板',
    结果: '成功',
    映射规则编号: mappingRuleCode(row),
    信息: `字段映射契约已同步 ${contract.length} 个字段到字段映射清单`,
  }
  state.syncs.push(record)
  return record
}

/** 废弃模板：对应字段映射行同步停用，另一业务面不再引用失效版本。 */
function syncExtractorOnDeprecate(
  state: PersistState,
  row: TemplateVersionRow,
): TemplateSyncRecord {
  const extractorRows = listRows(EXTRACTOR_KEY)
  let ruleCode = mappingRuleCode(row)
  const nextExtractor = extractorRows.map((item) => {
    if (
      item.关联模板编号 === row.模板编号 &&
      item.关联模板版本 === versionOf(row) &&
      item.status === '已启用'
    ) {
      ruleCode = String(item.规则编号)
      return {
        ...item,
        status: '已停用',
        pending: false,
        同步状态: '已随模板废弃',
        同步时间: nowText(),
      }
    }
    return item
  })
  saveRows(EXTRACTOR_KEY, nextExtractor)
  const record: TemplateSyncRecord = {
    时间: nowText(),
    模板编号: row.模板编号,
    模板版本: versionOf(row),
    动作: '废弃模板',
    结果: '成功',
    映射规则编号: ruleCode,
    信息: '字段映射清单已随模板废弃同步停用',
  }
  state.syncs.push(record)
  return record
}

function rejectionForStatus(row: TemplateVersionRow, action: string): string | null {
  const currentIdx = TEMPLATE_STATUSES.indexOf(row.status as (typeof TEMPLATE_STATUSES)[number])
  if (action === '重新校验') {
    if (row.status === '草稿') {
      return `网页模板 ${row.模板编号} ${versionOf(row)} 仍是草稿，请先「提交校验」，无需重新校验`
    }
    if (row.status === '已废弃') {
      return '已废弃是终态，不能倒序操作；如需恢复请重新登记模板并走校验流程生成新版本'
    }
    return null
  }
  const target = TEMPLATE_ACTION_TARGET[action]
  if (!target) {
    return `网页模板没有登记「${action}」这个动作`
  }
  const targetIdx = TEMPLATE_STATUSES.indexOf(target as (typeof TEMPLATE_STATUSES)[number])
  if (targetIdx !== currentIdx + 1) {
    const expect = TEMPLATE_STATUSES[currentIdx + 1]
      ? `，下一步只允许进入「${TEMPLATE_STATUSES[currentIdx + 1]}」`
      : '，当前已是终态'
    return `网页模板 ${row.模板编号} ${versionOf(row)} 当前为「${row.status}」，不能执行「${action}」跳到「${target}」${expect}；状态只能按 草稿→待校验→已启用→已废弃 单向推进`
  }
  return null
}

/** 模板动作统一入口：并发互斥 + 状态机守卫 + 事务回滚。 */
export async function runTemplateAction(id: number, action: string): Promise<ActionResult> {
  const state = ensure()
  const index = state.versions.findIndex((row) => row.id === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的网页模板版本记录`)
  }
  const row = state.versions[index]
  const lockKey = `${row.模板编号}:${action}`
  if (inflight.has(lockKey)) {
    return fail(
      `网页模板 ${row.模板编号} 的「${action}」仍在处理中，重复提交已被拦截，不会生成第二版本`,
      versionOf(row),
    )
  }

  if (row.rowVersion < maxRowVersion(state.versions, row.模板编号)) {
    return fail(
      `网页模板 ${row.模板编号} ${versionOf(row)} 是只读历史版本，动作只能作用于当前版本 v${maxRowVersion(state.versions, row.模板编号)}`,
      versionOf(row),
    )
  }
  const rejection = rejectionForStatus(row, action)
  if (rejection) {
    return fail(rejection, versionOf(row))
  }

  inflight.add(lockKey)
  const versionSnapshot = clone(state.versions)
  const extractorSnapshot = clone(listRows(EXTRACTOR_KEY))
  const nextIdSnapshot = state.nextId
  try {
    // 让出事件循环，构造真实并发窗口：第二个请求会命中 inflight 锁。
    await Promise.resolve()

    if (action === '提交校验') {
      const validation = validateTemplate(row)
      if (validation.结论 === '未通过') {
        state.versions[index] = {
          ...row,
          校验结论: '未通过',
          校验时间: validation.校验时间,
          校验缺失项: validation.缺失项.join('、'),
          字段映射契约: '[]',
          abnormal: true,
        }
        persist(state)
        return fail(
          `校验未通过，网页模板 ${row.模板编号} 缺少必填入口：${validation.缺失项.join('、')}。请补齐上述字段后重新提交校验`,
          versionOf(row),
        )
      }
      state.versions[index] = {
        ...row,
        status: '待校验',
        pending: true,
        abnormal: false,
        校验结论: '通过',
        校验时间: validation.校验时间,
        校验缺失项: '',
        字段映射契约: JSON.stringify(validation.契约),
      }
      persist(state)
      return {
        ok: true,
        message: `网页模板 ${row.模板编号} ${versionOf(row)} 校验通过，字段映射契约已固化（${validation.契约.length} 个字段），当前状态「待校验」`,
        version: versionOf(row),
      }
    }

    if (action === '重新校验') {
      const nextVersion = maxRowVersion(state.versions, row.模板编号) + 1
      const draft: TemplateVersionRow = {
        ...clone(row),
        id: state.nextId++,
        status: '草稿',
        pending: true,
        abnormal: false,
        rowVersion: nextVersion,
        模板版本: `v${nextVersion}`,
        校验结论: '未校验',
        校验时间: '',
        校验缺失项: '',
        字段映射契约: '[]',
        启用时间: '',
        废弃时间: '',
      }
      state.versions.push(draft)
      persist(state)
      return {
        ok: true,
        message: `已基于 ${row.模板编号} ${versionOf(row)} 生成草稿版本 v${nextVersion}，旧版本按原口径保留；请对 v${nextVersion} 重新提交校验`,
        version: `v${nextVersion}`,
      }
    }

    if (action === '启用模板') {
      if (row.校验结论 !== '通过') {
        return fail(
          `网页模板 ${row.模板编号} ${versionOf(row)} 尚未通过校验，不能启用`,
          versionOf(row),
        )
      }
      // 同模板旧启用版本先让位（向前流转为已废弃），冲突时以当前通过校验的新版本为准。
      for (const candidate of state.versions) {
        if (
          candidate.模板编号 === row.模板编号 &&
          candidate.id !== row.id &&
          candidate.status === '已启用'
        ) {
          candidate.status = '已废弃'
          candidate.pending = false
          candidate.废弃时间 = nowText()
        }
      }
      state.versions[index] = { ...row, status: '已启用', pending: false, 启用时间: nowText() }
      const record = syncExtractorOnEnable(state, state.versions[index])
      persist(state)
      return {
        ok: true,
        message: `网页模板 ${row.模板编号} ${versionOf(row)} 已启用，${record.信息}，字段映射清单同步完成`,
        version: versionOf(row),
      }
    }

    if (action === '废弃模板') {
      state.versions[index] = {
        ...row,
        status: '已废弃',
        pending: false,
        废弃时间: nowText(),
      }
      const record = syncExtractorOnDeprecate(state, state.versions[index])
      persist(state)
      return {
        ok: true,
        message: `网页模板 ${row.模板编号} ${versionOf(row)} 已废弃，${record.信息}；废弃为终态，不能再回到已启用`,
        version: versionOf(row),
      }
    }

    return fail(`网页模板没有登记「${action}」这个动作`, versionOf(row))
  } catch (error) {
    // 事务提交失败：模板版本与字段映射清单整体退回动作前快照，并保留可恢复位置。
    state.versions = versionSnapshot
    state.nextId = nextIdSnapshot
    saveRows(EXTRACTOR_KEY, extractorSnapshot)
    const injectionWasOn = faultInjection
    faultInjection = false
    mirrorCanonical(state)
    faultInjection = injectionWasOn
    const detail = error instanceof Error ? error.message : '未知错误'
    return fail(
      `「${action}」事务提交失败，已回滚到动作前状态（${detail}），可从 ${row.模板编号} ${versionOf(row)}（${row.status}）重新发起`,
      versionOf(row),
      `${versionOf(row)}（${row.status}）`,
    )
  } finally {
    inflight.delete(lockKey)
  }
}

/** 重置模板版本库（测试与 resetModule 使用）：重新播种并同步镜像。 */
export function resetTemplateStore(): void {
  cache = seedState()
  if (hasStorage()) {
    window.localStorage.removeItem(TEMPLATE_STORAGE_KEY)
    window.localStorage.removeItem(TEMPLATE_SYNC_KEY)
  }
  mirrorCanonical(cache)
}
