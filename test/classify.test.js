// test/classify.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyOperation, extractDisclosureData, resolveConfig } from '../lib/config.js'

const cfg = resolveConfig()

test('识别信息发送前（outbound-send）', () => {
  const r = classifyOperation('send_email', { to: 'a@b.com', body: 'hi' }, cfg)
  assert.equal(r.matched, true)
  assert.equal(r.interceptPoint, 'outbound-send')
})

test('识别外部工具调用前（external-tool-call）', () => {
  const r = classifyOperation('web_search', { query: 'restaurants' }, cfg)
  assert.equal(r.matched, true)
  assert.equal(r.interceptPoint, 'external-tool-call')
})

test('发送优先于外部调用（安全边界更明确）', () => {
  const r = classifyOperation('send_webhook', { url: 'https://x.com', data: {} }, cfg)
  assert.equal(r.interceptPoint, 'outbound-send')
})

test('本地读文件不触发拦截', () => {
  const r = classifyOperation('read_file', { path: './notes.md' }, cfg)
  assert.equal(r.matched, false)
})

test('HTTP URL 参数触发外部调用', () => {
  const r = classifyOperation('fetch_data', { url: 'https://api.example.com/v1' }, cfg)
  assert.equal(r.matched, true)
})

test('可关闭某个拦截点', () => {
  const c = resolveConfig({ outboundSend: { enabled: false } })
  const r = classifyOperation('send_email', { to: 'a@b.com' }, c)
  assert.notEqual(r.interceptPoint, 'outbound-send')
})

test('提取披露数据：命中敏感字段名', () => {
  const data = extractDisclosureData({ to: 'a@b.com', body: 'hello', big_blob: 'x'.repeat(100) })
  assert.equal(data.to, 'a@b.com')
  assert.equal(data.body, 'hello')
  assert.equal(data.big_blob, undefined)
})

test('提取披露数据：字段名未知时保留全部（不漏审）', () => {
  const args = { foo: 1, bar: 2 }
  const data = extractDisclosureData(args)
  assert.deepEqual(data, args)
})
