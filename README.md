# pi-coding-quota

[![npm](https://img.shields.io/npm/v/pi-coding-quota)](https://www.npmjs.com/package/pi-coding-quota)

Pi（[@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi)）TUI 扩展：在界面最下方（footer 的扩展状态行）实时显示当前模型所属 Coding 套餐的剩余额度。

```
 ~/workspace/node/pi-usage (main)
 ↑1.2k ↓3.4k $0.021 12.3%/200k   glm-5.3
 ⚡zai-coding-cn·Lite 5h 24%(499/2.0k)·4h34m Week 11%(1.2k/10k)·3d4h
```

状态行跟随 TUI 中当前选中的模型：切换模型（`/model`、Ctrl+P、会话恢复）时自动切换到对应 provider 的额度；每 5 分钟自动刷新，每轮对话结束后 3 秒也会刷新一次，`/usage` 手动刷新并弹出详情。用量按档位着色：`<60%` 绿、`60–85%` 黄、`≥85%` 红。

## 支持的 Provider

| Provider              | pi 内置 id            | 显示内容                                                                 |
| --------------------- | --------------------- | ------------------------------------------------------------------------ |
| GLM 国内（智谱）      | `zai-coding-cn`       | 5 小时窗口 / 周窗口的百分比、已用/总量（信用点）、重置倒计时、套餐等级 |
| GLM 国际（z.ai）      | `zai`                 | 同上（两家共用同一套接口）                                              |
| Kimi Coding Plan      | `kimi-coding`         | 周 / 5 小时窗口百分比与重置倒计时；加油包（booster）开启时显示 ¥ 用量  |
| DeepSeek              | `deepseek`            | 账户余额（¥ / $）；余额不足时红色警示                                   |
| MiniMax 国际          | `minimax`             | 5 小时窗口 / 周窗口的调用次数百分比、已用/总量、重置倒计时             |
| MiniMax 国内          | `minimax-cn`          | 同上（两家共用同一套接口）                                              |

在 `models.json` 里注册的自定义 provider 按其 `baseUrl` 的 host 识别（`open.bigmodel.cn` / `*.z.ai` / `api.kimi.com` / `*.moonshot.ai` / `api.deepseek.com` / `api.minimaxi.com` / `api.minimax.io` 等），provider id 里含 `glm` / `zai` / `kimi` / `moonshot` / `deepseek` / `minimax` 也可作为兜底识别。当前模型不属于四家时，状态行自动清空。

API key 解析顺序：`modelRegistry.getApiKeyAndHeaders(model)`（覆盖 pi 的全部认证路径 — models.json 配置、`~/.pi/agent/auth.json`（`/login` 登录）、OAuth access token、内置环境变量）→ 补充环境变量（`ZHIPU_API_KEY` / `ZHIPUAI_API_KEY`、`KIMI_CODING_API_KEY`、`MINIMAX_TOKEN`）。

## 安装

### 方式一：npm 安装（推荐）

```bash
pi install npm:pi-coding-quota
```

重启 pi，打开任意会话即可在 footer 底部看到状态行。更新：`pi update --extensions`。卸载：`pi remove npm:pi-coding-quota`。试用不写入配置：`pi -e npm:pi-coding-quota`。

### 方式二：从源码安装（开发 / 不依赖 npm）

```bash
git clone https://github.com/dddcp/pi-usage.git
cd pi-usage
# 本地目录（pi 直接从解析路径加载，不复制）
pi install ./pi-usage
# 或者链接 src/ 到 pi 用户扩展目录（改动即时生效，重启 pi 加载）
node scripts/install.mjs     # Windows 用 NTFS junction，无需管理员权限
```

扩展对 pi 包的引用全部是 `import type`，jiti 加载时剥离 — **运行时零 npm 依赖**，`src/` 下的源码改动重启 pi 即生效。链接卸载：`node scripts/install.mjs remove`。

## 命令

| 命令        | 作用                                             |
| ----------- | ------------------------------------------------ |
| `/usage`    | 手动刷新并弹出当前模型的额度详情                 |
| `/usage off`| 临时隐藏状态行（下轮对话结束后自动恢复）         |

## 项目结构

```
src/
├── index.ts              # 扩展入口（事件注册 + footer 状态行 + /usage 命令）
├── format.ts             # footer 单行 / 详情格式化（档位颜色、compact、倒计时）
├── types.ts              # UsageData / UsageRow 数据契约
└── providers/
    ├── glm.ts            # 智谱国内/国际 quota 接口适配
    ├── kimi.ts           # Kimi Coding Plan /usages 适配
    ├── deepseek.ts       # DeepSeek /user/balance 适配
    ├── minimax.ts        # MiniMax /v1/token_plan/remains 适配
    └── resolve.ts        # 当前模型 → provider 识别、key 解析、路由
scripts/
└── install.mjs           # 跨平台安装/卸载脚本（链接 src/ 到 pi 扩展目录）
test/
├── run.mjs               # 解析/分类/格式化单元测试（mock payload，纯 node）
└── verify-live.mjs       # 端到端验证（读本机 pi auth.json，真实调用接口）
```

## 开发

```bash
npm install               # 安装 devDependencies（仅类型检查用）
npm run typecheck         # tsc --noEmit
npm test                  # 单元测试
npm run verify-live       # 真实接口端到端验证（读 ~/.pi/agent/auth.json）
npm run setup             # 链接到 pi（等价于 node scripts/install.mjs）
```

## 接口细节（2026-10 实测）

- **GLM**：`GET {base}/api/monitor/usage/quota/limit`，`Authorization` 头直接放 key（无 `Bearer` 前缀）。响应 `data.limits[]` 中 `unit:3` 为 5 小时窗口、`unit:6` 为周窗口；旧套餐返回 `TOKENS_LIMIT`（仅百分比），新套餐返回 `CREDIT_LIMIT`（含 `usage`/`currentValue`/`remaining` 绝对值），两者均兼容。注意业务错误可能伴随 HTTP 200 返回，需检查 body 的 `code`/`success`。
- **Kimi**：`GET {base}/usages`，`Authorization: Bearer`。兼容三种历史格式（`usage`+`limits[]`、`usages.limit_7d/limit_5h` 比例、`data[]`），`used_ratio` 为 0–1 比例，`booster_wallet`（蛇形）/`boosterWallet`（驼峰）为加油包。个别新 key 无用量时服务端返回 `{}`，显示 "no usage data yet"。
- **DeepSeek**：`GET {base}/user/balance`，`Authorization: Bearer`，返回 `balance_infos[].total_balance`（字符串金额，按货币符号展示）。
- **MiniMax**：`GET {base}/v1/token_plan/remains`（国内 `api.minimaxi.com`、国际 `api.minimax.io`），`Authorization: Bearer`。响应 `model_remains[]` 中 `current_interval_*` 为 5 小时窗口、`current_weekly_*` 为周窗口；注意命名陷阱：`*_usage_count` 实际是**剩余**次数（已用 = `*_total_count` − 该值），`*_remaining_percent` 为 0–100 的剩余百分比，`*_status == 3` 表示该窗口不限量（显示 ∞），`end_time` / `weekly_end_time` 为 epoch 毫秒的重置时间。业务错误通过 `base_resp.status_code != 0` 返回（可能伴随 HTTP 200）。

接口适配逻辑移植自 [opencode-usage](https://github.com/dddcp/opencode-usage)（opencode 的侧边栏版本，npm 包 `opencode-coding-quota`），数据解析与其保持一致并共享同一套实测样本测试。

## License

MIT
