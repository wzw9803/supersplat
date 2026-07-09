# 发布功能改进实现计划

## Context

SOG Package 发布功能初版已完成，但存在功能性和交互体验问题。本文档根据 `docs/todo2.md` 的反馈制定改进计划。

## 用户确认的关键决策

| 决策点 | 结论 |
|--------|------|
| CDN URL 拼接格式 | `${cdnHost}/${filePath}/${原始文件名含扩展名}`（如 output.sog、scene.json） |
| 准备阶段取消后行为 | 直接关闭弹窗 |
| 上传失败处理 | 允许单个文件重试（KeUpload.retry），所有文件成功后才进入获取链接阶段 |
| 发布成功后关闭 | 只关闭发布弹窗，导出弹窗保持打开 |
| 取消按钮规则 | 仅在准备文件阶段可点击，上传/获取链接阶段禁用 |
| 集成测试 | 由用户负责，开发只需确保编译通过 |

---

## 整体改动范围

| 文件 | 改动类型 |
|------|----------|
| `src/splat-serialize.ts` | 修改 — 支持取消信号、自定义进度回调 |
| `src/sog-upload.ts` | 重构 — 分阶段进度、CDN 拼接、shareUrl、单文件重试 |
| `src/ui/publish-sog-dialog.ts` | 重写 — 三阶段 checklist UI、文件重试按钮 |
| `src/ui/scss/publish-sog-dialog.scss` | 重写 — 新 UI 样式 |
| `static/locales/en.json` | 修改 — 新增/调整 i18n keys |
| `static/locales/zh-CN.json` | 修改 — 新增中文翻译 |

---

## 1. 消除准备阶段的多余弹窗 + 支持取消信号 + 解决卡顿

**文件**: `src/splat-serialize.ts`

**改动**:
- `serializeSogToFiles` 新增可选参数：
  - `cancelSignal?: { aborted: boolean }` — 取消信号
  - `progressCallback?: (phase: string, progress: number) => void` — 自定义进度回调，替代全局 events
- 当 `progressCallback` 提供时，`createProgressRenderer` 使用轻量 Renderer，只调用 callback，**不使用** 传入的 `events`（从而不触发 `progressStart`/`progressUpdate`/`progressEnd`，不显示全局进度弹窗）
- 在 `extractDataTable` 调用前加 `await new Promise(r => requestAnimationFrame(r))` 让浏览器先渲染 UI，避免按钮卡顿
- 在 `extractDataTable` 返回后、`writeSogInternal` 调用前后检查 `cancelSignal?.aborted`，为 true 则 throw `new Error('Cancelled')`，并在 throw 前调用 `splatTransformLogger.unwindAll(true)`

**重要**：不修改 `serializeSog`（导出 SOG 包的函数），只修改 `serializeSogToFiles`。原有导出流程不受影响。

---

## 2. 上传模块重构

**文件**: `src/sog-upload.ts`

### 2.1 类型定义修改

```typescript
type PublishPhase = 'prepare' | 'upload' | 'complete';

type UploadFileState = {
    uuid: string;
    name: string;         // 原始文件名（含扩展名，用于 CDN 拼接）
    total: number;
    doneCount: number;
    status: 'pending' | 'uploading' | 'success' | 'error' | 'paused';
    errorMessage?: string;
};

type PublishProgress = {
    phase: PublishPhase;
    prepareProgress?: number;   // 0-100
    uploadProgress?: number;    // 0-100（所有文件的总进度）
    files?: UploadFileState[];  // 当前文件状态列表
};

type PublishResult = {
    shareId: string;
    shareUrl: string;   // 改：previewUrl → shareUrl
};
```

### 2.2 uploadSogPackage 函数签名

```typescript
const uploadSogPackage = async (
    splats: Splat[],
    sogSettings: SogSettings,
    projectName: string,
    onProgress?: (progress: PublishProgress) => void,
    cancelSignal?: { aborted: boolean },
    retrySignal?: { fileName: string | null }  // 新增：外部触发重试
): Promise<PublishResult>
```

### 2.3 分阶段流程

**阶段 1 — prepare**：
1. `onProgress({ phase: 'prepare', prepareProgress: 0 })`
2. 调用 `serializeSogToFiles(splats, sogSettings, cancelSignal, progressCallback)`
   - progressCallback 实时转换并上报 `prepareProgress`
