// lib/logger.js
// 审查审计日志：记录每次隐私审查的决策、风险、耗时、Token 等，供评估对比使用。
// 默认内存环形缓冲；可选 JSONL 落盘（复用隐私防护插件同类实现思路，零依赖）。

import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

export const SEVERITY_INFO = 1
export const SEVERITY_WARN = 2
export const SEVERITY_CRITICAL = 3

function pad2(n) {
  return String(n).padStart(2, '0')
}

function nowIso() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}Z`
}

const PSEUDO_FS = /^\/(proc|sys|dev|run|tmpfs)(\/|$)/

/**
 * 创建审查日志器。
 * @param {object} [opts] { logDir?: string, silent?: boolean }
 */
export function createReviewLogger(opts = {}) {
  const { logDir = '', silent = true } = opts
  const memory = []

  let logFile = null
  if (logDir && !PSEUDO_FS.test(logDir)) {
    try {
      if (!existsSync(logDir)) mkdirSync(logDir)
      const file = `${logDir}/privacychecker-audit.jsonl`
      writeFileSync(file, '', { flag: 'a' })
      logFile = file
    } catch (err) {
      if (!silent) console.warn(`[privacychecker] 审计目录不可用，改内存模式: ${err.message}`)
      logFile = null
    }
  }

  const record = (entry) => {
    const evt = { ts: nowIso(), ...entry }
    memory.push(evt)
    if (memory.length > 2000) memory.shift()
    if (logFile) {
      try {
        appendFileSync(logFile, JSON.stringify(evt) + '\n')
      } catch (err) {
        if (!silent) console.warn(`[privacychecker] 审计写入失败: ${err.message}`)
      }
    }
    return evt
  }

  return {
    record,
    getRecent: (limit = 200) => memory.slice(-limit),
    /** 统计信息：供评估对比（决策分布、平均延迟） */
    stats: () => {
      const byDecision = {}
      let totalLatency = 0
      let degraded = 0
      for (const e of memory) {
        byDecision[e.decision] = (byDecision[e.decision] || 0) + 1
        totalLatency += e.latencyMs || 0
        if (e.degraded) degraded++
      }
      return {
        total: memory.length,
        byDecision,
        avgLatencyMs: memory.length ? Math.round(totalLatency / memory.length) : 0,
        degraded,
      }
    },
    close: () => { logFile = null },
  }
}

/** 读取 JSONL 审计文件 */
export function readReviewLog(filePath) {
  if (!filePath || !existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}
