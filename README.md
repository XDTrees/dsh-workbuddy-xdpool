# DSH WorkBuddy XD Pool

[English](./README.en.md) | 中文

将 WorkBuddy 桌面 App 里登录过的**所有账号**自动并入一个 **DeepSeek Harness 模型池**：无需任何手动配置，你在 WorkBuddy 桌面登录的每个账号都会成为一个池成员；某个账号被限流（429）时，请求会自动切换到下一个可用账号，实现多账号自动容错轮换。

> 与单账号连接插件（如 dsh-workbuddy-connect）的区别：**XD Pool 把多账号当成常态**——它不挑账号、不做手动导入，而是把本机 WorkBuddy 桌面 App 的所有历史登录快照全部纳入一个共享池，用一个 `workbuddy-xdpool` provider 分组对外暴露，模型请求在池内自动 failover。

**插件配置卡片（设置 → 插件 → DSH WorkBuddy XD Pool）**

![WorkBuddy 池设置卡片：池健康状态、账号面板、积分包、合计](assets/settings-card.png)

**模型选择器（倍率直接拼进 model.name：DSH 0.1.2 composer 只读 name）**

![模型选择器每个模型名后显示倍率与促销标签](assets/model-picker.png)

## 功能

- **零配置开箱即用**：安装并启用后，WorkBuddy 桌面 App 里每个已登录账号都会在第一次被请求时自动发现、进入池中轮换。无需在插件里手动录入账号。

- **自动容错轮换**：池维护每个账号的 `429` 冷却状态。当某个账号触发限流进入冷却，后续请求会跳过它、落到下一个健康账号；冷却结束自动恢复。所有账号同时冷却时请求才暂停。

- **账号健康一目了然**：插件设置卡片显示池健康状态（N 账号 / X 冷却、当前会轮到哪个账号）、每个账号的令牌有效期与冷却倒计时。

- **剩余积分实时可见**：卡片按账号展示积分包（`套餐名 · 剩余 / 总量`）与合计剩余（大字绿色高亮），跟随上游实时刷新。

- **模型目录直接标注**：卡片列出当前在池内可用的模型，并标注积分倍率（如 `GLM-5.2 · x0.79`）、免费 / 限时免费 / 夜间折扣标签、图片输入能力与上下文窗口，倍率与标签跟随上游 `credits` / `tags` 实时更新。

- **两种人工动作**：卡片与 CLI 都提供「重新检测账号」（重新扫描桌面登录快照，把新登录的账号并入池）与「清除所有冷却」（立即解除全部 429 冷却）两个操作。

## 安装

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态；多账号 = 在桌面 App 里逐个登录/切换账号即可，每次登录都会被自动吸收进池）。已针对 DSH Desktop host `0.1.2` 兼容。

> 与 host 兼容 `0.1.1-rc.2` / `0.1.2` 系：设置节安装会按 host 能力自动选择 `settings.installSection`（0.1.2-rc.1+）或自由函数（更早）。

**方式一：从 GitHub 安装（推荐）**

```sh
# dsh 不在 PATH 时，用 node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js 代替 dsh
dsh plugin --profile desktop add github:aosi526/dsh-workbuddy-xdpool
```

**方式二：手动注册 bundle**

```sh
# 1) 安装包
dsh plugin --profile desktop add github:aosi526/dsh-workbuddy-xdpool

# 2) 注册 bundle：编辑 ~/.dsh/profiles/desktop/package.json，
#    在 "dsh" → "profile" → "bundles" 数组末尾追加 "dsh-workbuddy-xdpool"

# 3) 重启 DSH Desktop
```

**本地构建**（开发者）：

```sh
pnpm install
pnpm build        # 产出 lib/index.js + lib/bin.js + lib/client.js
pnpm typecheck    # 宿主侧
pnpm typecheck:client   # 客户端
```

> 注意：`pnpm install` 需用 pnpm 11（`npx pnpm@11`），必要时加 `--config.confirmModulesPurge=false --config.minimumReleaseAge=0`（pnpm 11 默认的 `minimumReleaseAge` 供应链年龄策略会拦截刚发布的 rc 包）。

装好后：模型选择器里会出现 **WorkBuddy XD Pool** 分组；设置 → 插件 → **DSH WorkBuddy XD Pool** 卡片可查看池健康、各账号令牌/积分/冷却，以及「重新检测账号」「清除所有冷却」按钮。

插件在 Web / TUI profile 下同样可用（`--profile web` / `--profile dsh-tui`）。

## 命令行

统一用 `dsh plugin --profile desktop exec dsh-workbuddy-xdpool <子命令>` 调用：

