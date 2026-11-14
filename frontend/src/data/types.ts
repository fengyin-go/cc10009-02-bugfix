/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

/** 字段映射契约中的单条映射：模板校验通过后固化，启用时同步给字段映射业务面。 */
export type MappingContractItem = {
  源字段: string
  目标字段: string
  数据类型: string
  必填: boolean
}

/** 模板校验结论，缺失项只可能来自入口地址、列表选择器、分页规则三个必填入口。 */
export type ValidationSummary = {
  结论: '通过' | '未通过' | '未校验'
  缺失项: string[]
  校验时间: string
  契约: MappingContractItem[]
}

/**
 * 网页模板的版本记录。同一个「模板编号」下每次提交校验/重新校验都会新增一行版本，
 * 历史版本只读保留，状态只能按 草稿 -> 待校验 -> 已启用 -> 已废弃 单向推进。
 */
export type TemplateVersionRow = EntryRow & {
  模板编号: string
  rowVersion: number
  校验结论: '通过' | '未通过' | '未校验'
  校验时间: string
  校验缺失项: string
  字段映射契约: string
  启用时间: string
  废弃时间: string
  原始模板版本: string
}

/** 模板启用/废弃与字段映射清单之间的同步留痕，失败时用于定位可恢复位置。 */
export type TemplateSyncRecord = {
  时间: string
  模板编号: string
  模板版本: string
  动作: string
  结果: '成功' | '失败'
  映射规则编号: string
  信息: string
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 动作命中的模板版本（如 v2），便于页面与重试提示定位。 */
  version?: string
  /** 事务回滚后建议恢复的版本位置。 */
  retryFrom?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
