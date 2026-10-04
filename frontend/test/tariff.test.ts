/**
 * 资费核验逻辑的临时测试：验证贴票合计、当期资费选定、核验结论、冲突检测与导入解析。
 * 运行：node_modules/.bin/esbuild test/tariff.test.ts --bundle --platform=node --format=esm | node
 */
import assert from 'node:assert'
import type { Cover } from '../src/types/cover'
import type { TariffRule } from '../src/types/tariff'
import {
  stampTotalOf,
  selectTariff,
  verifyCover,
  rulesConflict,
  detectConflicts,
  resolveImport,
  parseImportFile,
  nextBatchNo,
  assignRuleNos
} from '../src/utils/tariff'

let passed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(e as Error).message}`)
    process.exitCode = 1
  }
}

function makeCover(over: Partial<Cover>): Cover {
  return {
    coverNo: 'CV-X',
    sentFrom: '上海',
    sentTo: '南京',
    postDate: '1910-06-18',
    arriveDate: '',
    franking: [],
    cancelPmIds: [],
    routeId: null,
    viaPoints: [],
    registered: false,
    conditionGrade: '中品',
    acquireFrom: '',
    price: 0,
    storageAlbum: '',
    frontImage: '',
    backImage: '',
    note: '',
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

function makeRule(over: Partial<TariffRule>): TariffRule {
  return {
    ruleNo: 'ZF-0001',
    effectiveFrom: '1910-01-01',
    effectiveTo: '1920-12-31',
    regions: ['江苏', '南京'],
    registeredScope: null,
    fee: 3,
    batchNo: '',
    note: '',
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

console.log('贴票合计')
test('Σ 面值×枚数', () => {
  const c = makeCover({ franking: [
    { stampName: 'A', denomination: 3, count: 2 },
    { stampName: 'B', denomination: 1, count: 1 }
  ] })
  assert.strictEqual(stampTotalOf(c), 7)
})
test('空贴票为 0', () => {
  assert.strictEqual(stampTotalOf(makeCover({ franking: [] })), 0)
})

console.log('当期资费选定')
test('按寄出日期命中生效区间', () => {
  const rules = [
    makeRule({ ruleNo: 'A', effectiveFrom: '1900-01-01', effectiveTo: '1909-12-31', fee: 2 }),
    makeRule({ ruleNo: 'B', effectiveFrom: '1910-01-01', effectiveTo: '1920-12-31', fee: 3 })
  ]
  const c = makeCover({ postDate: '1910-06-18' })
  const { rule } = selectTariff(c, rules)
  assert.strictEqual(rule?.ruleNo, 'B')
})
test('按收件地命中地区', () => {
  const rules = [
    makeRule({ ruleNo: 'A', regions: ['广东'], fee: 2 }),
    makeRule({ ruleNo: 'B', regions: ['南京'], fee: 3 })
  ]
  const c = makeCover({ sentTo: '南京' })
  const { rule } = selectTariff(c, rules)
  assert.strictEqual(rule?.ruleNo, 'B')
})
test('收件地包含地区名时命中', () => {
  const rules = [makeRule({ ruleNo: 'A', regions: ['南京'], fee: 3 })]
  const c = makeCover({ sentTo: '南京府' })
  const { rule } = selectTariff(c, rules)
  assert.strictEqual(rule?.ruleNo, 'A')
})
test('按给据状态命中', () => {
  const rules = [
    makeRule({ ruleNo: 'A', registeredScope: false, fee: 2 }),
    makeRule({ ruleNo: 'B', registeredScope: true, fee: 5 })
  ]
  const c = makeCover({ registered: true })
  const { rule } = selectTariff(c, rules)
  assert.strictEqual(rule?.ruleNo, 'B')
})
test('无命中返回 null', () => {
  const rules = [makeRule({ regions: ['广东'] })]
  const c = makeCover({ sentTo: '南京' })
  const { rule } = selectTariff(c, rules)
  assert.strictEqual(rule, null)
})

console.log('核验结论')
test('资费相符', () => {
  const rules = [makeRule({ fee: 3 })]
  const c = makeCover({ franking: [{ stampName: 'A', denomination: 3, count: 1 }] })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'matched')
  assert.strictEqual(v.stampTotal, 3)
})
test('欠资', () => {
  const rules = [makeRule({ fee: 5 })]
  const c = makeCover({ franking: [{ stampName: 'A', denomination: 3, count: 1 }] })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'underpaid')
  assert.strictEqual(v.shortfall, 2)
})
test('溢贴', () => {
  const rules = [makeRule({ fee: 2 })]
  const c = makeCover({ franking: [{ stampName: 'A', denomination: 3, count: 1 }] })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'overpaid')
})
test('无资费', () => {
  const rules = [makeRule({ regions: ['广东'] })]
  const c = makeCover({ sentTo: '南京' })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'notariff')
})
test('日期缺失待复核', () => {
  const rules = [makeRule({})]
  const c = makeCover({ postDate: '' })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'pending')
})
test('收件地缺失待复核', () => {
  const rules = [makeRule({})]
  const c = makeCover({ sentTo: '' })
  const v = verifyCover(c, rules)
  assert.strictEqual(v.status, 'pending')
})

console.log('冲突检测')
test('两条规则三维度重叠即冲突', () => {
  const a = makeRule({ id: 1, ruleNo: 'A', effectiveFrom: '1910-01-01', effectiveTo: '1920-12-31', regions: ['江苏'], registeredScope: null })
  const b = makeRule({ id: 2, ruleNo: 'B', effectiveFrom: '1915-01-01', effectiveTo: '1925-12-31', regions: ['江苏'], registeredScope: null })
  assert.strictEqual(rulesConflict(a, b), true)
})
test('地区不重叠不冲突', () => {
  const a = makeRule({ id: 1, regions: ['江苏'] })
  const b = makeRule({ id: 2, regions: ['广东'] })
  assert.strictEqual(rulesConflict(a, b), false)
})
test('给据状态不重叠不冲突', () => {
  const a = makeRule({ id: 1, registeredScope: true })
  const b = makeRule({ id: 2, registeredScope: false })
  assert.strictEqual(rulesConflict(a, b), false)
})
test('同一规则不冲突', () => {
  const a = makeRule({ id: 1 })
  const b = makeRule({ id: 1 })
  assert.strictEqual(rulesConflict(a, b), false)
})
test('detectConflicts 识别新规则与库内规则冲突', () => {
  const existing = [makeRule({ id: 1, ruleNo: 'A', fee: 3 })]
  const incoming = [makeRule({ ruleNo: 'B', fee: 4 })]
  const covers = [makeCover({ id: 100 })]
  const groups = detectConflicts(incoming, existing, covers)
  assert.strictEqual(groups.length, 1)
  assert.strictEqual(groups[0].kind, 'existing')
  assert.deepStrictEqual(groups[0].coverIds, [100])
})
test('resolveImport 选择保留现有则丢弃新规则', () => {
  const existing = [makeRule({ id: 1, ruleNo: 'A' })]
  const incoming = [makeRule({ ruleNo: 'B' })]
  const groups = detectConflicts(incoming, existing, [])
  const pending = {
    batchNo: 'ZF-1',
    fileName: 'f.json',
    source: '',
    newRules: incoming,
    conflicts: groups,
    choices: { [groups[0].key]: 'existing' as const }
  }
  const { toAdd, toDeleteExisting } = resolveImport(pending)
  assert.strictEqual(toAdd.length, 0)
  assert.strictEqual(toDeleteExisting.length, 0)
})
test('resolveImport 选择采用新规则则删除库内旧规则', () => {
  const existing = [makeRule({ id: 1, ruleNo: 'A' })]
  const incoming = [makeRule({ ruleNo: 'B' })]
  const groups = detectConflicts(incoming, existing, [])
  const pending = {
    batchNo: 'ZF-1',
    fileName: 'f.json',
    source: '',
    newRules: incoming,
    conflicts: groups,
    choices: { [groups[0].key]: 'incoming' as const }
  }
  const { toAdd, toDeleteExisting } = resolveImport(pending)
  assert.strictEqual(toAdd.length, 1)
  assert.strictEqual(toDeleteExisting.length, 1)
})

console.log('导入解析')
test('解析 JSON 数组', () => {
  const text = JSON.stringify([
    { effectiveFrom: '1910-01-01', regions: ['江苏'], fee: 3 }
  ])
  const { rules, error } = parseImportFile(text, 'list.json')
  assert.strictEqual(error, '')
  assert.strictEqual(rules.length, 1)
  assert.strictEqual(rules[0].fee, 3)
})
test('解析 JSON 对象（含 rules）', () => {
  const text = JSON.stringify({ source: '研究会', rules: [
    { effectiveFrom: '1910-01-01', regions: ['江苏'], fee: 3 }
  ]})
  const { rules, source, error } = parseImportFile(text, 'list.json')
  assert.strictEqual(error, '')
  assert.strictEqual(source, '研究会')
  assert.strictEqual(rules.length, 1)
})
test('解析 CSV', () => {
  const text = 'effectiveFrom,regions,fee\n1910-01-01,江苏;南京,3\n'
  const { rules, error } = parseImportFile(text, 'list.csv')
  assert.strictEqual(error, '')
  assert.strictEqual(rules.length, 1)
  assert.deepStrictEqual(rules[0].regions, ['江苏', '南京'])
})
test('无效生效日期报错', () => {
  const text = JSON.stringify([{ effectiveFrom: 'bad', regions: ['江苏'], fee: 3 }])
  const { rules, error } = parseImportFile(text, 'list.json')
  assert.strictEqual(rules.length, 0)
  assert.ok(error.includes('生效日期无效'))
})
test('缺少地区报错', () => {
  const text = JSON.stringify([{ effectiveFrom: '1910-01-01', regions: [], fee: 3 }])
  const { error } = parseImportFile(text, 'list.json')
  assert.ok(error.includes('缺少适用地区'))
})
test('空文件报错', () => {
  const { error } = parseImportFile('   ', 'list.json')
  assert.ok(error.includes('文件为空'))
})

console.log('批次号与编号')
test('nextBatchNo 同日递增', () => {
  const batches = [
    { batchNo: 'ZF-20261004-001' },
    { batchNo: 'ZF-20261004-002' }
  ] as any
  assert.strictEqual(nextBatchNo(batches), 'ZF-20261004-003')
})
test('assignRuleNos 补齐缺失编号', () => {
  const rules = [
    makeRule({ ruleNo: '' }),
    makeRule({ ruleNo: 'ZF-0005' })
  ]
  const out = assignRuleNos(rules, ['ZF-0001'])
  assert.ok(out[0].ruleNo.startsWith('ZF-'))
  assert.strictEqual(out[1].ruleNo, 'ZF-0005')
})

console.log('对账期间待复核')
test('库内规则 + 待确认规则共同命中 → 待复核', () => {
  const existing = makeRule({ id: 1, ruleNo: 'A', fee: 3 })
  const incoming = makeRule({ ruleNo: 'B', fee: 4 })
  const c = makeCover({ franking: [{ stampName: 'X', denomination: 3, count: 1 }] })
  // 仅库内规则：资费相符
  assert.strictEqual(verifyCover(c, [existing]).status, 'matched')
  // 叠加待确认规则：两条候选 → 待复核
  const v = verifyCover(c, [existing, incoming])
  assert.strictEqual(v.status, 'pending')
  assert.strictEqual(v.conflicts.length, 2)
})
test('待确认规则无冲突 → 按新规则核验', () => {
  const existing = makeRule({ id: 1, ruleNo: 'A', regions: ['广东'], fee: 3 })
  const incoming = makeRule({ ruleNo: 'B', regions: ['南京'], fee: 4 })
  const c = makeCover({ sentTo: '南京', franking: [{ stampName: 'X', denomination: 3, count: 1 }] })
  // 库内无命中 → 无资费
  assert.strictEqual(verifyCover(c, [existing]).status, 'notariff')
  // 叠加待确认规则：按新规则，欠资 1 元
  const v = verifyCover(c, [existing, incoming])
  assert.strictEqual(v.status, 'underpaid')
  assert.strictEqual(v.shortfall, 1)
})

console.log(`\n${passed} 项测试通过`)
if (process.exitCode) process.exit(process.exitCode)
