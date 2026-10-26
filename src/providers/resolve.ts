/**
 * 当前模型 → provider 识别、API key 解析与用量路由（pi 扩展 API 版）。
 *
 * 识别锚点：
 *   1. `ctx.model.baseUrl` 的 host — 覆盖用户在 models.json 里注册的
 *      自定义 provider（如 "lin-kimi"、"my-glm"）；
 *   2. provider id 兜底 — pi 内置 provider：`zai` / `zai-coding-cn` /
 *      `kimi-coding` / `deepseek` / `minimax` / `minimax-cn`。
 *
 * API key 通过 `ctx.modelRegistry.getApiKeyAndHeaders(model)` 解析 — 覆盖
 * pi 的全部认证路径（models.json 配置、auth.json、OAuth access token、
 * 环境变量），pi 未收录的环境变量（ZHIPU_API_KEY 等）作补充回退。
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import { AuthError, type UsageData } from '../types.ts'
import { queryDeepseekBalance } from './deepseek.ts'
import { queryGlmUsage } from './glm.ts'
import { queryKimiUsage } from './kimi.ts'
import { queryMinimaxUsage } from './minimax.ts'

export interface Classification {
	kind: 'glm' | 'kimi' | 'deepseek' | 'minimax'
	/** 模型 API base，用于构造请求 URL。 */
	baseURL: string
}

// ---------------------------------------------------------------------------
// 分类 — baseUrl host 优先，provider id 兜底
// ---------------------------------------------------------------------------

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase()
	}
	catch {
		return url.toLowerCase()
	}
}

export function classifyByURL(url: string | undefined): Classification | undefined {
	if (!url)
		return undefined
	const host = hostOf(url)

	if (host === 'open.bigmodel.cn' || host.endsWith('.bigmodel.cn') || host === 'bigmodel.cn')
		return { kind: 'glm', baseURL: url }
	if (host === 'z.ai' || host.endsWith('.z.ai'))
		return { kind: 'glm', baseURL: url }
	if (host === 'api.kimi.com' || host.endsWith('.kimi.com') || host.endsWith('.moonshot.ai') || host.endsWith('.moonshot.cn'))
		return { kind: 'kimi', baseURL: url }
	if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com'))
		return { kind: 'deepseek', baseURL: url }
	if (
		host === 'minimax.io' || host.endsWith('.minimax.io')
		|| host === 'minimaxi.com' || host.endsWith('.minimaxi.com')
		|| host === 'minimaxi.chat' || host.endsWith('.minimaxi.chat')
	)
		return { kind: 'minimax', baseURL: url }

	return undefined
}

/** pi 内置 provider 的 baseUrl（id 识别兜底时使用）。 */
export const BUILTIN_BASE_URLS: Record<string, string> = {
	'zai': 'https://api.z.ai/api/coding/paas/v4',
	'zai-coding-cn': 'https://open.bigmodel.cn/api/coding/paas/v4',
	'kimi-coding': 'https://api.kimi.com/coding/v1',
	'deepseek': 'https://api.deepseek.com',
	'minimax': 'https://api.minimax.io',
	'minimax-cn': 'https://api.minimaxi.com',
}

export function classifyById(id: string): Classification | undefined {
	const builtin = BUILTIN_BASE_URLS[id]
	if (builtin)
		return { kind: classifyByURL(builtin)!.kind, baseURL: builtin }

	const lower = id.toLowerCase()
	if (lower.startsWith('zhipuai') || lower.includes('glm'))
		return { kind: 'glm', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' }
	if (lower.startsWith('zai'))
		return { kind: 'glm', baseURL: 'https://api.z.ai/api/coding/paas/v4' }
	if (lower.includes('kimi') || lower.includes('moonshot'))
		return { kind: 'kimi', baseURL: 'https://api.kimi.com/coding/v1' }
	if (lower.includes('deepseek'))
		return { kind: 'deepseek', baseURL: 'https://api.deepseek.com' }
	if (lower.includes('minimax'))
		return { kind: 'minimax', baseURL: 'https://api.minimaxi.com' }
	return undefined
}

/** 识别当前模型：baseUrl host 优先，provider id 兜底。 */
export function classifyModel(model: Model<Api> | undefined): Classification | undefined {
	if (!model)
		return undefined
	return classifyByURL(model.baseUrl) ?? classifyById(model.provider)
}

// ---------------------------------------------------------------------------
// API key 解析：modelRegistry → 补充环境变量
// ---------------------------------------------------------------------------

/** pi 内置 env 解析未覆盖、但对应 provider 常用的环境变量。 */
const EXTRA_ENV_KEYS: Record<Classification['kind'], string[]> = {
	glm: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'],
	kimi: ['KIMI_CODING_API_KEY'],
	deepseek: [],
	minimax: ['MINIMAX_TOKEN'],
}

/** 错误提示里列出该 kind 的全部候选环境变量（含 pi 内置的）。 */
export const ALL_ENV_KEYS: Record<Classification['kind'], string[]> = {
	glm: ['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'],
	kimi: ['KIMI_API_KEY', 'KIMI_CODING_API_KEY', 'MOONSHOT_API_KEY'],
	deepseek: ['DEEPSEEK_API_KEY'],
	minimax: ['MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY', 'MINIMAX_TOKEN'],
}

async function resolveApiKey(ctx: ExtensionContext, model: Model<Api>, kind: Classification['kind']): Promise<string | undefined> {
	// modelRegistry 覆盖 pi 的全部认证路径（含 OAuth access token 与内置 env 变量）
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model).catch(() => undefined)
	if (auth?.ok && auth.apiKey)
		return auth.apiKey

	for (const name of EXTRA_ENV_KEYS[kind]) {
		const value = process.env[name]
		if (typeof value === 'string' && value.length > 0)
			return value
	}
	return undefined
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 解析当前模型的用量。ctx.model 为空、或模型不属于四家 provider 时返回
 * undefined（调用方据此清掉状态行）。
 *
 * @throws {AuthError} key 缺失或无效。
 * @throws {Error} 适配器请求失败。
 */
export async function resolveUsage(ctx: ExtensionContext): Promise<UsageData | undefined> {
	const model = ctx.model
	const cls = classifyModel(model)
	if (!model || !cls)
		return undefined

	const key = await resolveApiKey(ctx, model, cls.kind)
	if (!key)
		throw new AuthError(`no API key for "${model.provider}" (${ALL_ENV_KEYS[cls.kind].join(' / ')})`)

	const title = model.provider
	switch (cls.kind) {
		case 'glm':
			return queryGlmUsage(key, cls.baseURL, title)
		case 'kimi':
			return queryKimiUsage(key, cls.baseURL, title)
		case 'deepseek':
			return queryDeepseekBalance(key, cls.baseURL, title)
		case 'minimax':
			return queryMinimaxUsage(key, cls.baseURL, title)
	}
}
