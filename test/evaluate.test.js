// test/evaluate.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPrivacyReview, buildReviewMessages } from '../lib/checker/evaluate.js'
import { resolveConfig } from '../lib/config.js'

const cfg = resolveConfig()

const ALLOW_JSON = JSON.stringify({ risk: 'LOW', decision: 'ALLOW', reason: '必要且适当', blocked_data: [] })
const MODIFY_JSON = JSON.stringify({
  risk: 'HIGH', decision: 'MODIFY', reason: '只需大致位置',
  allowed_data: { location: '涩谷区' }, blocked_data: ['age', 'phone'],
})
const BLOCK_JSON = JSON.stringify({ risk: 'HIGH', decision: 'BLOCK', reason: '超出授权边界', blocked_data: ['medical'] })

test('buildReviewMessages 产出 system+user 两条', () => {
  const msgs = buildReviewMessages({ task: 't', action: 'a', dataToBeSent: {} })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  assert.equal(msgs[1].role, 'user')
})

test('审查返回 ALLOW', async () => {
  const r = await runPrivacyReview({
    input: { task: '整理会议纪要', action: 'search_notes', dataToBeSent: { query: 'meeting' } },
    config: cfg,
    invokeModel: async () => ALLOW_JSON,
  })
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'ALLOW')
  assert.ok(r.latencyMs >= 0)
})

test('审查返回 MODIFY 并带字段清单', async () => {
  const r = await runPrivacyReview({
    input: { task: '预订餐厅', action: 'search_restaurant', dataToBeSent: { phone: '138x', age: 31 } },
    config: cfg,
    invokeModel: async () => MODIFY_JSON,
  })
  assert.equal(r.decision, 'MODIFY')
  assert.deepEqual(r.blockedData, ['age', 'phone'])
})

test('审查返回 BLOCK', async () => {
  const r = await runPrivacyReview({
    input: { task: 't', action: 'send_email', dataToBeSent: {} },
    config: cfg,
    invokeModel: async () => BLOCK_JSON,
  })
  assert.equal(r.decision, 'BLOCK')
})

test('模型调用失败时按 fail-open 降级', async () => {
  const r = await runPrivacyReview({
    input: { task: 't', action: 'a', dataToBeSent: {} },
    config: cfg,
    invokeModel: async () => { throw new Error('网络错误') },
  })
  assert.equal(r.ok, false)
  assert.equal(r.decision, 'ALLOW') // fail-open
  assert.equal(r.degraded, true)
})

test('模型调用失败 + fail-closed 配置则阻断', async () => {
  const c = resolveConfig({ onReviewFailure: 'fail-closed' })
  const r = await runPrivacyReview({
    input: { task: 't', action: 'a', dataToBeSent: {} },
    config: c,
    invokeModel: async () => { throw new Error('网络错误') },
  })
  assert.equal(r.decision, 'BLOCK')
  assert.equal(r.degraded, true)
})

test('无法解析输出时降级', async () => {
  const r = await runPrivacyReview({
    input: { task: 't', action: 'a', dataToBeSent: {} },
    config: cfg,
    invokeModel: async () => '抱歉，我无法完成',
  })
  assert.equal(r.ok, false)
  assert.equal(r.degraded, true)
})

test('超时处理', async () => {
  const c = resolveConfig({ reviewTimeoutMs: 50 })
  const r = await runPrivacyReview({
    input: { task: 't', action: 'a', dataToBeSent: {} },
    config: c,
    invokeModel: async () => new Promise((res) => setTimeout(() => res(ALLOW_JSON), 500)),
  })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /超时/)
})

test('超大参数被裁剪而不崩溃', async () => {
  const c = resolveConfig({ maxReviewChars: 200 })
  let seen = ''
  const r = await runPrivacyReview({
    input: { task: 't', action: 'a', dataToBeSent: { big: 'x'.repeat(5000) } },
    config: c,
    invokeModel: async (messages) => { seen = messages[1].content; return ALLOW_JSON },
  })
  assert.equal(r.decision, 'ALLOW')
  assert.ok(seen.length < 3000, `审查输入应被裁剪，实际 ${seen.length}`)
})