```sh
dsh plugin --profile desktop exec dsh-workbuddy-xdpool status    # 池账号数/冷却 + shim 状态（--credits 查积分、--json 机器可读、--rates 看倍率）
dsh plugin --profile desktop exec dsh-workbuddy-xdpool accounts  # 已发现账号（--json）
dsh plugin --profile desktop exec dsh-workbuddy-xdpool doctor    # 诊断发现/冷却/上游连通性
dsh plugin --profile desktop exec dsh-workbuddy-xdpool reset     # 立即清除所有 429 冷却
dsh plugin --profile desktop exec dsh-workbuddy-xdpool login     # 引导如何在桌面再加一个账号入池
```

## 池里怎么多账号？

池走**自动发现**：WorkBuddy 桌面 App 每次登录都会在本机留下一个带令牌的历史快照，XD Pool 扫描这些快照，把每个账号都吸收入池。因此多账号 = 在 WorkBuddy 桌面 App 里逐个登录 / 切换账号即可，之后点卡片「重新检测账号」或重启 DSH，新账号自动成为池成员。

若你想对桌面 App 之外的某个登录做**显式快照**（例如临时固定某个账号再验证），也可手动导入：

```sh
# 在 WorkBuddy 桌面 App 登录账号后（key 自己起名）：
dsh plugin --profile desktop exec dsh-workbuddy-xdpool import myKey
# 查看/删除已导入快照：
dsh plugin --profile desktop exec dsh-workbuddy-xdpool accounts
dsh plugin --profile desktop exec dsh-workbuddy-xdpool remove myKey
```

导入快照以 key 的 **MD5 前 8 位**命名落在 `~/.dsh/.workbuddy-xdpool/`（key 本身记在文件里），中文、带 `/`、带空格的 key 都安全；长期使用靠 refresh token 自动续期，失效则回到桌面重新登录后 `import <key> --force` 覆盖。

## 配置

池的有效配置经插件设置节（`settings.workbuddy-xdpool`）读取，模型设置页可改，改动即时生效：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `authFile` | 覆盖 WorkBuddy 桌面 auth 文件路径（跨平台探测异常时用，等价于 `WORKBUDDY_AUTH_FILE`） | 自动探测 |
| `cooldownMs` | 单账号 429 冷却时长（毫秒） | `60000` |

也可直接写在 `~/.dsh/settings.yaml`：

```yaml
workbuddy-xdpool:
  cooldownMs: 120000
```

## 架构

- **宿主侧**（`src/`，DSH 主进程内）：
  - `index.ts` —— 注册 `workbuddy-xdpool` provider、`workbuddy-xdpool` 设置节（`settings.installSection`）、3 条同源只读/动作路由、账号发现与模型目录播种。
  - `accounts.ts` —— `WorkBuddyAccountPool`：读本机 WorkBuddy 桌面 auth 快照、429 冷却、round-robin failover 与 token 刷新。
  - `catalog.ts` / `upstream.ts` —— 上游模型目录（含每模型积分倍率、免费/图片能力标签）与积分查询客户端。
  - `web-status.ts` / `status-paths.ts` —— 卡片消费的同源状态文档与路由。
  - `bin.ts` —— 上述 CLI。
- **客户端**（`src/client/`，浏览器卡片，经 `dsh.client` 由宿主加载）：折叠卡片外壳沿用宿主内置卡的 `dsm-plugin-card*` 样式语言（`--dsw-alias-*` 主题变量），内容用 `dsm-workbuddy-xdpool-*` 前缀，绝不污染宿主其它卡片；命名空间 `settings.workbuddy-xdpool`。
- **构建**：`tsdown` 产出 `lib/index.js`（宿主入口）+ `lib/bin.js`（CLI）+ `lib/client.js`（CJS，`window.__ModuleLoader__.load` 包裹的浏览器 bundle）。

## 已知限制

- **仅使用本机桌面 App 的账号**：池不会、也无法替你发起 WorkBuddy 的登录/扫码（token 由 WorkBuddy 桌面 App 自己的腾讯 SSO 登录铸造并设备绑定）。加池账号 = 在 WorkBuddy 桌面 App 里登录/切换，XD Pool 自动吸收。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整；若某账号 refresh token 失效，回到桌面重新登录即可。
- 若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请用 `WORKBUDDY_AUTH_FILE` 或配置节的 `authFile` 指定实际位置。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [jmglsi/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 设置节注册（`settings.installSection`）与 DSH 插件结构、客户端卡片加载机制的核心参照；本项目沿用其「宿主通过 installSection 挂卡片」的打通路径。
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）—— `dsm-plugin-card*` 卡片样式语言与 `--dsw-alias-*` 主题变量的参照实现。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）—— WorkBuddy 上游协议/积分接口的参照实现。

## 许可证

[MIT](./LICENSE)