3. 构建 S3 `basePath`：`splat/{Date.now()}-{crypto.randomUUID()}/{sanitize(projectName)}`
4. `onProgress({ phase: 'prepare', prepareProgress: 100 })`

**阶段 2 — upload**：
1. 为每个文件调用 `KeUpload.load(fileObj, config, callback)`
2. 不阻塞等待 Promise.all，而是进入「等待所有文件完成」的状态
3. 每个文件的上传回调逻辑：
   - 初始化（`typeof data.total !== 'undefined'`）：创建 `UploadFileState`，记录原始文件名
   - 分片完成（`data.status === 'done'`）：更新 doneCount
   - 全部完成（`data.url`）：标记 success，**不使用 data.url**，改为记录 cdnUrl = `${cdnHost}/${basePath}/${file.name}`
   - 失败（`error`）：标记 error，记录 errorMessage，**不 reject**，等待外部触发重试
4. 进度计算：遍历所有 `UploadFileState`，`total * statusWeight` 聚合
5. `onProgress({ phase: 'upload', uploadProgress, files })`

**阶段 3 — complete**：
1. 所有文件 success 后，`onProgress({ phase: 'complete' })`
2. 确定主文件 CDN URL（逻辑不变：sceneConfig → scene.json，bundled → output.sog，否则 meta.json）
3. POST `${API_CONFIG.apiHost}/api/scene-shares`，body: `{ sceneUrl: cdnUrl }`
4. 从响应中取 `shareUrl` 字段（`apiResult.shareUrl`），不再手动构造 fallback
5. 返回 `{ shareId, shareUrl }`

### 2.4 CDN URL 拼接

```typescript
// 在每个文件上传完成后（data.url 分支）
const cdnUrl = `${UPLOAD_CONFIG.awsConfig.cdnHost}/${basePath}/${file.name}`;
// 例：https://file-media.ke.com/splat/1719345600000-uuid/my_project/output.sog
fileUrlMap.set(file.name, cdnUrl);
```

- `file.name` 是原始文件名（含扩展名），在创建 `UploadFileState` 时记录
- 不使用 SDK 回调的 `data.url`

### 2.5 单文件重试机制

```typescript
// retrySignal 是一个可变引用对象
// 外部（dialog）设置 retrySignal.fileName = 'output.sog' 来触发重试
```

实现逻辑：
1. 上传循环不依赖 `Promise.all`，而是使用一个「等待所有文件成功」的 Promise
2. 当某个文件 error 时，该文件的上传 Promise 不 reject，而是保持 pending
3. 外部通过设置 `retrySignal.fileName` 触发重试：
   - 找到对应 uuid
   - 重置 `UploadFileState.status = 'uploading'`、`doneCount = 0`
   - 调用 `KeUpload.retry(uuid)`
   - SDK 重新触发 callback，流程同上
   - `retrySignal.fileName` 重置为 null（表示已处理）
4. 所有文件 success 后，上传阶段完成，进入 complete 阶段

轮询方式：使用 setInterval(200ms) 检查 retrySignal 和所有文件状态。

### 2.6 取消逻辑

- `cancelSignal` 传给 `serializeSogToFiles`（prepare 阶段可取消）
- upload 阶段：cancelSignal 轮询保留但取消按钮已禁用（prepare 阶段之后不再检查 cancelSignal）
- 准备阶段检测到取消后 throw `new Error('Upload cancelled by user')`

---

## 3. 发布对话框 UI 重写

**文件**: `src/ui/publish-sog-dialog.ts`

### 3.1 状态枚举

```typescript
enum PublishPhase {
    INPUT = 'input',
    PREPARE = 'prepare',
    UPLOAD = 'upload',
    COMPLETE = 'complete',
    RESULT = 'result'
}
```

### 3.2 阶段 UI 组件

新增实例变量：

