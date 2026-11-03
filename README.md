# dsh-peak-hour-reminder

DeepSeek Harness 的本地 host 插件：在模型调用高峰时段提醒你，跨入高峰时暂停并询问是否继续，并在节假日数据过期时自动更新、清理旧年份。

## 它做什么

1. **高峰提醒**
   - 每个用户回合第一次调用模型前判断北京时间。
   - 只有高峰时才插入一条可见的 `⏰ 高峰时段提醒`；空闲时段完全静默。
   - 提醒包含当前时间、星期、所在窗口、距空闲还有多久；高峰期单价约为空闲的 2 倍。

2. **跨峰暂停**
   - 回合在空闲时段开始、执行中进入高峰时，在**下一个安全步骤边界**弹出询问卡：
     - 「继续」：继续执行后续步骤，并写入一条“用户选择继续”的 notice；
     - 「暂停」：结束本轮后续步骤，写入一条持久暂停 notice；已完成的消息、工具调用、工具结果都已保存，之后发送「继续」即可恢复。
   - 不会硬中断正在流式生成的回复或正在执行的工具，避免丢失半截输出/未完成工具结果。
   - 同一条消息触发的同一回合、同一个高峰窗口只问一次；跨到下一个高峰窗口会再问。

3. **节假日数据自动更新**
   - 数据文件记录 `coverageThrough`（已完整覆盖到哪一年）。
   - 当当前年份超过覆盖范围（例如只记录到 2028 年、当前已是 2029 年），或 Q4 预取下一年时，自动请求官方节假日数据。
   - 更新成功后删除过时年份（默认保留上一年，`retentionYears` 可调）。
   - 更新失败/数据源尚未发布时保留旧数据，按“工作日规则”继续判断，并在提醒里注明“数据未更新”。

## 高峰规则

以 DeepSeek 官方 API 峰谷定价为准（2026-11-03 核对）：

| 时间段（北京时间） | 状态 |
| --- | --- |
| 周一至周五 09:00–12:00、14:00–18:00 | 高峰 |
| 周一至周五其余时间 | 空闲 |
| 周六、周日全天 | 空闲 |
| 中国法定节假日全天 | 空闲 |

换算自官方规则：高峰为 UTC 01:00–04:00、06:00–10:00，周一至周五，排除中国法定节假日。来源：

