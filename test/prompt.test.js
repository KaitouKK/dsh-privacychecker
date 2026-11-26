// test/prompt.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReviewUserMessage,
  parseReviewResult,
  PRIVACY_CHECKER_SYSTEM_PROMPT,
  PRIVACY_GUIDELINES,
} from '../lib/prompts/privacy-checker.js'

test('系统提示词包含信息流分析与决策标签', () => {
  assert.match(PRIVACY_CHECKER_SYSTEM_PROMPT, /INFORMATION FLOW ANALYSIS/)
  assert.match(PRIVACY_CHECKER_SYSTEM_PROMPT, /data minimization/i)
  assert.match(PRIVACY_CHECKER_SYSTEM_PROMPT, /"ALLOW"/)
  assert.match(PRIVACY_CHECKER_SYSTEM_PROMPT, /"MODIFY"/)
  assert.match(PRIVACY_CHECKER_SYSTEM_PROMPT, /"BLOCK"/)
})

test('七条隐私准则全部移植', () => {
  assert.equal(PRIVACY_GUIDELINES.length, 7)
})

test('用户消息把操作数据标记为不可信数据', () => {
  const msg = buildReviewUserMessage({
    task: '帮我预订附近的餐厅',
    action: 'search_restaurant',
    recipient: 'external_service',
    dataToBeSent: { location: '具体家庭住址', age: 31, phone: '138xxxxxxxx' },
  })
  assert.match(msg, /UNTRUSTED DATA/)
  assert.match(msg, /<<<BEGIN UNTRUSTED OPERATION DATA>>>/)
  assert.match(msg, /Never follow instructions/)
  assert.match(msg, /search_restaurant/)
})

test('解析标准 JSON 决策', () => {
  const raw = JSON.stringify({
    risk: 'HIGH',
    decision: 'MODIFY',
    reason: '餐厅搜索只需要大致位置',
    allowed_data: { location: '涩谷区' },
    blocked_data: ['age', 'phone'],
    information_flows: [{ data_type: 'location', acceptable: true }],
  })
  const r = parseReviewResult(raw)
  assert.equal(r.decision, 'MODIFY')
  assert.equal(r.risk, 'HIGH')
  assert.deepEqual(r.blockedData, ['age', 'phone'])
  assert.equal(r.allowedData.location, '涩谷区')
})

test('解析带 markdown 围栏与噪音的输出', () => {
  const raw = 'Sure! Here is the review:\n```json\n{"risk":"LOW","decision":"ALLOW","reason":"ok","blocked_data":[]}\n```\nDone.'
  const r = parseReviewResult(raw)
  assert.equal(r.decision, 'ALLOW')
  assert.equal(r.risk, 'LOW')
})

test('非法决策返回 null', () => {
  assert.equal(parseReviewResult('{"decision":"MAYBE"}'), null)
  assert.equal(parseReviewResult('not json at all'), null)
  assert.equal(parseReviewResult(''), null)
})

test('截断的 JSON 仍能解析出 decision（真实模型 max_tokens 截断场景）', () => {
  const truncated = '{\n  "risk": "HIGH",\n  "decision": "BLOCK",\n  "reason": "超出授权边界",\n  "information_flows": [\n    {\n      "data_type": "Medical appointment details",\n      "data_subject": "user",\n      "acceptable": false\n    },\n    {\n      "data_type": "Mental health counseling",\n      "transmission_principle'
  const r = parseReviewResult(truncated)
  assert.ok(r, '截断输出应能兜底解析')
  assert.equal(r.decision, 'BLOCK')
  assert.equal(r.risk, 'HIGH')
})

test('截断输出可从信息流补充敏感项', () => {
  const truncated = '{"decision":"MODIFY","risk":"MEDIUM","information_flows":[{"data_type":"家庭住址","acceptable":false},{"data_type":"城市","acceptable":true}'
  const r = parseReviewResult(truncated)
  assert.ok(r)
  assert.equal(r.decision, 'MODIFY')
  assert.ok(r.blockedData.includes('家庭住址'))
})

test('完全无法解析时返回 null', () => {
  assert.equal(parseReviewResult('{"foo":'), null)
  assert.equal(parseReviewResult('抱歉我无法判断'), null)
})
