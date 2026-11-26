// test/hooks.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlePreExecute } from '../lib/hooks/pre-tool-call.js'
import { handlePostExecute, extractContentText } from '../lib/hooks/post-read.js'
import { createReviewLogger } from '../lib/logger.js'
import { resolveConfig } from '../lib/config.js'

const cfg = resolveConfig()
const MODIFY_JSON = JSON.stringify({
  risk: 'HIGH', decision: 'MODIFY', reason: '只需大致位置',
  allowed_data: { location: '涩谷区' }, blocked_data: ['phone'],
})
const BLOCK_JSON = JSON.stringify({ risk: 'HIGH', decision: 'BLOCK', reason: '越界', blocked_data: [] })
const ALLOW_JSON = JSON.stringify({ risk: 'LOW', decision: 'ALLOW', reason: 'ok', blocked_data: [] })

function makeCtx(reviewJson) {
  return {
    llm: {
      chat: async () => reviewJson,
    },
  }
}

test('pre-execute：非受控工具直接放行', async () => {
  const logger = createReviewLogger({})
  let nextCalled = false
  const d = await handlePreExecute({
    exec: { name: 'read_file', arguments: { path: './a.md' } },
    next: async () => { nextCalled = true; return { kind: 'allow' } },
    ctx: makeCtx(ALLOW_JSON), config: cfg, logger,
  })
  assert.equal(nextCalled, true)
  assert.equal(d.kind, 'allow')
})

test('pre-execute：外发 + BLOCK → deny 且不调用 next', async () => {
  const logger = createReviewLogger({})
  let nextCalled = false
  const d = await handlePreExecute({
    exec: { name: 'send_email', arguments: { to: 'x@y.com', body: 'hi' } },
    next: async () => { nextCalled = true; return { kind: 'allow' } },
    ctx: makeCtx(BLOCK_JSON), config: cfg, logger,
  })
  assert.equal(nextCalled, false)
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /已阻断/)
})

test('pre-execute：外发 + MODIFY → deny 并给建议', async () => {
  const logger = createReviewLogger({})
  const d = await handlePreExecute({
    exec: { name: 'send_message', arguments: { text: 'x', phone: '138' } },
    next: async () => ({ kind: 'allow' }),
    ctx: makeCtx(MODIFY_JSON), config: cfg, logger,
  })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /脱敏/)
})

test('pre-execute：读类 + MODIFY → 放行并登记待脱敏', async () => {
  const logger = createReviewLogger({})
  const pending = new Map()
  let nextCalled = false
  const d = await handlePreExecute({
    exec: { name: 'gmail_search_messages', callId: 'c1', arguments: { query: 'invoice' } },
    next: async () => { nextCalled = true; return { kind: 'allow' } },
    ctx: makeCtx(MODIFY_JSON), config: cfg, logger, pendingReviews: pending,
  })
  assert.equal(nextCalled, true)
  assert.equal(d.kind, 'allow')
  assert.ok(pending.get('c1'), '应登记待脱敏记录')
})

test('pre-execute：审计记录被写入', async () => {
  const logger = createReviewLogger({})
  await handlePreExecute({
    exec: { name: 'web_search', arguments: { query: 'x' } },
    next: async () => ({ kind: 'allow' }),
    ctx: makeCtx(ALLOW_JSON), config: cfg, logger,
  })
  const recent = logger.getRecent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0].interceptPoint, 'external-tool-call')
  assert.equal(recent[0].decision, 'ALLOW')
})

test('post-execute：无待脱敏记录时透传', async () => {
  const logger = createReviewLogger({})
  let nextCalled = false
  const d = await handlePostExecute({
    exec: { name: 'gmail_search_messages', callId: 'c9' },
    result: { content: [{ type: 'text', text: '{"phone":"138"}' }] },
    next: async () => { nextCalled = true; return { kind: 'accept' } },
    config: cfg, pendingReviews: new Map(), logger,
  })
  assert.equal(nextCalled, true)
})

test('post-execute：命中待脱敏记录则替换内容', async () => {
  const logger = createReviewLogger({})
  const pending = new Map([['c1', { decision: 'MODIFY', blockedData: ['phone'] }]])
  const d = await handlePostExecute({
    exec: { name: 'gmail_search_messages', callId: 'c1' },
    result: { content: [{ type: 'text', text: '{"phone":"13812345678","city":"东京"}' }] },
    next: async () => ({ kind: 'accept' }),
    config: cfg, pendingReviews: pending, logger,
  })
  assert.equal(d.kind, 'accept')
  const text = d.content.map((b) => b.text).join('')
  assert.ok(!text.includes('13812345678'))
  assert.match(text, /REDACTED-BY-PRIVACYCHECKER/)
})

test('extractContentText 兼容多种结果形态', () => {
  assert.equal(extractContentText('plain'), 'plain')
  assert.equal(extractContentText({ content: 's' }), 's')
  assert.equal(extractContentText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.equal(extractContentText(null), '')
})
