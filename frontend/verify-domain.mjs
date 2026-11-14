import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

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
const {
  listTemplateVersions,
  runTemplateAction,
  getTemplateStats,
  canonicalRows,
  resetTemplateStore,
  listTemplateSyncs,
  latestEnabledTemplates,
} = mod

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

function byId(rows, id) {
  return rows.find((r) => r.id === id)
}
function byCodeVersion(rows, code, v) {
  return rows.find((r) => r.模板编号 === code && r.rowVersion === v)
}

// ---------- 初始播种 ----------
resetTemplateStore()
let state = listTemplateVersions()
check('播种后共 5 条版本记录（0001/0002/0017 各 1 条，T-03 有 v1/v2 两条）', state.items.length === 5, `got ${state.items.length}`)

const t03v1 = byCodeVersion(state.items, 'TEMP-0003', 1)
const t03v2 = byCodeVersion(state.items, 'TEMP-0003', 2)
check('T-03 废弃 v1 与启用 v2 是两条独立版本记录', !!t03v1 && !!t03v2 && t03v1.id !== t03v2.id)
check('T-03 v1 为已废弃', t03v1.status === '已废弃', t03v1.status)
check('T-03 v2 为已启用（当前有效版本）', t03v2.status === '已启用', t03v2.status)
check('T-03 编号与历史字段未被改写', t03v1.模板编号 === 'TEMP-0003' && t03v1.原始模板版本 === '抽取模板样例3')

const t17 = byCodeVersion(state.items, 'TEMP-0017', 1)
check('T-17 列表选择器为空的草稿已播种', t17 && t17.列表选择器 === '' && t17.status === '草稿')

// ---------- T-17：缺列表选择器，校验必须被拒绝 ----------
const r1 = await runTemplateAction(t17.id, '提交校验')
check('T-17 提交校验被拒绝', r1.ok === false)
check('拒绝信息指明缺失项「列表选择器」', r1.message.includes('列表选择器'), r1.message)
check('拒绝信息只列实际缺失字段，不包含已填写的入口地址/分页规则', !r1.message.includes('入口地址') && !r1.message.includes('分页规则'), r1.message)
state = listTemplateVersions()
check('校验失败不产生新版本（仍只有 v1）', state.items.filter((r) => r.模板编号 === 'TEMP-0017').length === 1)
check('T-17 仍停留在草稿态', byCodeVersion(state.items, 'TEMP-0017', 1).status === '草稿')
check('T-17 记录校验结论为未通过且留痕缺失项', byCodeVersion(state.items, 'TEMP-0017', 1).校验结论 === '未通过')

// ---------- 草稿越级启用必须被拒绝 ----------
const t01 = byCodeVersion(state.items, 'TEMP-0001', 1)
const r2 = await runTemplateAction(t01.id, '启用模板')
check('草稿直接启用被拒绝', r2.ok === false && r2.message.includes('不能执行'))
const r3 = await runTemplateAction(t01.id, '废弃模板')
check('草稿直接废弃（越级）被拒绝', r3.ok === false)
check('越级后状态仍是草稿', byCodeVersion(listTemplateVersions().items, 'TEMP-0001', 1).status === '草稿')

// ---------- 正常单向推进：草稿 -> 待校验 ----------
const r4 = await runTemplateAction(t01.id, '提交校验')
check('TEMP-0001 校验通过进入待校验', r4.ok && r4.message.includes('待校验'))
state = listTemplateVersions()
const t01After = byCodeVersion(state.items, 'TEMP-0001', 1)
check('校验结论落到字段映射契约', t01After.校验结论 === '通过' && JSON.parse(t01After.字段映射契约).length >= 1)

// 待校验再次「提交校验」属于倒序/原地重复，必须拒绝
const r5 = await runTemplateAction(t01After.id, '提交校验')
check('待校验态重复提交校验被拒绝', r5.ok === false && r5.message.includes('不能执行'), r5.message)

// ---------- 并发：同一模板同动作只接受首个请求，重复提交不生成第二版本 ----------
const beforeCount = listTemplateVersions().items.length
const [c1, c2, c3] = await Promise.all([
  runTemplateAction(t01After.id, '启用模板'),
  runTemplateAction(t01After.id, '启用模板'),
  runTemplateAction(t01After.id, '启用模板'),
])
check('并发启用：仅首个请求成功', c1.ok === true && c2.ok === false && c3.ok === false)
check('被拦截请求提示重复提交不生成第二版本', c2.message.includes('重复提交') || c2.message.includes('处理中'), c2.message)
state = listTemplateVersions()
check('并发后版本总数不增加', state.items.length === beforeCount, `before=${beforeCount} after=${state.items.length}`)
check('TEMP-0001 已启用且只有一个版本', byCodeVersion(state.items, 'TEMP-0001', 1).status === '已启用')

