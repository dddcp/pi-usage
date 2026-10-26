/**
 * footer 状态行与 /usage 详情的格式化。
 *
 * footer 会把 setStatus 的文本里的连续空格折叠成单个空格
 * （sanitizeStatusText），因此分隔一律用单空格或 `·`，不做空格对齐。
 * 颜色经 theme.fg() 生成 ANSI，档位：用量 <60% 绿、60–85% 黄、≥85% 红。
 */

import type { UsageData, UsageRow } from './types.ts'

/** 最小主题接口 — pi 的 Theme 结构性兼容，测试可传 identity 函数。 */
export interface StatusTheme {
	fg(token: 'dim' | 'success' | 'warning' | 'error', text: string): string
}

// ---------------------------------------------------------------------------
// 数值格式化
// ---------------------------------------------------------------------------

/** 1234 → "1234"，2040 → "2k"，1048576 → "1.0M" */
export function compact(n: number): string {
	if (n < 1000)
		return String(Math.round(n))
	if (n < 1_000_000)
		return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
	return `${(n / 1_000_000).toFixed(1)}M`
}

/** 距 `iso` 的倒计时："1h23m" / "2d4h" / "45m"。无效时间返回 ''。 */
export function countdown(iso: string | null): string {
	if (!iso)
		return ''
	const ms = Date.parse(iso)
	if (!Number.isFinite(ms))
		return ''
	const minutes = Math.max(0, Math.floor((ms - Date.now()) / 60_000))
	if (minutes < 60)
		return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24)
		return `${hours}h${minutes % 60}m`
	const days = Math.floor(hours / 24)
	return `${days}d${hours % 24}h`
}

/** 用量档位：<60 绿 / 60–85 黄 / ≥85 红；无百分比时按绿色处理。 */
function tierToken(percent: number | null): 'success' | 'warning' | 'error' {
	const pct = percent ?? 0
	if (pct >= 85)
		return 'error'
	if (pct >= 60)
		return 'warning'
	return 'success'
}

// ---------------------------------------------------------------------------
// footer 状态行
// ---------------------------------------------------------------------------

/**
 * 一行 UsageRow → 带色片段。
 * percent 行：`5h 10%(204/2k)·1h23m`；text 行：`Balance ¥4.29`。
 */
function rowSegment(theme: StatusTheme, row: UsageRow): string {
	if (row.text != null)
		return `${row.label} ${row.warn === true ? theme.fg('error', row.text) : row.text}`

	if (row.percent == null)
		return row.label

	const token = tierToken(row.percent)
	let body = theme.fg(token, `${row.percent.toFixed(0)}%`)
	if (row.used != null && row.limit != null && row.limit > 0)
		body += theme.fg(token, `(${compact(row.used)}/${compact(row.limit)})`)
	const cd = countdown(row.resetsAt)
	if (cd !== '')
		body += theme.fg('dim', `·${cd}`)
	return `${row.label} ${body}`
}

/**
 * footer 单行状态文本。
 * 例：`⚡zai-coding-cn·Lite 5h 10%(204/2k)·1h23m Week 16%(10k/62.5k)·2d4h`
 */
export function formatStatusLine(theme: StatusTheme, data: UsageData): string {
	const head = theme.fg('dim', `⚡${data.title}${data.plan != null ? `·${data.plan}` : ''}`)
	if (data.rows.length === 0)
		return `${head} ${theme.fg('dim', 'no usage data yet')}`
	return `${head} ${data.rows.map(r => rowSegment(theme, r)).join(' ')}`
}

/**
 * 错误状态行：`⚡zai-coding-cn: no API key (...)`。
 * 消息去掉换行并截断，避免挤爆 footer。
 */
export function formatErrorLine(theme: StatusTheme, provider: string, message: string): string {
	const oneLine = message.replace(/[\r\n\t]+/g, ' ').trim()
	const short = oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine
	return `${theme.fg('dim', `⚡${provider}:`)} ${theme.fg('error', short)}`
}

// ---------------------------------------------------------------------------
// /usage 详情（纯文本多行，notify 展示）
// ---------------------------------------------------------------------------

function rowDetail(row: UsageRow): string | null {
	const parts: string[] = []
	if (row.used != null && row.limit != null && row.limit > 0)
		parts.push(`${compact(row.used)}/${compact(row.limit)}`)
	const cd = countdown(row.resetsAt)
	if (cd !== '')
		parts.push(`reset ${cd}`)
	return parts.length > 0 ? parts.join(' · ') : null
}

/** 详情文本：`⚡ zai-coding-cn · Lite` + 每行一段。 */
export function formatDetailText(data: UsageData): string {
	const lines = [`⚡ ${data.title}${data.plan != null ? ` · ${data.plan}` : ''}`]
	for (const row of data.rows) {
		if (row.percent != null) {
			const detail = rowDetail(row)
			lines.push(`  ${row.label.padEnd(7)} ${row.percent.toFixed(1)}%${detail != null ? `  (${detail})` : ''}`)
		}
		else if (row.text != null) {
			lines.push(`  ${row.label.padEnd(7)} ${row.text}`)
		}
	}
	return lines.join('\n')
}