| 变量 | 类型 | 用途 |
|------|------|------|
| `_phaseContainer` | Container | 三阶段 checklist 容器 |
| `_prepareRow` | Container | 准备文件阶段行 |
| `_prepareIcon` | Label | 阶段图标（○/Spinner/✓） |
| `_prepareProgress` | Progress | PCUI 进度条 |
| `_prepareStatus` | Label | 状态文字 |
| `_uploadRow` | Container | 上传阶段行 |
| `_uploadIcon` | Label | 阶段图标 |
| `_uploadProgress` | Progress | PCUI 进度条 |
| `_uploadStatus` | Label | 状态文字 |
| `_toggleButton` | Button | 展开/折叠文件详情 |
| `_fileListContainer` | Container | 可折叠文件列表 |
| `_completeRow` | Container | 获取分享链接阶段行 |
| `_completeIcon` | Label | 阶段图标 |
| `_completeProgress` | Progress | PCUI 进度条 |
| `_completeStatus` | Label | 状态文字 |
| `_resultLabel` | Label | "发布成功！" |
| `_linkInput` | TextInput | 只读，显示分享链接 |
| `_closeButton` | Button | 关闭（原取消按钮改名） |
| `_copyButton` | Button | 复制链接 |

### 3.3 三阶段 Checklist UI 布局

```
Container#phase-list
  Container.phase-row (准备文件)
    Spinner/Label(图标)   Label("准备文件")   Progress(value)   Label(status)
  Container.phase-row (上传文件)
    Spinner/Label(图标)   Label("上传文件")   Progress(value)   Label(status)   Button(▶/▼)
    Container#file-list (hidden 默认，展开后显示)
      Container.file-row (每文件)
        Label(fileName)   Label(status)   [Button("重试")]  ← 仅 error 时显示
  Container.phase-row (获取分享链接)
    Spinner/Label(图标)   Label("获取分享链接")   Progress(value)   Label(status)
```

### 3.4 阶段状态图标映射

| 阶段状态 | 图标 | 样式 |
|----------|------|------|
| 等待中（未轮到） | `○` 空心圆 | 灰色 |
| 进行中 | PCUI `Spinner` | 默认 |
| 已完成 | `✓` | 绿色 `#4caf50` |
| 失败 | `✗` | 红色 `#f44336`（仅上传阶段可能） |

### 3.5 展开/折叠文件详情

- 上传阶段完成后或进行中均可展开
- 展开按钮：`▶` 展开 → `▼` 折叠
- 切换 `_fileListContainer.hidden`
- 折叠不丢失文件列表 DOM（只是隐藏）

### 3.6 每文件重试按钮

- 仅当文件 `status === 'error'` 时在对应行末尾显示 `Button("重试")`
- 点击后：
  1. 设置 `retrySignal.fileName = 文件名`（触发 sog-upload.ts 中的重试逻辑）
  2. 更新该行的 UI 状态为 uploading
- 重试过程中文件行状态文字更新为上传进度

### 3.7 按钮状态流转

| 状态 | 可见按钮 | 说明 |
|------|---------|------|
| INPUT | Cancel, Confirm Publish | 当前行为不变 |
| PREPARE | Cancel（启用） | 点击取消 → 设置 cancelSignal.aborted = true → 关闭弹窗 |
| UPLOAD | Cancel（禁用） | 取消按钮禁用 |
| COMPLETE | Cancel（禁用） | 取消按钮禁用 |
| RESULT | Close, Copy | 关闭返回结果，发布弹窗关闭，导出弹窗保持打开 |

### 3.8 结果页

```
Label("发布成功！")
Label("分享链接：")
TextInput(readOnly, value=shareUrl)   ← 用户可直接选中复制
Button("复制链接")                    ← navigator.clipboard.writeText
Button("关闭")                        ← resolve(publishResult)，关闭弹窗
```

### 3.9 卡顿问题解决

- 确认发布 → setState(PREPARE) → `requestAnimationFrame` → 开始序列化
- UI 先渲染 checklist，用户立即看到反馈，不会感觉按钮卡住
- 序列化进度通过 callback → `_prepareProgress.value` 实时更新

### 3.10 取消流程

```
准备阶段点取消
  → cancelSignal.aborted = true
  → serializeSogToFiles 检测到后 throw 'Cancelled'
  → uploadSogPackage catch 到取消异常
  → dialog 的 onConfirm catch 到异常
  → resolve(null)，关闭弹窗
```

---

## 4. SCSS 样式

