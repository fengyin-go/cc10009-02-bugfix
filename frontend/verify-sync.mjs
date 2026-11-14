import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

// 单入口装配：local-service 与 template-store 共享同一份模块实例与缓存。
const result = await build({
  entryPoints: ['verify-entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
  alias: { '@': new URL('./src', import.meta.url).pathname },
})
writeFileSync('/tmp/app-bundle.mjs', result.outputFiles[0].text)

const mod = await import('/tmp/app-bundle.mjs')
const svc = mod
const ts = mod

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.error(`FAIL  ${name} ${extra}`)
  }
}
const findVersion = (code, v) =>
  ts.listTemplateVersions().items.find((r) => r.模板编号 === code && r.rowVersion === v)

ts.resetTemplateStore()

// ---------- 通用取数链路：listEntries('template') 只返回当前有效版本 ----------
const page = svc.listEntries('template')
const codes = page.items.map((r) => r.模板编号)
check('通用列表每个模板编号只出现一次（当前有效版本）', new Set(codes).size === codes.length && codes.length === 4, JSON.stringify(codes))
const t03Canonical = page.items.find((r) => r.模板编号 === 'TEMP-0003')
check('T-03 通用列表指向已启用 v2', t03Canonical.rowVersion === 2 && t03Canonical.status === '已启用')

// 通用动作通道拒绝模板越级调用
const blocked = svc.runAction('template', t03Canonical.id, '启用模板')
check('通用 runAction 拒绝直接操作模板（强制走版本引擎）', blocked.ok === false)

// ---------- 启用同步：extractor 清单出现映射行并只引用当前版本 ----------
const t01 = findVersion('TEMP-0001', 1)
await ts.runTemplateAction(t01.id, '提交校验')
const enable = await ts.runTemplateAction(t01.id, '启用模板')
check('TEMP-0001 启用成功', enable.ok)
const synced = svc.listEntries('extractor').items.filter((r) => r.关联模板编号 === 'TEMP-0001')
check('字段映射清单生成同步映射行', synced.length === 1 && synced[0].status === '已启用')
check('同步映射行引用具体模板版本 v1', synced[0].关联模板版本 === 'v1')
check('同步映射行带契约字段（源字段名称非空）', String(synced[0].源字段名称).length > 0)
check('同步映射行标记来源与同步状态', synced[0].同步来源 === '网页模板启用' && synced[0].同步状态 === '已同步')

// 重新校验出新版本并启用后，旧映射行停用、新映射行启用
const reVal = await ts.runTemplateAction(findVersion('TEMP-0001', 1).id, '重新校验')
check('启用态重新校验生成 v2 草稿', reVal.ok && reVal.version === 'v2')
const t01v2 = findVersion('TEMP-0001', 2)
await ts.runTemplateAction(t01v2.id, '提交校验')
const enable2 = await ts.runTemplateAction(t01v2.id, '启用模板')
check('v2 启用成功且旧 v1 被让位为废弃', enable2.ok)
const rowsFor01 = svc.listEntries('extractor').items.filter((r) => r.关联模板编号 === 'TEMP-0001')
const oldRule = rowsFor01.find((r) => r.关联模板版本 === 'v1')
const newRule = rowsFor01.find((r) => r.关联模板版本 === 'v2')
check('旧映射行停用留痕', oldRule.status === '已停用' && oldRule.同步状态 === '被新版本替换')
check('新映射行启用且只引用当前有效版本 v2', newRule.status === '已启用')
const t01Current = svc.listEntries('template').items.find((r) => r.模板编号 === 'TEMP-0001')
check('模板当前有效版本为 v2', t01Current.rowVersion === 2 && t01Current.status === '已启用')
const v1History = findVersion('TEMP-0001', 1)
check('v1 历史版本状态为已废弃且记录保留', v1History.status === '已废弃' && v1History.原始模板版本 === '抽取模板样例1')

// ---------- 废弃同步停用 ----------
const dep = await ts.runTemplateAction(findVersion('TEMP-0001', 2).id, '废弃模板')
check('v2 废弃成功', dep.ok)
const ruleAfterDep = svc.listEntries('extractor').items.find((r) => r.关联模板版本 === 'v2')
check('废弃后映射行同步停用', ruleAfterDep.status === '已停用' && ruleAfterDep.同步状态 === '已随模板废弃')

// ---------- 通用模块状态机：extractor 越级动作被服务端拒绝 ----------
const anyRule = svc.listEntries('extractor').items[0]
const jump = svc.runAction('extractor', anyRule.id, '启用规则')
// 第一条是种子草稿行，草稿 -> 已启用 属于越级
check('字段映射草稿直接启用（越级）被拒绝', jump.ok === false && jump.message.includes('单向推进'), jump.message)
const back = svc.runAction('extractor', anyRule.id, '停用规则')
check('字段映射草稿直接停用（越级）被拒绝', back.ok === false)

// ---------- 事务回滚：注入存储故障，状态必须退回且给出可恢复位置 ----------
const t17 = findVersion('TEMP-0017', 1)
const beforeStatus = t17.status
ts.__setFaultInjection(true)
const rollback = await ts.runTemplateAction(t17.id, '提交校验')
ts.__setFaultInjection(false)
check('存储故障时动作失败并提示已回滚', rollback.ok === false && rollback.message.includes('回滚'), rollback.message)
check('回滚结果保留可恢复位置（retryFrom）', !!rollback.retryFrom && rollback.retryFrom.includes('草稿'), rollback.retryFrom ?? '')
const t17After = findVersion('TEMP-0017', 1)
check('回滚后 T-17 退回草稿且未留下校验痕迹', t17After.status === '草稿' && t17After.校验结论 === '未校验')

const invalid = await ts.runTemplateAction(999999, '启用模板')
check('不存在的版本直接拒绝', invalid.ok === false)

// ---------- 并发废弃：只接受首个请求 ----------
const t02Current = ts
  .listTemplateVersions()
  .items.filter((r) => r.模板编号 === 'TEMP-0002')
  .sort((a, b) => b.rowVersion - a.rowVersion)[0]
if (t02Current.status === '草稿') {
  await ts.runTemplateAction(t02Current.id, '提交校验')
}
const t02Pending = findVersion('TEMP-0002', t02Current.rowVersion)
if (t02Pending.status === '待校验') {
  await ts.runTemplateAction(t02Pending.id, '启用模板')
}
const t02Enabled = findVersion('TEMP-0002', t02Current.rowVersion)
const [d1, d2] = await Promise.all([
  ts.runTemplateAction(t02Enabled.id, '废弃模板'),
  ts.runTemplateAction(t02Enabled.id, '废弃模板'),
])
check('并发废弃只接受首个请求', d1.ok === true && d2.ok === false, `${d1.message} | ${d2.message}`)
check('T-17 全程未被污染，状态保持草稿', findVersion('TEMP-0017', 1).status === beforeStatus)

// ---------- 导出：版本清单包含全部历史版本 ----------
const exported = svc.exportEntries('template')
check('导出文件名体现版本清单', exported.filename.includes('版本清单'))
check('导出内容包含 T-03 的 v1 与 v2', exported.content.includes('v1') && exported.content.includes('v2'))
check('导出内容包含校验结论列', exported.content.includes('校验结论'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
