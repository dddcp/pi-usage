/**
 * GLM coding-plan 用量适配 — 智谱国内 (open.bigmodel.cn) 与国际 (api.z.ai)。
 *
 * 两家共用同一套额度后端与响应结构。2026-10 实测：
 *
 *   GET {base}/api/monitor/usage/quota/limit
 *   Authorization: <apiKey>          (裸 key — 无 "Bearer " 前缀)
 *
 *   {
 *     "code": 200, "msg": "Operation successful", "success": true,
 *     "data": {
 *       "limits": [
 *         { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
 *           "currentValue": 204, "remaining": 1795, "percentage": 10,
 *           "nextResetTime": 1792651499353 },
 *         { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000, ... }
 *       ],
 *       "level": "lite"
 *     }
 *   }
 *
 * `unit: 3` 是 5 小时滚动窗口，`unit: 6` 是周窗口。旧套餐用
 * `type: "TOKENS_LIMIT"`（仅百分比），新套餐用 `CREDIT_LIMIT`（含
 * `usage`/`currentValue`/`remaining` 绝对值），两者均兼容。业务错误
 * （key 无效）可能伴随 HTTP 200 返回，必须检查 body 的 `code`/`success`。
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined
}

function asFiniteNumber(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 从模型 baseURL 路由额度接口的 host。不做跨 host 回退。 */
export function glmQuotaBase(baseURL: string): string {
	return baseURL.toLowerCase().includes('bigmodel.cn')
		? 'https://open.bigmodel.cn'
		: 'https://api.z.ai'
}

type WindowKey = 'fiveHour' | 'week'

function classifyWindow(item: Record<string, unknown>): WindowKey | undefined {
	const unit = asFiniteNumber(item.unit)
	if (unit === 3)
		return 'fiveHour'
	if (unit === 6)
		return 'week'
	return undefined
}

const LABELS: Record<WindowKey, string> = {
	fiveHour: '5h',
	week: 'Week',
}

function toRow(key: WindowKey, item: Record<string, unknown>): UsageRow {
	const percentage = asFiniteNumber(item.percentage) ?? null
	const limit = asFiniteNumber(item.usage) ?? null
	const used = asFiniteNumber(item.currentValue) ?? null
	const resetMs = asFiniteNumber(item.nextResetTime)
	return {
		label: LABELS[key],
		percent: percentage,
		used,
		limit,
		text: null,
		resetsAt: resetMs != null ? new Date(resetMs).toISOString() : null,
	}
}

/**
 * 解析 `data.limits[]` 为 GLM 的两个窗口。
 *
 * 只以 `unit` 为分类锚点（周窗口出现过 `unit:6, number:7` 和
 * `unit:6, number:1` 两种）。`unit` 缺失时：无重置时间的条目先填
 * 5 小时槽（0% 用量时该窗口确实没有重置时间），其余按重置时间排序。
 */
export function parseGlmLimits(data: Record<string, unknown>): UsageRow[] {
	let fiveHour: UsageRow | undefined
	let week: UsageRow | undefined
	const unclassified: { resetMs: number | undefined, item: Record<string, unknown> }[] = []

	const limits = data.limits
	if (Array.isArray(limits)) {
		for (const raw of limits) {
			if (!isRecord(raw))
				continue
			const type = (asString(raw.type) ?? '').toLowerCase()
			if (type !== 'credit_limit' && type !== 'tokens_limit')
				continue

			const slot = classifyWindow(raw)
			if (slot === 'fiveHour' && fiveHour == null) {
				fiveHour = toRow(slot, raw)
			}
			else if (slot === 'week' && week == null) {
				week = toRow(slot, raw)
			}
			else {
				unclassified.push({ resetMs: asFiniteNumber(raw.nextResetTime), item: raw })
			}
		}
	}

	if (fiveHour == null || week == null) {
		unclassified.sort((a, b) => {
			const aHas = a.resetMs != null ? 1 : 0
			const bHas = b.resetMs != null ? 1 : 0
			if (aHas !== bHas)
				return aHas - bHas
			return (a.resetMs ?? Number.NEGATIVE_INFINITY) - (b.resetMs ?? Number.NEGATIVE_INFINITY)
		})
		for (const { item } of unclassified) {
			if (fiveHour == null)
				fiveHour = toRow('fiveHour', item)
			else if (week == null)
				week = toRow('week', item)
		}
	}

	const rows: UsageRow[] = []
	if (fiveHour != null)
		rows.push(fiveHour)
	if (week != null)
		rows.push(week)
	return rows
}

/**
 * 查询当前 GLM coding-plan 用量。
 *
 * @throws {AuthError} key 无效或过期。
 * @throws {Error} 网络失败或响应结构异常。
 */
export async function queryGlmUsage(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
	const url = `${glmQuotaBase(baseURL)}/api/monitor/usage/quota/limit`

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	let resp: Response
	try {
		resp = await globalThis.fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				// GLM 要求裸 API key — 无 "Bearer " 前缀。
				'Authorization': apiKey,
				'Content-Type': 'application/json',
				'Accept-Language': 'en-US,en',
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
	let body: unknown
	try {
		body = bodyText ? JSON.parse(bodyText) : undefined
	}
	catch {
		throw new Error(`HTTP ${resp.status}: malformed JSON response`)
	}

	if (isRecord(body)) {
		const code = asFiniteNumber(body.code)
		const success = body.success
		if (success === false || (code != null && code !== 200)) {
			if (code === 401 || code === 403)
				throw new AuthError(`GLM: invalid or expired API key (code ${code})`)
			throw new Error(`GLM API error (code ${code ?? 'unknown'}): ${asString(body.msg) ?? 'unknown error'}`)
		}
	}
	if (!resp.ok)
		throw new Error(`GLM: HTTP ${resp.status}`)

	const data = isRecord(body) ? body.data : undefined
	if (!isRecord(data))
		throw new Error('GLM: missing \'data\' field in response')

	const level = asString(data.level)
	return {
		kind: 'glm',
		title,
		plan: level != null && level.length > 0 ? level.charAt(0).toUpperCase() + level.slice(1) : null,
		rows: parseGlmLimits(data),
	}
}
