/**
 * 跨平台安装脚本：把本项目 src/ 链接到 pi 的用户扩展目录。
 *
 *   node scripts/install.mjs          安装（或刷新链接）
 *   node scripts/install.mjs remove   卸载
 *
 * Windows 用 NTFS junction（无需管理员权限）；macOS/Linux 用符号链接。
 * pi 通过 jiti 加载扩展源码，运行时零 npm 依赖（对 pi 包的引用全部是
 * import type），链接后源码改动即时生效（重启 pi 生效）。
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const srcDir = join(projectRoot, 'src')

const extensionsDir = join(homedir(), '.pi', 'agent', 'extensions')
const linkPath = join(extensionsDir, 'pi-usage')

function removeExistingLink() {
	if (!existsSync(linkPath))
		return false
	const stat = lstatSync(linkPath)
	if (!stat.isSymbolicLink()) {
		// junction 与 symlink 都报告 isSymbolicLink；其他情况是用户自己放的文件 — 不动它
		throw new Error(`refusing to overwrite non-link path: ${linkPath}`)
	}
	rmSync(linkPath, { recursive: true })
	return true
}

if (process.argv.includes('remove')) {
	console.log(removeExistingLink() ? `removed ${linkPath}` : 'not installed — nothing to remove')
	process.exit(0)
}

if (!existsSync(srcDir)) {
	console.error(`src directory not found: ${srcDir}`)
	process.exit(1)
}

const refreshed = removeExistingLink()
mkdirSync(extensionsDir, { recursive: true })
symlinkSync(srcDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`${refreshed ? 'refreshed' : 'linked'} ${linkPath} -> ${srcDir}`)
console.log('restart pi and the usage line appears at the bottom of the footer')
