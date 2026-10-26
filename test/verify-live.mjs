/**
 * 端到端验证 — 读取本机 pi 认证（~/.pi/agent/auth.json），对四家额度
 * 接口发起真实请求，打印解析结果与 footer 状态行预览。
 *
 *   node test/verify-live.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const { queryGlmUsage } = await import('../src/providers/glm.ts')
const { queryKimiUsage } = await import('../src/providers/kimi.ts')
const { queryDeepseekBalance } = await import('../src/providers/deepseek.ts')
const { queryMinimaxUsage } = await import('../src/providers/minimax.ts')
const { classifyById } = await import('../src/providers/resolve.ts')
const { formatStatusLine, formatDetailText } = await import('../src/format.ts')

const authPath = join(homedir(), '.pi', 'agent', 'auth.json')
if (!existsSync(authPath)) {
	console.error(`no pi auth file at ${authPath} — nothing to verify`)
	process.exit(1)
}
const auth = JSON.parse(readFileSync(authPath, 'utf8'))
const theme = { fg: (_token, text) => text }

let failed = 0
for (const [providerId, entry] of Object.entries(auth)) {
	const cls = classifyById(providerId)
	if (!cls) {
		console.log(`--  ${providerId}: not a GLM / Kimi / DeepSeek / MiniMax provider, skipped`)
		continue
	}
	const key = typeof entry?.key === 'string' ? entry.key : undefined
	if (!key) {
		console.log(`--  ${providerId}: no api key in auth.json, skipped`)
		continue
	}

	try {
		let data
		switch (cls.kind) {
			case 'glm': data = await queryGlmUsage(key, cls.baseURL, providerId); break
			case 'kimi': data = await queryKimiUsage(key, cls.baseURL, providerId); break
			case 'deepseek': data = await queryDeepseekBalance(key, cls.baseURL, providerId); break
			case 'minimax': data = await queryMinimaxUsage(key, cls.baseURL, providerId); break
		}
		console.log(`ok  ${providerId} (${cls.baseURL})`)
		console.log(formatDetailText(data).split('\n').map(l => `    ${l}`).join('\n'))
		console.log(`    footer: ${formatStatusLine(theme, data)}`)
	}
	catch (e) {
		failed++
		console.error(`FAIL  ${providerId}: ${e.message}`)
	}
}

console.log(failed > 0 ? `\n${failed} provider(s) failed` : '\nall providers ok')
process.exit(failed > 0 ? 1 : 0)
