/**
 * 单元测试 — 纯 node，无框架。直接用 node 的 type stripping 跑 TS 源码。
 *
 *   node test/run.mjs
 *
 * 覆盖：四个 provider 的响应解析、provider 分类、footer 状态行格式化。
 * 真实接口的端到端验证见 test/verify-live.mjs。
 */
import assert from 'node:assert/strict'

const { parseGlmLimits, glmQuotaBase } = await import('../src/providers/glm.ts')
const { parseKimiPayload } = await import('../src/providers/kimi.ts')
const { parseDeepseekBalance } = await import('../src/providers/deepseek.ts')
const { parseMinimaxRemains, minimaxQuotaBase } = await import('../src/providers/minimax.ts')
const { classifyByURL, classifyById, classifyModel } = await import('../src/providers/resolve.ts')
const { formatStatusLine, formatErrorLine, formatDetailText, compact, countdown } = await import('../src/format.ts')

let passed = 0
let failed = 0

function test(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ok  ${name}`)
	}
	catch (e) {
		failed++
		console.error(`FAIL  ${name}\n      ${e.message}`)
	}
}

// 主题替身 — 不着色，直接返回原文，方便断言
const theme = { fg: (_token, text) => text }

/** 未来时间 fixture：多加 30s 余量，避免 countdown 取整在毫秒级竞争下抖动（CI 慢机会失败）。 */
const inFuture = (ms) => new Date(Date.now() + ms + 30_000).toISOString()

// ---------------------------------------------------------------------------
// GLM — 2026-10-22 实测结构（CREDIT_LIMIT，含绝对值）
// ---------------------------------------------------------------------------

console.log('glm:')

test('classifies unit 3 as 5h and unit 6 as week, keeps absolute values', () => {
	const rows = parseGlmLimits({
		limits: [
			{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 204, remaining: 1795, percentage: 10, nextResetTime: Date.now() + 83 * 60_000 },
			{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 4625, remaining: 5374, percentage: 46, nextResetTime: Date.now() + 52 * 3600_000 },
		],
		level: 'lite',
	})
	assert.equal(rows.length, 2)
	assert.equal(rows[0].label, '5h')
	assert.equal(rows[0].percent, 10)
	assert.equal(rows[0].used, 204)
	assert.equal(rows[0].limit, 2000)
	assert.equal(rows[0].resetsAt != null, true)
	assert.equal(rows[1].label, 'Week')
	assert.equal(rows[1].percent, 46)
})

test('legacy TOKENS_LIMIT with percentage only still yields rows', () => {
	const rows = parseGlmLimits({
		limits: [
			{ type: 'TOKENS_LIMIT', unit: 3, percentage: 5, nextResetTime: 1792651499353 },
			{ type: 'TOKENS_LIMIT', unit: 6, percentage: 80 },
		],
	})
	assert.equal(rows.length, 2)
	assert.equal(rows[0].percent, 5)
	assert.equal(rows[0].used, null)
	assert.equal(rows[1].percent, 80)
})

test('ignores unrelated limit types', () => {
	const rows = parseGlmLimits({ limits: [{ type: 'SOMETHING_ELSE', unit: 3, percentage: 1 }] })
	assert.equal(rows.length, 0)
})

test('missing unit falls back to reset-time heuristic', () => {
	const rows = parseGlmLimits({
		limits: [
			{ type: 'CREDIT_LIMIT', percentage: 50, nextResetTime: 200 },
			{ type: 'CREDIT_LIMIT', percentage: 5 }, // no reset → 5h slot first
		],
	})
	assert.equal(rows[0].label, '5h')
	assert.equal(rows[0].percent, 5)
	assert.equal(rows[1].label, 'Week')
})

test('quota base routes bigmodel.cn vs z.ai', () => {
	assert.equal(glmQuotaBase('https://open.bigmodel.cn/api/coding/paas/v4'), 'https://open.bigmodel.cn')
	assert.equal(glmQuotaBase('https://api.z.ai/api/coding/paas/v4'), 'https://api.z.ai')
})

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------

console.log('kimi:')

test('primary shape: usage (week) + limits[300min] (5h)', () => {
	const { rows } = parseKimiPayload({
		usage: { limit: '100', remaining: '84', resetTime: '2026-10-26T00:00:00Z' },
		limits: [
			{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-10-19T15:00:00Z' } },
		],
		usages: { limit_5h: { used_ratio: 0, reset_time: '2026-10-19T15:00:00Z' }, limit_7d: { used_ratio: 0.1631 } },
	})
	assert.equal(rows.length, 2)
	assert.equal(rows[0].label, 'Week')
	assert.equal(Math.round(rows[0].percent), 16)
	assert.equal(rows[1].label, '5h')
	assert.equal(rows[1].percent, 0) // ratio fallback did NOT duplicate the 5h row
})

test('ratio-only shape: usages.limit_7d/limit_5h', () => {
	const { rows } = parseKimiPayload({
		usages: { limit_5h: { used_ratio: 0.05 }, limit_7d: { used_ratio: 0.1631 } },
	})
	assert.equal(rows.length, 2)
	assert.equal(rows[0].label, 'Week')
	assert.equal(Math.round(rows[0].percent), 16)
	assert.equal(rows[1].label, '5h')
	assert.equal(rows[1].percent, 5)
})

test('ratio above 1 clamps to 100', () => {
	const { rows } = parseKimiPayload({ usages: { limit_7d: { used_ratio: 3.5 } } })
	assert.equal(rows[0].percent, 100)
})

test('legacy data[] shape with model_name=all', () => {
	const { rows } = parseKimiPayload({
		data: [
			{ model_name: 'all', limit: 1000, used: 250, resetTime: '2026-10-26T00:00:00Z' },
		],
	})
	assert.equal(rows.length, 1)
	assert.equal(rows[0].label, 'Week')
	assert.equal(rows[0].percent, 25)
})

test('booster_wallet disabled → off row; enabled → ¥ ratio', () => {
	const off = parseKimiPayload({ booster_wallet: { status: 'STATUS_DISABLED' } })
	assert.equal(off.rows[0].label, 'Booster')
	assert.equal(off.rows[0].text, 'off')

	const on = parseKimiPayload({
		booster_wallet: {
			status: 'STATUS_ENABLED',
			monthlyUsed: { currency: 'CNY', priceInCents: '1234' },
			monthlyChargeLimit: { currency: 'CNY', priceInCents: '10000' },
		},
	})
	assert.equal(on.rows[0].percent, 12.34)
	assert.equal(on.rows[0].limit, 100)
})

test('empty payload {} → no rows, no crash', () => {
	const { rows } = parseKimiPayload({})
	assert.equal(rows.length, 0)
})

// ---------------------------------------------------------------------------
// DeepSeek — 2026-10-22 实测结构
// ---------------------------------------------------------------------------

console.log('deepseek:')

test('balance rows with currency symbol', () => {
	const { rows } = parseDeepseekBalance({
		is_available: true,
		balance_infos: [{ currency: 'CNY', total_balance: '4.29', granted_balance: '0.00', topped_up_balance: '4.29' }],
	})
	assert.equal(rows.length, 1)
	assert.equal(rows[0].label, 'Balance')
	assert.equal(rows[0].text, '¥4.29')
	assert.equal(rows[0].warn, false)
})

test('insufficient balance flags warn', () => {
	const { rows } = parseDeepseekBalance({
		is_available: false,
		balance_infos: [{ currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' }],
	})
	assert.equal(rows[0].text, '$0.00')
	assert.equal(rows[0].warn, true)
})

// ---------------------------------------------------------------------------
// MiniMax — 2026-10-23 对照官方文档 + oc-minimax-status + MiniMaxUsage 交叉验证
// ---------------------------------------------------------------------------

console.log('minimax:')

test('usage_count is REMAINING: used derived, percent from remaining_percent', () => {
	const { rows, modelName } = parseMinimaxRemains({
		model_remains: [
			{
				model_name: 'MiniMax-M2',
				start_time: 1771000000000, end_time: Date.now() + 3600_000, remains_time: 3600000,
				current_interval_total_count: 4500, current_interval_usage_count: 4309,
				current_interval_remaining_percent: 95.8,
				weekly_start_time: 1771000000000, weekly_end_time: Date.now() + 86400_000, weekly_remains_time: 86400000,
				current_weekly_total_count: 157500, current_weekly_usage_count: 155409,
				current_weekly_remaining_percent: 98.67,
			},
		],
	})
	assert.equal(modelName, 'MiniMax-M2')
	assert.equal(rows.length, 2)
	assert.equal(rows[0].label, '5h')
	assert.equal(rows[0].used, 191) // 4500 - 4309
	assert.equal(rows[0].limit, 4500)
	assert.equal(Math.round(rows[0].percent), 4) // 100 - 95.8
	assert.equal(rows[0].resetsAt != null, true)
	assert.equal(rows[1].label, 'Week')
	assert.equal(rows[1].used, 2091) // 157500 - 155409
	assert.equal(Math.round(rows[1].percent), 1) // 100 - 98.67
})

test('percent computed from counts when remaining_percent absent', () => {
	const { rows } = parseMinimaxRemains({
		model_remains: [
			{
				model_name: 'MiniMax-M2',
				current_interval_total_count: 1500, current_interval_usage_count: 1500,
			},
		],
	})
	assert.equal(rows.length, 1) // weekly fields absent → no week row
	assert.equal(rows[0].used, 0)
	assert.equal(rows[0].percent, 0)
})

test('weekly status 3 → unlimited text row', () => {
	const { rows } = parseMinimaxRemains({
		model_remains: [
			{
				model_name: 'all',
				current_interval_total_count: 4500, current_interval_usage_count: 4500,
				current_weekly_status: 3,
			},
		],
	})
	assert.equal(rows[0].label, '5h')
	assert.equal(rows[1].label, 'Week')
	assert.equal(rows[1].percent, null)
	assert.equal(rows[1].text, '∞')
})

test('prefers model_name=all; empty payload → no rows', () => {
	const { rows, modelName } = parseMinimaxRemains({
		model_remains: [
			{ model_name: 'MiniMax-M2', current_interval_total_count: 100, current_interval_usage_count: 50 },
			{ model_name: 'all', current_interval_total_count: 200, current_interval_usage_count: 100 },
		],
	})
	assert.equal(modelName, 'all')
	assert.equal(rows[0].limit, 200)

	const empty = parseMinimaxRemains({})
	assert.equal(empty.rows.length, 0)
	assert.equal(empty.modelName, null)
})

test('quota base routes global vs china hosts', () => {
	assert.equal(minimaxQuotaBase('https://api.minimax.io/v1'), 'https://api.minimax.io')
	assert.equal(minimaxQuotaBase('https://api.minimaxi.com/v1'), 'https://api.minimaxi.com')
	assert.equal(minimaxQuotaBase('https://www.minimaxi.com/v1/a2a'), 'https://api.minimaxi.com')
	assert.equal(minimaxQuotaBase('https://api.minimaxi.chat/v1'), 'https://api.minimaxi.com')
})

// ---------------------------------------------------------------------------
// resolve — 模型 → provider 分类（pi 内置 provider id + 自定义 baseURL）
// ---------------------------------------------------------------------------

console.log('resolve:')

test('classifies by baseURL host (custom providers)', () => {
	assert.equal(classifyByURL('https://open.bigmodel.cn/api/coding/paas/v4')?.kind, 'glm')
	assert.equal(classifyByURL('https://api.z.ai/api/coding/paas/v4')?.kind, 'glm')
	assert.equal(classifyByURL('https://api.kimi.com/coding/v1')?.kind, 'kimi')
	assert.equal(classifyByURL('https://api.moonshot.ai/v1')?.kind, 'kimi')
	assert.equal(classifyByURL('https://api.deepseek.com')?.kind, 'deepseek')
	assert.equal(classifyByURL('https://api.minimaxi.com/anthropic')?.kind, 'minimax')
	assert.equal(classifyByURL('https://api.minimax.io/anthropic')?.kind, 'minimax')
	assert.equal(classifyByURL('https://api.openai.com/v1'), undefined)
	assert.equal(classifyByURL(undefined), undefined)
})

test('classifies builtin pi provider ids with correct default baseURLs', () => {
	assert.deepEqual(classifyById('zai'), { kind: 'glm', baseURL: 'https://api.z.ai/api/coding/paas/v4' })
	assert.deepEqual(classifyById('zai-coding-cn'), { kind: 'glm', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' })
	assert.deepEqual(classifyById('kimi-coding'), { kind: 'kimi', baseURL: 'https://api.kimi.com/coding/v1' })
	assert.deepEqual(classifyById('deepseek'), { kind: 'deepseek', baseURL: 'https://api.deepseek.com' })
	assert.deepEqual(classifyById('minimax'), { kind: 'minimax', baseURL: 'https://api.minimax.io' })
	assert.deepEqual(classifyById('minimax-cn'), { kind: 'minimax', baseURL: 'https://api.minimaxi.com' })
})

test('id heuristics cover custom ids like lin-kimi / my-glm', () => {
	assert.equal(classifyById('lin-kimi')?.kind, 'kimi')
	assert.equal(classifyById('my-glm')?.kind, 'glm')
	assert.equal(classifyById('zhipuai-pro')?.kind, 'glm')
	assert.equal(classifyById('minimax-backup')?.kind, 'minimax')
	assert.equal(classifyById('openai'), undefined)
})

test('classifyModel prefers baseURL over provider id', () => {
	// id 说是 kimi，但 baseURL 指向 glm — 以 baseURL 为准
	const model = { provider: 'lin-kimi', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }
	assert.equal(classifyModel(model)?.kind, 'glm')
	// 无匹配 baseURL 时回落到 id
	assert.equal(classifyModel({ provider: 'minimax-cn', baseUrl: 'https://example.com/v1' })?.kind, 'minimax')
	assert.equal(classifyModel(undefined), undefined)
})

// ---------------------------------------------------------------------------
// format — footer 状态行 / 详情
// ---------------------------------------------------------------------------

console.log('format:')

test('compact number formatting', () => {
	assert.equal(compact(204), '204')
	assert.equal(compact(2000), '2.0k')
	assert.equal(compact(4625), '4.6k')
	assert.equal(compact(157500), '158k')
	assert.equal(compact(1_048_576), '1.0M')
})

test('countdown formats minutes/hours/days', () => {
	assert.equal(countdown(null), '')
	assert.equal(countdown('not-a-date'), '')
	assert.equal(countdown(inFuture(45 * 60_000)), '45m')
	assert.equal(countdown(inFuture(83 * 60_000)), '1h23m')
	assert.equal(countdown(inFuture(52 * 3600_000)), '2d4h')
	assert.equal(countdown(new Date(Date.now() - 60_000).toISOString()), '0m')
})

test('status line: percent rows with values and countdown', () => {
	const line = formatStatusLine(theme, {
		kind: 'glm',
		title: 'zai-coding-cn',
		plan: 'Lite',
		rows: [
			{ label: '5h', percent: 10, used: 204, limit: 2000, text: null, resetsAt: inFuture(83 * 60_000) },
			{ label: 'Week', percent: 46, used: 4625, limit: 10000, text: null, resetsAt: inFuture(52 * 3600_000) },
		],
	})
	assert.equal(line, '⚡zai-coding-cn·Lite 5h 10%(204/2.0k)·1h23m Week 46%(4.6k/10k)·2d4h')
})

test('status line: ratio-only rows (no used/limit)', () => {
	const line = formatStatusLine(theme, {
		kind: 'kimi',
		title: 'kimi-coding',
		plan: null,
		rows: [
			{ label: 'Week', percent: 16, used: null, limit: null, text: null, resetsAt: null },
		],
	})
	assert.equal(line, '⚡kimi-coding Week 16%')
})

test('status line: text rows and no-usage hint', () => {
	const line = formatStatusLine(theme, {
		kind: 'deepseek',
		title: 'deepseek',
		plan: null,
		rows: [
			{ label: 'Balance', percent: null, used: null, limit: null, text: '¥4.29', resetsAt: null, warn: true },
		],
	})
	assert.equal(line, '⚡deepseek Balance ¥4.29')

	const empty = formatStatusLine(theme, { kind: 'kimi', title: 'kimi-coding', plan: null, rows: [] })
	assert.equal(empty, '⚡kimi-coding no usage data yet')
})

test('error line flattens newlines and truncates', () => {
	assert.equal(formatErrorLine(theme, 'zai-coding-cn', 'no API key (ZAI_API_KEY / ZHIPU_API_KEY)'), '⚡zai-coding-cn: no API key (ZAI_API_KEY / ZHIPU_API_KEY)')
	const long = formatErrorLine(theme, 'kimi', `x\ny\n${'z'.repeat(100)}`)
	assert.ok(!long.includes('\n'))
	assert.ok(long.length <= 120)
})

test('detail text is multi-line with padded labels', () => {
	const text = formatDetailText({
		kind: 'glm',
		title: 'zai-coding-cn',
		plan: 'Lite',
		rows: [
			{ label: '5h', percent: 10.4, used: 204, limit: 2000, text: null, resetsAt: inFuture(83 * 60_000) },
			{ label: 'Week', percent: 46, used: 4625, limit: 10000, text: null, resetsAt: null },
		],
	})
	const lines = text.split('\n')
	assert.equal(lines[0], '⚡ zai-coding-cn · Lite')
	assert.ok(lines[1].startsWith('  5h      10.4%  (204/2.0k · reset 1h23m)'))
	assert.ok(lines[2].startsWith('  Week    46.0%  (4.6k/10k)'))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
