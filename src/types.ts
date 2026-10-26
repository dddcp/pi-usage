/**
 * provider 适配器与状态行之间的数据契约。
 *
 * 适配器只需产出一个 {@link UsageData}；显示端（footer 状态行 / /usage 命令）
 * 不关心数据来源。
 */

export type ProviderKind = 'glm' | 'kimi' | 'deepseek' | 'minimax'

/**
 * 一行额度信息。
 *
 * 百分比行（`percent != null`）显示用量比例；文本行（`text != null`，
 * 例如 DeepSeek 余额）显示纯值。
 */
export interface UsageRow {
	label: string
	/** 用量百分比 0–100，provider 未返回比例时为 null。 */
	percent: number | null
	/** 已用额度（provider 的单位：信用点 / 次数），未返回时为 null。 */
	used: number | null
	/** 总额度（同一单位），未返回时为 null。 */
	limit: number | null
	/** 非比例行的文本值，如 `¥4.29`。 */
	text: string | null
	/** 窗口重置时间（ISO-8601），未返回时为 null。 */
	resetsAt: string | null
	/** 用警示色渲染（如余额不足）。 */
	warn?: boolean
}

export interface UsageData {
	kind: ProviderKind
	/** 显示标题 — 一般为 provider id（zai / kimi-coding / …）。 */
	title: string
	/** 套餐等级，如 `Lite`。可能为 null。 */
	plan: string | null
	rows: UsageRow[]
}

/** 认证失败 — 状态行渲染专门的提示。 */
export class AuthError extends Error {
	name = 'AuthError'
}