// ---------- 启用结果同步到字段映射清单（另一业务面只引用当前有效版本）----------
const syncs = listTemplateSyncs()
check('启用动作产生字段映射同步留痕', syncs.some((s) => s.模板编号 === 'TEMP-0001' && s.动作 === '启用模板' && s.结果 === '成功'))
const enabled = latestEnabledTemplates()
check('当前有效版本清单包含 TEMP-0001 v1', enabled.some((r) => r.模板编号 === 'TEMP-0001' && r.rowVersion === 1))

// ---------- 已废弃不能倒序回启用 ----------
const r6 = await runTemplateAction(t03v1.id, '启用模板')
check('T-03 已废弃 v1 重新启用被拒绝（历史版本只读守卫）', r6.ok === false, r6.message)
const r7 = await runTemplateAction(t03v1.id, '重新校验')
check('T-03 已废弃 v1 重新校验也被拒绝', r7.ok === false)
check('历史版本上没有任何可用动作', mod.availableActions(t03v1).length === 0)

// 把 TEMP-0001 推到废弃后，验证「已废弃且是当前版本」时终态守卫直接拒绝倒序
const t01Enabled = byCodeVersion(listTemplateVersions().items, 'TEMP-0001', 1)
const rDeprecate = await runTemplateAction(t01Enabled.id, '废弃模板')
check('前置：TEMP-0001 进入已废弃终态', rDeprecate.ok === true, rDeprecate.message)
const rReenable = await runTemplateAction(byCodeVersion(listTemplateVersions().items, 'TEMP-0001', 1).id, '启用模板')
check('已废弃当前版本再启用被终态守卫拒绝', rReenable.ok === false && rReenable.message.includes('终态'), rReenable.message)
const rReValidate = await runTemplateAction(byCodeVersion(listTemplateVersions().items, 'TEMP-0001', 1).id, '重新校验')
check('已废弃当前版本重新校验同样被拒绝', rReValidate.ok === false && rReValidate.message.includes('终态'), rReValidate.message)

// ---------- 重新校验生成新版本，不覆盖旧记录（TEMP-0002 此时仍是待校验 v1）----------
const t02 = byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 1)
const r10 = await runTemplateAction(t02.id, '重新校验')
check('待校验态重新校验生成新版本草稿', r10.ok && r10.version === 'v2', r10.message)
state = listTemplateVersions()
const t02v1 = byCodeVersion(state.items, 'TEMP-0002', 1)
const t02v2 = byCodeVersion(state.items, 'TEMP-0002', 2)
check('旧版本 v1 按原口径保留为待校验历史', t02v1.status === '待校验' && t02v1.模板编号 === 'TEMP-0002')
check('新版本 v2 是草稿且校验结论为未校验', t02v2.status === '草稿' && t02v2.校验结论 === '未校验')
check('canonicalRows 只返回每个编号的当前版本', canonicalRows(state.items).filter((r) => r.模板编号 === 'TEMP-0002').length === 1)
check('当前版本指向 v2', canonicalRows(state.items).find((r) => r.模板编号 === 'TEMP-0002').rowVersion === 2)
check('历史版本动作入口为空', mod.availableActions(t02v1).length === 0)

// v2 数据完整，提交校验通过
const t02v2Row = byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 2)
const r11 = await runTemplateAction(t02v2Row.id, '提交校验')
check('v2 数据完整时校验通过', r11.ok === true, r11.message)

// ---------- 已启用 -> 废弃，映射同步停用（走 TEMP-0002 v2 的完整推进链路）----------
const t02Pending = byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 2)
const rEnable02 = await runTemplateAction(t02Pending.id, '启用模板')
check('前置：TEMP-0002 v2 待校验后启用', rEnable02.ok === true, rEnable02.message)
const r8 = await runTemplateAction(byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 2).id, '废弃模板')
check('TEMP-0002 启用后可废弃', r8.ok === true)
check('废弃留痕包含字段映射停用信息', listTemplateSyncs().some((s) => s.模板编号 === 'TEMP-0002' && s.动作 === '废弃模板'))
const r9 = await runTemplateAction(byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 2).id, '启用模板')
check('废弃后再启用（倒序）被拒绝', r9.ok === false && r9.message.includes('终态'), r9.message)
const r9b = await runTemplateAction(byCodeVersion(listTemplateVersions().items, 'TEMP-0002', 2).id, '重新校验')
check('废弃当前版本重新校验被终态守卫拒绝', r9b.ok === false && r9b.message.includes('终态'), r9b.message)

// ---------- 快速连续点击：不同动作的连点也受状态机拦截 ----------
const t17Row = byCodeVersion(listTemplateVersions().items, 'TEMP-0017', 1)
const seq = await Promise.all([
  runTemplateAction(t17Row.id, '启用模板'),
  runTemplateAction(t17Row.id, '废弃模板'),
])
check('草稿态连点启用/废弃全部被状态机拒绝', seq.every((r) => r.ok === false))
check('T-17 仍为草稿，无脏版本', byCodeVersion(listTemplateVersions().items, 'TEMP-0017', 1).status === '草稿')

// ---------- 统计口径 ----------
const stats = getTemplateStats()
check('统计包含模板数与版本总数', stats.templateCount >= 4 && stats.versionCount === state.items.length)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
