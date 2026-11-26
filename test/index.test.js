// test/index.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { name, inject, apply, getRecentReviews, getReviewStats, reviewOperation } from '../lib/index.js'

test('插件元数据', () => {
  assert.equal(name, 'privacychecker')
  assert.deepEqual(inject, ['tools'])
})

test('apply 注册两个管线事件监听', () => {
  const events = []
  const ctx = { on: (evt, fn) => events.push(evt) }
  apply(ctx)
  assert.ok(events.includes('tools/pre-execute'))
  assert.ok(events.includes('tools/post-execute'))
})

test('apply 在缺失 on 的 ctx 上也能加载（防御式）', () => {
  assert.doesNotThrow(() => apply({}))
})

test('apply 返回值提供 dispose', () => {
  const handle = apply({ on() {} })
  assert.equal(typeof handle.dispose, 'function')
  handle.dispose()
})

test('getRecentReviews / getReviewStats 可用', () => {
  apply({ on() {} })
  assert.ok(Array.isArray(getRecentReviews()))
  const s = getReviewStats()
  assert.ok(typeof s.total === 'number')
  assert.ok(typeof s.byDecision === 'object')
})

test('reviewOperation 可直接调用（注入模型）', async () => {
  apply({ on() {} })
  const r = await reviewOperation(
    { task: 't', action: 'send_email', dataToBeSent: { to: 'a@b.com' } },
    { invokeModel: async () => '{"risk":"LOW","decision":"ALLOW","reason":"ok","blocked_data":[]}' },
  )
  assert.equal(r.decision, 'ALLOW')
})

test('end-to-end：pre-execute 钩子经完整管线返回 deny', async () => {
  const handlers = {}
  const ctx = {
    on: (evt, fn) => { handlers[evt] = fn },
    llm: { chat: async () => '{"risk":"HIGH","decision":"BLOCK","reason":"越界","blocked_data":[]}' },
  }
  apply(ctx)
  const decision = await handlers['tools/pre-execute'](
    { name: 'send_email', arguments: { to: 'a@b.com', body: 'x' } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
})
