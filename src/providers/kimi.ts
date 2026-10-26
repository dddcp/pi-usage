/**
 * Kimi Coding Plan 用量适配。
 *
 *   GET {base}/usages                       e.g. base = https://api.kimi.com/coding/v1
 *   Authorization: Bearer <sk-kimi-...>
 *   User-Agent: KimiCLI/<ver>               (CLI 风格 UA；服务端不强制)
 *
 * 实测过的三种响应结构（2026-10）：
 *
 *   {                                        // 主结构
 *     "usage":  { "limit": "100", "remaining": "84", "resetTime": "..." },
 *     "limits": [ { "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
 *                  "detail": { "limit": "100", "remaining": "100", "resetTime": "..." } } ],
 *     "usages": { "limit_5h": { "used_ratio": 0,    "reset_time": "..." },
 *                 "limit_7d": { "used_ratio": 0.16, "reset_time": "..." } },
 *     "booster_wallet": { "status": "STATUS_DISABLED",
 *                         "monthlyUsed": { "currency": "CNY", "priceInCents": "1234" },
 *                         "monthlyChargeLimit": { "currency": "CNY", "priceInCents": "10000" } }
 *   }
 *
 *   { "data": [ { "model_name": "all", "limit": ..., "used": ..., "resetTime": ... } ] }
 *   {}                                       // 全新 key 无流量
 *
 * 要点：
 *   - `usage` 是周窗口；`limits[].window` duration 300（分钟）是 5 小时窗口。
 *   - `used_ratio` 是 0–1 比例（不是百分数）。
 *   - `usages.*` 只补充主结构未覆盖的窗口，不产生重复行。
 *   - `priceInCents` 可能是字符串。
 */

import { AuthError, type UsageData, type UsageRow } from '../types.ts'

const REQUEST_TIMEOUT_MS = 15_000
const USER_AGENT = 'KimiCLI/1.6'

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

function parseResetTime(v: unknown): string | null {
	if (typeof v === 'number' && Number.isFinite(v))
		return new Date(v).toISOString()
	if (typeof v === 'string' && v.length > 0) {
		const ms = Date.parse(v.endsWith('Z') || v.includes('+') ? v : `${v}Z`)
		if (Number.isFinite(ms))
			return new Date(ms).toISOString()
	}
	return null
}

/** 从 `limit` + (`used` | `remaining`) 明细对象推出 used/percent */
function detailRow(label: string, detail: Record<string, unknown>): UsageRow | null {
	const limit = toFiniteNumber(detail.limit ?? detail.limit_amount)
	const used = toFiniteNumber(detail.used ?? detail.used_amount)
	const remaining = toFiniteNumber(detail.remaining)
	let resolvedUsed = used
	if (resolvedUsed == null && remaining != null && limit != null)
		resolvedUsed = limit - remaining
	if (resolvedUsed == null || limit == null || limit <= 0)
		return null
	return {
		label,
		percent: Math.max(0, Math.min(100, (resolvedUsed / limit) * 100)),
		used: resolvedUsed,
		limit,
		text: null,
		resetsAt: parseResetTime(detail.resetTime ?? detail.reset_time ?? detail.reset_at),
	}
}

/** `usages.limit_*` 条目：只有 0–1 比例，没有绝对值 */
function ratioRow(label: string, entry: Record<string, unknown>): UsageRow | null {
	const ratio = toFiniteNumber(entry.used_ratio)
	if (ratio == null)
		return null
	return {
		label,
		percent: Math.max(0, Math.min(100, ratio * 100)),
		used: null,
		limit: null,
		text: null,
		resetsAt: parseResetTime(entry.reset_time ?? entry.resetTime),
	}
}

/** `limits[].window` 覆盖的分钟数 — 用于识别 300 分钟（5h）槽位 */
function windowMinutes(window: unknown): number | null {
	if (!isRecord(window))
		return null
	const duration = toFiniteNumber(window.duration)
	if (duration == null)
		return null
	const unit = String(window.timeUnit ?? window.time_unit ?? '').toUpperCase()
	if (unit.includes('MINUTE'))
		return duration
	if (unit.includes('HOUR'))
		return duration * 60
	if (unit.includes('DAY'))
		return duration * 1440
	if (unit.includes('MONTH'))
		return duration * 43200
	return null
}

function priceInCents(v: unknown): number | undefined {
	if (!isRecord(v))
		return undefined
	return toFiniteNumber(v.priceInCents)
}