**文件**: `src/ui/scss/publish-sog-dialog.scss`

完全重写，主要样式类：

| 类名 | 说明 |
|------|------|
| `.phase-list` | checklist 容器，flex-column，gap: 12px |
| `.phase-row` | 每行 flex 布局，align-items: center，gap: 8px |
| `.phase-icon` | 阶段图标，font-size: 16px，width: 20px |
| `.phase-icon-done` | 绿色 `#4caf50` |
| `.phase-icon-error` | 红色 `#f44336` |
| `.phase-label` | 阶段名称，min-width: 100px |
| `.phase-progress` | PCUI Progress 的样式定制，flex: 1 |
| `.phase-status` | 状态文字，min-width: 60px，text-align: right |
| `.file-list` | 文件详情容器，margin-left: 28px，max-height: 200px，overflow-y: auto |
| `.file-row` | 文件行 flex 布局，padding: 4px 0 |
| `.file-name` | 文件名，flex: 1，text-overflow: ellipsis |
| `.file-status` | 文件状态，min-width: 80px |
| `.file-status-success` | 绿色 |
| `.file-status-error` | 红色 |
| `.file-status-uploading` | 默认色 |
| `.retry-button` | 重试按钮，小尺寸 |
| `.result-container` | 结果页，flex-column，align-items: center，gap: 12px |
| `.share-link-input` | 只读链接输入框，width: 100%，monospace font |

复用现有样式：
- `#dialog`、`#header`、`#content`、`#footer`：来自 `settings-dialog.scss`
- `#publish-sog-dialog`：根容器 ID，作为样式作用域

---

## 5. i18n

**文件**: `static/locales/en.json`, `static/locales/zh-CN.json`

### 新增 keys

```json
{
  "popup.publish-sog.phase-prepare": "Prepare files",
  "popup.publish-sog.phase-upload": "Upload files",
  "popup.publish-sog.phase-complete": "Get share link",
  "popup.publish-sog.status-waiting": "Waiting...",
  "popup.publish-sog.status-done": "Done",
  "popup.publish-sog.status-preparing": "Preparing...",
  "popup.publish-sog.status-uploading": "Uploading...",
  "popup.publish-sog.status-completing": "Creating share...",
  "popup.publish-sog.retry": "Retry",
  "popup.publish-sog.share-link": "Share Link",
  "popup.publish-sog.cancelled": "Cancelled"
}
```

### 修改现有 keys

| 原 key | 新值 |
|--------|------|
| `popup.publish-sog.success` | `"Publish Successful!"`（加感叹号） |
| `popup.publish-sog.preview-link` | `"Share Link"` |
| `popup.publish-sog.close` | `"Close"`（保持不变） |

### 移除 keys

- `popup.publish-sog.cancel-upload`（不再需要，统一用 `popup.cancel`）
- `popup.publish-sog.uploading`（被分阶段状态描述替代）
- `popup.publish-sog.preparing`（被分阶段状态描述替代）

中文翻译同理。

---

## 6. 实施顺序

| 步骤 | 文件 | 关键内容 |
|------|------|----------|
| 1 | `splat-serialize.ts` | 添加 cancelSignal + progressCallback 参数；suppress 全局弹窗；添加取消检测点；添加 requestAnimationFrame yield |
| 2 | `sog-upload.ts` | 重构类型定义；分阶段进度上报；CDN URL 手动拼接；shareUrl 字段；单文件重试机制；取消逻辑 |
| 3 | `publish-sog-dialog.ts` | 重写为三阶段 checklist UI；文件重试按钮；PCUI Progress/Spinner 组件；阶段状态管理 |
| 4 | `publish-sog-dialog.scss` | 重写为新 UI 样式 |
| 5 | `en.json`, `zh-CN.json` | 新增/修改 i18n keys |
| 6 | 编译验证 | `npm run dev` 确保编译通过 |

---

## 7. 验证方案（开发侧）

1. 执行 `npm run dev`（或项目的构建命令），确保编译无 Error
2. 检查 TypeScript 类型检查通过
3. 用户负责集成测试（启动后端、完整发布流程测试）
请根据 docs/publish-plan.md 中的实施计划，按步骤顺序开发 SOG Package 发布功能。

