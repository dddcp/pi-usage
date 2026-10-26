/**
 * pi-usage — Pi 扩展：在 TUI footer 最下方显示当前模型所属 Coding 套餐
 * 的剩余额度。支持 GLM（智谱国内 / z.ai 国际）、Kimi Coding Plan、
 * DeepSeek（按量余额）、MiniMax Token/Coding Plan（国内 / 国际）。
 *
 * 通过 ctx.ui.setStatus("usage", …) 显示 — 该行渲染在 footer 的扩展
 * 状态区，即整个界面的最底部。面板跟随当前模型：切换模型自动切换到
 * 对应 provider 的额度；每 5 分钟自动刷新，每轮对话结束后 3 秒也会刷新
 * 一次，`/usage` 手动刷新并弹出详情。
 *
 * 加载方式：链接到 ~/.pi/agent/extensions/pi-usage（node scripts/install.mjs）。
 * 运行时零 npm 依赖 — 对 pi 包的引用全部是 `import type`，jiti 加载时
 * 剥离；请求用 globalThis.fetch。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { formatDetailText, formatErrorLine, formatStatusLine } from './format.ts'
import { AuthError } from './types.ts'
import { classifyModel, resolveUsage } from './providers/resolve.ts'

const STATUS_KEY = 'usage'
const REFRESH_MS = 5 * 60 * 1000
const SETTLED_DEBOUNCE_MS = 3000
const MIN_REFRESH_INTERVAL_MS = 2000

// 会话级状态（session 替换 / reload 时随旧 runtime 一起失效重建）
let refreshTimer: ReturnType<typeof setInterval> | undefined
let settledDebounce: ReturnType<typeof setTimeout> | undefined
let inflight = false
let lastRunAt = 0

/**
 * 拉取当前模型的额度并更新 footer 状态行。
 *
 * - 模型不属于四家 provider：清掉状态行；
 * - 请求失败：状态行显示简短错误（保留在底部，直到下次刷新成功）；
 * - `notify: true` 时额外弹出详情（/usage 命令）。
 */
async function refresh(ctx: ExtensionContext, opts: { force?: boolean, notify?: boolean } = {}): Promise<void> {
	// print / json 模式没有 footer，不值得发请求
	if (!ctx.hasUI)
		return

	const now = Date.now()
	if (!opts.force) {
		if (inflight)
			return
		if (now - lastRunAt < MIN_REFRESH_INTERVAL_MS)
			return
	}

	inflight = true
	lastRunAt = now
	try {
		const theme = ctx.ui.theme
		try {
			const data = await resolveUsage(ctx)
			if (!data) {
				ctx.ui.setStatus(STATUS_KEY, undefined)
				if (opts.notify)
					ctx.ui.notify('当前模型不属于 GLM / Kimi / DeepSeek / MiniMax，无额度可查', 'info')
				return
			}
			ctx.ui.setStatus(STATUS_KEY, formatStatusLine(theme, data))
			if (opts.notify)
				ctx.ui.notify(formatDetailText(data), 'info')
		}
		catch (e) {
			const provider = ctx.model?.provider ?? 'usage'
			const message = e instanceof Error ? e.message : String(e)
			ctx.ui.setStatus(STATUS_KEY, formatErrorLine(theme, provider, message))
			if (opts.notify)
				ctx.ui.notify(e instanceof AuthError ? message : `额度查询失败：${message}`, 'error')
		}
	}
	finally {
		inflight = false
	}
}

export default function (pi: ExtensionAPI) {
	// 会话启动：初次刷新 + 5 分钟定时器（factory 里不启动 timers，见 pi 扩展约定）
	pi.on('session_start', async (_event, ctx) => {
		void refresh(ctx)
		refreshTimer = setInterval(() => void refresh(ctx), REFRESH_MS)
	})

	// 会话结束 / 替换 / reload：清理定时器（footer 的扩展状态由 pi 自行清空）
	pi.on('session_shutdown', async () => {
		if (refreshTimer != null)
			clearInterval(refreshTimer)
		refreshTimer = undefined
		if (settledDebounce != null)
			clearTimeout(settledDebounce)
		settledDebounce = undefined
	})

	// 切换模型（/model、Ctrl+P、会话恢复）：跟随新 provider
	pi.on('model_select', async (_event, ctx) => {
		void refresh(ctx)
	})

	// 每轮对话结束：额度刚被消耗，3 秒后刷新（合并连续的 settled）
	pi.on('agent_settled', async (_event, ctx) => {
		if (settledDebounce != null)
			clearTimeout(settledDebounce)
		settledDebounce = setTimeout(() => {
			settledDebounce = undefined
			void refresh(ctx)
		}, SETTLED_DEBOUNCE_MS)
	})

	// /usage：手动刷新 + 弹出详情；/usage off 临时隐藏状态行
	pi.registerCommand('usage', {
		description: '刷新并显示当前模型所属套餐的剩余额度（/usage off 隐藏）',
		handler: async (args, ctx) => {
			if (args.trim() === 'off') {
				ctx.ui.setStatus(STATUS_KEY, undefined)
				ctx.ui.notify('额度状态行已隐藏（下轮对话结束后会自动恢复）', 'info')
				return
			}
			if (!ctx.model) {
				ctx.ui.notify('当前没有选中的模型', 'warning')
				return
			}
			const cls = classifyModel(ctx.model)
			if (!cls) {
				ctx.ui.notify(`模型 "${ctx.model.provider}/${ctx.model.id}" 不属于 GLM / Kimi / DeepSeek / MiniMax`, 'info')
				return
			}
			await refresh(ctx, { force: true, notify: true })
		},
	})
}
