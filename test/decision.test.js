// test/decision.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isReadLikeOperation,
  toPreToolDecision,
  buildRedactionAdvice,
  redactByReview,
} from '../lib/checker/decision.js'
import { resolveConfig } from '../lib/config.js'

const cfg = resolveConfig()

test('识别读类操作', () => {
  assert.equal(isReadLikeOperation('read_file'), true)
  assert.equal(isReadLikeOperation('gmail_search_messages'), true)
  assert.equal(isReadLikeOperation('send_email'), false)
  assert.equal(isReadLikeOperation('write_file'), false)
})

test('ALLOW → 放行', () => {
  const d = toPreToolDecision({ decision: 'ALLOW', risk: 'LOW', reason: 'ok' }, { action: 'send_email', config: cfg })
  assert.equal(d.kind, 'allow')
})

test('MODIFY + 写/外发 → deny 并给脱敏建议', () => {
  const review = {
    decision: 'MODIFY', risk: 'HIGH', reason: '餐厅搜索只需大致位置',
    allowedData: { location: '涩谷区' }, blockedData: ['age', 'phone'],
  }
  const d = toPreToolDecision(review, { action: 'send_restaurant_booking', config: cfg })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /脱敏/)
  assert.match(d.reason, /age/)
  assert.match(d.reason, /涩谷区/)
})

test('MODIFY + 读类 → 放行（交 post-execute 脱敏）', () => {
  const review = { decision: 'MODIFY', risk: 'MEDIUM', reason: 'x', allowedData: {}, blockedData: ['phone'] }
  const d = toPreToolDecision(review, { action: 'gmail_search_messages', config: cfg })
  assert.equal(d.kind, 'allow')
})

test('BLOCK → deny', () => {
  const d = toPreToolDecision({ decision: 'BLOCK', risk: 'HIGH', reason: '超出授权边界' }, { action: 'send_email', config: cfg })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /已阻断/)
})

test('BLOCK + 配置转人工 → ask', () => {
  const c = resolveConfig({ blockRequiresApproval: true })
  const d = toPreToolDecision({ decision: 'BLOCK', risk: 'HIGH', reason: '风险高' }, { action: 'send_email', config: c })
  assert.equal(d.kind, 'ask')
  assert.ok(d.displayReason.zh.includes('隐私风险'))
})

test('observe 模式不拦截', () => {
  const c = resolveConfig({ mode: 'observe' })
  const d = toPreToolDecision({ decision: 'BLOCK', risk: 'HIGH', reason: 'x' }, { action: 'send_email', config: c })
  assert.equal(d.kind, 'allow')
})

test('脱敏建议文案包含保留与移除两侧', () => {
  const advice = buildRedactionAdvice({
    allowedData: { location: '涩谷区' }, blockedData: ['age', 'phone'], reason: 'r',
  })
  assert.match(advice, /必须移除/)
  assert.match(advice, /可以保留/)
})

test('redactByReview 替换 JSON 字段值', () => {
  const text = '{"name":"张三","phone":"13812345678","city":"东京"}'
  const { text: out, replaced } = redactByReview({ blockedData: ['phone'] }, text)
  assert.ok(replaced >= 1)
  assert.ok(!out.includes('13812345678'))
  assert.match(out, /REDACTED-BY-PRIVACYCHECKER/)
})

test('redactByReview 替换 key=value 形态', () => {
  const text = 'phone=13812345678 city=东京'
  const { text: out, replaced } = redactByReview({ blockedData: ['phone'] }, text)
  assert.ok(replaced >= 1)
  assert.ok(!out.includes('13812345678'))
})