/** `booster_wallet`（蛇形，线上）/ `boosterWallet`（驼峰，旧版）— 加油包 */
function boosterRow(payload: Record<string, unknown>): UsageRow | null {
	const wallet = isRecord(payload.booster_wallet) && Object.keys(payload.booster_wallet).length > 0
		? payload.booster_wallet
		: isRecord(payload.boosterWallet)
			? payload.boosterWallet
			: undefined
	if (wallet == null)
		return null

	const enabled = wallet.status === 'STATUS_ENABLED'
		|| wallet.monthlyChargeLimitEnabled === true
		|| wallet.monthly_charge_limit_enabled === true
	if (!enabled) {
		// 存在但未开启 — 显示出来让用户知道有这个选项。
		return { label: 'Booster', percent: null, used: null, limit: null, text: 'off', resetsAt: null }
	}

	const usedCents = priceInCents(wallet.monthlyUsed ?? wallet.monthly_used)
	const limitCents = priceInCents(wallet.monthlyChargeLimit ?? wallet.monthly_charge_limit)
	if (usedCents == null)
		return null
	if (limitCents != null && limitCents > 0) {
		const used = usedCents / 100
		const limit = limitCents / 100
		return {
			label: 'Booster',
			percent: Math.max(0, Math.min(100, (used / limit) * 100)),
			used,
			limit,
			text: null,
			resetsAt: null,
		}
	}
	return { label: 'Booster', percent: null, used: null, limit: null, text: `¥${(usedCents / 100).toFixed(2)}`, resetsAt: null }
}

/** 解析 `/usages` 响应为显示行。导出供测试。 */
export function parseKimiPayload(payload: Record<string, unknown>): { rows: UsageRow[] } {
	const rows: UsageRow[] = []
	const coveredFiveHour = new Set<string>()

	// 结构 A：旧版 `data[]` 数组
	if (Array.isArray(payload.data)) {
		for (const item of payload.data) {
			if (!isRecord(item))
				continue
			if (item.model_name === 'all' || item.modelName === 'all') {
				const row = detailRow('Week', item)
				if (row != null)
					rows.unshift(row)
			}
		}
	}

	// 结构 B：主 `usage`（周）+ `limits[]`（窗口）
	if (rows.length === 0 && isRecord(payload.usage)) {
		const row = detailRow('Week', payload.usage)
		if (row != null)
			rows.push(row)
	}
	if (Array.isArray(payload.limits)) {
		for (const item of payload.limits) {
			if (!isRecord(item))
				continue
			const detail = isRecord(item.detail) ? item.detail : item
			const minutes = windowMinutes(item.window ?? item)
			const label = minutes === 300 || minutes === 5 ? '5h' : 'Limit'
			const row = detailRow(label, detail)
			if (row != null) {
				if (label === '5h')
					coveredFiveHour.add('5h')
				rows.push(row)
			}
		}
	}

	// 结构 C：`usages.limit_7d / limit_5h` 比例回退 — 只补缺口
	const usages = isRecord(payload.usages) ? payload.usages : undefined
	if (usages != null) {
		const hasWeeklyRow = rows.some(r => r.label === 'Week')
		if (!hasWeeklyRow && isRecord(usages.limit_7d)) {
			const row = ratioRow('Week', usages.limit_7d)
			if (row != null)
				rows.unshift(row)
		}
		if (!coveredFiveHour.has('5h') && isRecord(usages.limit_5h)) {
			const row = ratioRow('5h', usages.limit_5h)
			if (row != null)
				rows.push(row)
		}
	}

	const booster = boosterRow(payload)
	if (booster != null)
		rows.push(booster)

	return { rows }
}

/**
 * 查询当前 Kimi Coding Plan 用量。
 *
 * @throws {AuthError} key 类型错误（如开放平台 key）或 key 无效。
 * @throws {Error} 网络失败或异常状态码。
 */
export async function queryKimiUsage(apiKey: string, baseURL: string, title: string): Promise<UsageData> {
	const url = `${baseURL.replace(/\/+$/, '')}/usages`

	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	let resp: Response
	try {
		resp = await globalThis.fetch(url, {
			method: 'GET',
			signal: controller.signal,
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'User-Agent': USER_AGENT,
			},
		})
	}
	catch (e) {
		throw new Error(`network error: ${e instanceof Error ? e.message : String(e)}`)
	}
	finally {
		clearTimeout(timer)
	}

	if (resp.status === 401 || resp.status === 403) {
		throw new AuthError(
			'Kimi: auth failed. Requires a Kimi Coding Plan key (sk-kimi-...), not an open-platform key',
		)
	}
	if (resp.status === 404) {
		throw new Error('Kimi: usage endpoint not found — is the baseURL https://api.kimi.com/coding/v1?')
	}
	if (!resp.ok) {
		const text = await resp.text().catch(() => '')
		throw new Error(`Kimi: HTTP ${resp.status} ${text.slice(0, 120)}`)
	}

	const bodyText = await resp.text().catch(() => '')
	let payload: unknown
	try {
		payload = bodyText ? JSON.parse(bodyText) : {}
	}
	catch {
		throw new Error('Kimi: malformed JSON response')
	}
	const record = isRecord(payload) ? payload : {}

	return { kind: 'kimi', title, plan: null, rows: parseKimiPayload(record).rows }
}
