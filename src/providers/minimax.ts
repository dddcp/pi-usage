/**
 * MiniMax Token/Coding Plan 用量适配 — 国内 (api.minimaxi.com) 与国际 (api.minimax.io)。
 *
 *   GET {base}/v1/token_plan/remains
 *   Authorization: Bearer <apiKey>
 *
 *   {
 *     "model_remains": [
 *       { "model_name": "MiniMax-M2",
 *         "start_time": 1771000000000, "end_time": 1771018000000,
 *         "remains_time": 10800000,
 *         "current_interval_total_count": 4500,
 *         "current_interval_usage_count": 4309,
 *         "current_interval_remaining_percent": 95.8,
 *         "current_interval_status": 1,
 *         "weekly_start_time": ..., "weekly_end_time": ..., "weekly_remains_time": ...,
 *         "current_weekly_total_count": 157500,
 *         "current_weekly_usage_count": 155409,
 *         "current_weekly_remaining_percent": 98.67,
 *         "weekly_boost_permille": 1000,
 *         "current_weekly_status": 1 }
 *     ]
 *   }
 *
 * 命名陷阱：`current_interval_usage_count` / `current_weekly_usage_count`
 * 存的是**剩余**次数（已用 = total − 该值）；`*_remaining_percent` 是 0–100
 * 的剩余百分比。2026-10-23 对照官方文档（platform.minimax.io m-plan FAQ）、
 * oc-minimax-status 与 MiniMaxUsage (macOS) 交叉验证。业务错误以
 * `{ "base_resp": { "status_code": !=0, "status_msg": "..." } }` 返回（可能
 * 伴随 HTTP 200）。窗口 `status == 3` 表示不限量（显示 ∞）。计数单位是
 * 请求次数，窗口从首次使用开始、独立重置。
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toFiniteNumber(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v))
		return v
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v)
		if (Number.isFinite(n))
			return n
	}
	return undefined
}

function clamp100(n: number): number {
	return Math.max(0, Math.min(100, n))
}

/** 从模型 baseURL 路由额度接口 host（minimax.io → 国际，其余 → 国内）。 */
export function minimaxQuotaBase(baseURL: string): string {
	let host = ''
	try {
		host = new URL(baseURL).hostname.toLowerCase()
	}
	catch {
		host = baseURL.toLowerCase()
	}
	if (host === 'minimax.io' || host.endsWith('.minimax.io'))
		return 'https://api.minimax.io'
	// minimaxi.com、旧 minimaxi.chat 与 www host 共用国内后端
	return 'https://api.minimaxi.com'
}

type WindowPrefix = 'current_interval' | 'current_weekly'

/**
 * 一个额度窗口 → 行。`*_usage_count` 是剩余次数，
 * `*_remaining_percent`（0–100）是剩余比例；`*_status == 3` 表示不限量。
 * 重置锚点为 `end_time` / `weekly_end_time`（epoch 毫秒）。
 */
function windowRow(label: string, item: Record<string, unknown>, prefix: WindowPrefix): UsageRow | null {
	const status = toFiniteNumber(item[`${prefix}_status`])
	if (status === 3)
		return { label, percent: null, used: null, limit: null, text: '∞', resetsAt: null }

	const total = toFiniteNumber(item[`${prefix}_total_count`])
	const remaining = toFiniteNumber(item[`${prefix}_usage_count`])
	const remainingPercent = toFiniteNumber(item[`${prefix}_remaining_percent`])
	const resetMs = toFiniteNumber(item[prefix === 'current_interval' ? 'end_time' : 'weekly_end_time'])

	let used: number | null = null
	if (total != null && total > 0 && remaining != null)
		used = Math.max(0, total - remaining)

	let percent: number | null = null
	if (remainingPercent != null)
		percent = clamp100(100 - remainingPercent)
	else if (used != null && total != null && total > 0)
		percent = clamp100((used / total) * 100)

	if (used == null && percent == null)
		return null

	return {
		label,
		percent,
		used,
		limit: total != null && total > 0 ? total : null,
		text: null,
		resetsAt: resetMs != null && resetMs > 0 ? new Date(resetMs).toISOString() : null,
	}
}

/**
 * 解析 `/v1/token_plan/remains` 响应为 5h + 周窗口行。
 * `model_remains` 可能含多个模型；优先 `all` 条目，否则取第一个。导出供测试。
 */
export function parseMinimaxRemains(data: Record<string, unknown>): { rows: UsageRow[], modelName: string | null } {
	const list = Array.isArray(data.model_remains) ? data.model_remains.filter(isRecord) : []
	const entry = list.find(e => String(e.model_name ?? '').toLowerCase() === 'all') ?? list[0]
	if (entry == null)
		return { rows: [], modelName: null }

	const rows = [
		windowRow('5h', entry, 'current_interval'),
		windowRow('Week', entry, 'current_weekly'),
	].filter((r): r is UsageRow => r != null)

	const modelName = typeof entry.model_name === 'string' ? entry.model_name : null
	return { rows, modelName }
}

/**
 * 查询当前 MiniMax Token/Coding Plan 用量。
 *
 * @throws {AuthError} key 无效或非套餐（开放平台）key。
 * @throws {Error} 网络失败或异常状态码。
 */
export async function queryMinimaxUsage(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
	const url = `${minimaxQuotaBase(baseURL)}/v1/token_plan/remains`

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	let resp: Response
	try {
		resp = await globalThis.fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
		})
	}
	catch (e) {
		throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`)
	}
	finally {
		clearTimeout(timer)
	}

	const bodyText = await resp.text().catch(() => '')
	let payload: unknown
	try {
		payload = bodyText ? JSON.parse(bodyText) : {}
	}
	catch {
		throw new Error(`MiniMax: HTTP ${resp.status}: malformed JSON response`)
	}

	if (resp.status === 401 || resp.status === 403) {
		throw new AuthError('MiniMax: auth failed. Requires a Token/Coding Plan API key')
	}
	if (isRecord(payload)) {
		const baseResp = isRecord(payload.base_resp) ? payload.base_resp : undefined
		const statusCode = baseResp != null ? toFiniteNumber(baseResp.status_code) : undefined
		if (statusCode != null && statusCode !== 0) {
			if (statusCode === 401 || statusCode === 403)
				throw new AuthError(`MiniMax: invalid or expired API key (code ${statusCode})`)
			const msg = typeof baseResp?.status_msg === 'string' ? baseResp.status_msg : 'unknown error'
			throw new Error(`MiniMax API error (code ${statusCode}): ${msg}`)
		}
	}
	if (!resp.ok)
		throw new Error(`MiniMax: HTTP ${resp.status} ${bodyText.slice(0, 120)}`)

	const record = isRecord(payload) ? payload : {}
	return { kind: 'minimax', title, plan: null, rows: parseMinimaxRemains(record).rows }
}