- [DeepSeek API Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [国务院办公厅关于2026年部分节假日安排的通知](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)

内置基线包含 2026 年完整假期和 2027 年元旦（2027 其余假期待官方通知，由自动更新或 `extraHolidays` 补全）。

## 安装

### 方式一：从 GitHub 安装（普通 web profile）

```sh
dsh plugin --profile web add github:ggghhh-11/dsh-peak-hour-reminder
```

然后重启 `dsh web`。插件包内的 `cordis.patch.yml` 会自动注册 host 行，**不需要**手动改 profile 补丁。

### 方式二：DSH Desktop（desktop profile）

DSH Desktop 的 `desktop` profile 由应用独占管理，CLI 的 `dsh plugin --profile desktop ...` 会被拒绝。可以：

- 在应用内 **设置 → 插件** 里从本地路径安装；或
- 手动把本仓库放到本地（例如 `C:\plugins\dsh-peak-hour-reminder`），在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 中：
  ```json
  "dependencies": {
    "dsh-peak-hour-reminder": "link:C:/plugins/dsh-peak-hour-reminder"
  }
  ```
  并在 `dsh.profile.bundles` 中加入 `"dsh-peak-hour-reminder"`，然后在 profile 目录执行 `pnpm install`，重启 DSH Desktop。

> 插件包内的 `cordis.patch.yml` 会自动 insert 一行；**不要**再往 profile 的 `cordis.patch.yml` 手动 insert 同一个 id，否则 duplicate loader entry id 会导致启动失败。

## 配置

在 profile 的 `cordis.patch.yml` 用 id 覆盖（不是 insert）：

```yaml
- id: dsh-peak-hour-reminder
  config:
    timeZone: Asia/Shanghai
    peakWindows:
      - { start: '09:00', end: '12:00' }
      - { start: '14:00', end: '18:00' }
    weekendOffPeak: true
    pauseOnPeakCrossing: true
    showPriceHint: true
    updateEnabled: true
    updateUrls:
      - https://timor.tech/api/holiday/year/{year}
    retentionYears: 1
```

常用项：

- `enabled`：总开关，默认 `true`。
- `timeZone`：默认 `Asia/Shanghai`；DeepSeek 峰谷按北京时间。
- `peakWindows`：高峰窗口，支持跨午夜（如 `22:00–02:00`）。
- `weekendOffPeak`：周末全天空闲，默认 `true`。
- `extraHolidays`：额外假日 `YYYY-MM-DD` 数组（补官方尚未发布的假期、公司假日）。
- `pauseOnPeakCrossing`：跨峰暂停询问，默认 `true`。
- `updateEnabled`：是否联网更新节假日，默认 `true`；关闭后完全离线。
- `updateUrls`：节假日 JSON 模板，必须包含 `{year}`；默认 timor.tech。
- `dataDir`：数据目录，默认 `$DSH_HOME/peak-hour-reminder`（通常是 `%USERPROFILE%\.dsh\peak-hour-reminder`）；一般不需要改。
- `retentionYears`：保留多少个过去年份，默认 `1`（保留上一年）。
- `debugNow` / `debugForceUpdate` / `debugForcePause`：测试钩子，默认关闭。

配置非法时回退默认值并打印 warning，不会让插件加载失败拖垮 DSH。

## 节假日数据文件

默认位置：`%USERPROFILE%\.dsh\peak-hour-reminder\holidays.json`（macOS/Linux 为 `~/.dsh/peak-hour-reminder/holidays.json`）。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-03T12:00:00.000Z",
  "coverageThrough": 2026,
  "years": {
    "2026": { "status": "complete", "source": "https://...", "fetchedAt": "...", "holidays": ["2026-01-01"] },
    "2027": { "status": "partial", "source": "builtin:known-new-year", "fetchedAt": "...", "holidays": ["2027-01-01"] }
  },
  "lastAttemptAt": "...",
  "nextCheckAt": "...",
  "lastError": null
}
```

- `complete`：整年数据；`partial`：只知部分；`unknown`：尚未发布。
- `coverageThrough` 是所有 `complete` 年份的最大值。
- 更新成功后：合并新数据、重算 coverage、删除过时年份、原子写回。
- 更新失败/未发布：保留旧数据，`lastError` 记录原因，`nextCheckAt` 控制重试。
- 数据文件损坏：备份为 `holidays.json.corrupt-<时间戳>`，回退内置基线。

更新源响应格式（timor.tech）：

```json
{ "code": 0, "holiday": { "01-01": { "holiday": true, "date": "2026-01-01" } } }
```

只取 `holiday: true` 的日期；`holiday: false` 的补班日不影响峰谷定价（周末仍然空闲）。

## 测试

```powershell
node scripts/run-tests.mjs
```

> 在 Windows 沙箱下，`node --test` 会为每个测试文件 spawn 子进程并因 piped stdio 被拒绝（EPERM）。`scripts/run-tests.mjs` 在单进程内导入所有测试文件，效果相同且可在沙箱中运行。

真实网络冒烟检查：

```powershell
node scripts/net-check.mjs
```

期望输出 2026 年 `status: "complete"`、`holidays: 33`；若网络不可达会打印错误并保留旧数据。

## 验证跨峰暂停

当前时间若不是高峰，可用临时配置强制一个覆盖当前时间的窗口：

```yaml
- id: dsh-peak-hour-reminder
  config:
    peakWindows:
      - { start: '00:00', end: '23:59' }
    debugForcePause: true
```

`debugForcePause` 会强制把回合视为“从空闲开始”，从而在第 2 步触发暂停询问；验证完请删除该项并恢复默认窗口。

## 已知限制

- 暂停只发生在 pre-step 边界：进行中的流式生成或工具调用会先完成。不会硬中断，以免丢失半截输出/未完成工具结果。
- 不在 step 1 暂停：reject 会丢弃 claimed 用户输入；如果用户在 08:59 发消息、09:00 才进入 pre-step，该回合按“高峰开始”处理（提醒并继续）。
- 单步回合（普通问答、无工具调用）没有后续步骤可暂停，工作已完成。
- subagent 不提醒、不暂停；子代理已在执行的工作允许完成，主回合在下一个边界暂停。
- 2027 年除元旦外的假期需等官方通知；在数据更新前会按工作日规则判断，并在提醒中注明。
- 若宿主没有 user-questions answerer（如无 Web UI 的 headless 环境），跨峰询问会降级为“暂停 + 持久 notice”。

## 卸载

1. 从 profile `package.json` 移除 `dsh-peak-hour-reminder` 依赖和 `dsh.profile.bundles` 中的条目。
2. 删除 `node_modules/dsh-peak-hour-reminder` 链接/安装目录。
3. 重启 DSH。
4. 可选：删除源码目录和 `%USERPROFILE%\.dsh\peak-hour-reminder` 数据目录。

临时禁用（不卸载）：在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: dsh-peak-hour-reminder
  disabled: true
```

## 隐私

插件唯一的出站请求是配置的节假日 JSON URL（默认 `https://timor.tech/api/holiday/year/{year}`）。不发送会话内容、不发送用户标识。`updateEnabled: false` 可完全关闭联网。

## 许可

MIT
