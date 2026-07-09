# SuperSplat - SOG Package 发布功能验证方案

## 验证边界

- ✅ **做**：TypeScript 编译检查、模块导入验证、构建产出检查
- ❌ **不做**：浏览器运行、UI 交互、文件上传、后端联调（由用户手动集成测试）

## 统一验证命令

每一步实施完成后，运行以下命令验证：

```bash
# TypeScript 类型检查（不产出文件）
npx tsc --noEmit

# 完整构建
npm run build
```

两个命令均无报错即为验证通过。

---

## 分步验证

### 步骤 0：`.npmrc` 配置（已完成）

**验证方法：**
```bash
cat .npmrc | grep "@ke:registry"
```
预期输出包含 `@ke:registry=https://artifactory.intra.ke.com/...`

---

### 步骤 1：安装 `@ke/upload-sdk` 依赖

**操作：** `package.json` 添加 `"@ke/upload-sdk": "2.0.0-beta8"`，执行 `npm install`

**验证方法：**

```bash
# 1. 确认包已安装
ls node_modules/@ke/upload-sdk/lib/index.js

# 2. 确认类型定义存在
ls node_modules/@ke/upload-sdk/lib/types/index.d.ts

# 3. 确认 package.json 中已添加
node -e "const p = require('./package.json'); console.log(p.devDependencies['@ke/upload-sdk'])"
```

**通过标准：** 三个命令均成功，版本号正确输出。

---

### 步骤 2：`src/utils/config.ts` 配置（已完成）

**验证方法：**

```bash
# TypeScript 编译检查该文件
npx tsc --noEmit src/utils/config.ts
```

**通过标准：** 无类型错误。`UPLOAD_CONFIG` 和 `API_CONFIG` 导出正确。

---

### 步骤 3：`src/splat-serialize.ts` — 添加 `serializeSogToFiles()`

**验证方法：**

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 确认函数导出
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('src/splat-serialize.ts', 'utf8');
  console.log('export 包含 serializeSogToFiles:', src.includes('serializeSogToFiles'));
  console.log('import MemoryFileSystem:', src.includes('MemoryFileSystem'));
"
```

**检查清单：**
- [ ] `MemoryFileSystem` 从 `@playcanvas/splat-transform` 正确导入
- [ ] `serializeSogToFiles` 函数已导出
- [ ] 返回类型为 `Promise<Array<{name: string, data: Uint8Array}>>`（或 `Map<string, Uint8Array>`）
- [ ] 不引入对 `ZipFileSystem` 的新依赖
- [ ] TypeScript 编译无错误

**通过标准：** `npx tsc --noEmit` 无报错。

---

### 步骤 4：`src/sog-upload.ts` — 新建上传编排模块

**验证方法：**

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 确认导入可解析
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('src/sog-upload.ts', 'utf8');
  console.log('@ke/upload-sdk:', src.includes('@ke/upload-sdk'));
  console.log('UPLOAD_CONFIG:', src.includes('UPLOAD_CONFIG'));
  console.log('API_CONFIG:', src.includes('API_CONFIG'));
  console.log('serializeSogToFiles:', src.includes('serializeSogToFiles'));
"
```

**检查清单：**
- [ ] `import KeUpload from '@ke/upload-sdk'` 可解析
- [ ] `import { UPLOAD_CONFIG, API_CONFIG } from './utils/config'` 可解析
- [ ] `import { serializeSogToFiles } from './splat-serialize'` 可解析
- [ ] `uploadSogPackage` 函数签名正确
- [ ] 回调处理完整（error / url / done / total / isStop 五个分支）
- [ ] `KeUpload.load()` 调用参数类型匹配 SDK 类型定义
- [ ] `fetch()` 调用 `POST /api/scene-shares` 语法正确
- [ ] TypeScript 编译无错误

**通过标准：** `npx tsc --noEmit` 无报错，所有导入模块可解析。

---

### 步骤 5：`src/ui/publish-sog-dialog.ts` — 新建发布对话框

**验证方法：**

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 确认 PCUI 组件使用正确
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('src/ui/publish-sog-dialog.ts', 'utf8');
  console.log('extends Container:', src.includes('extends Container'));
  console.log('TextInput:', src.includes('TextInput'));
  console.log('TextAreaInput:', src.includes('TextAreaInput'));
  console.log('Button:', src.includes('Button'));
  console.log('Container:', src.includes('new Container'));
  console.log('Label:', src.includes('Label'));
  console.log('localize:', src.includes('localize'));
"
```

**检查清单：**
- [ ] 继承 `Container`，遵循现有 dialog 模式
- [ ] 实现 `show(options): Promise<result>` 方法
- [ ] 实现 `hide()` 和 `destroy()` 方法
- [ ] PCUI 组件使用正确（TextInput、TextAreaInput、Button、Label、Container）
- [ ] `localize()` 用于所有 UI 文案
- [ ] 三种状态切换逻辑完整（输入 → 上传中 → 结果）
- [ ] 不引入运行时错误（如 `null` 引用）
- [ ] TypeScript 编译无错误

**通过标准：** `npx tsc --noEmit` 无报错。

---

### 步骤 6：`src/ui/export-popup.ts` — 添加发布按钮

**验证方法：**

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 确认关键变更点
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('src/ui/export-popup.ts', 'utf8');
  console.log('publishButton:', src.includes('publishButton'));
  console.log('sog-package:', src.includes('sog-package'));
  console.log('publish.sog.show:', src.includes('publish.sog.show'));
  console.log('assembleSogPackageOptions:', src.includes('assembleSogPackageOptions'));
"
```

**检查清单：**
- [ ] `publishButton` 在 footer 中创建
- [ ] `reset()` 中 `publishButton.hidden = exportType !== 'sog-package'`
- [ ] 点击 Publish 时调用 `events.invoke('publish.sog.show', options)`
- [ ] **不隐藏 ExportPopup**（modal-on-modal 模式）
- [ ] 不破坏现有 Cancel / Export 按钮功能
- [ ] TypeScript 编译无错误

**通过标准：** `npx tsc --noEmit` 无报错。

---

### 步骤 7：`src/ui/editor.ts` — 注册事件和组件

**验证方法：**

```bash
# 1. 编译检查
npx tsc --noEmit

# 2. 确认注册逻辑
node -e "
  const fs = require('fs');
  const src = fs.readFileSync('src/ui/editor.ts', 'utf8');
  console.log('PublishSogDialog:', src.includes('PublishSogDialog'));
  console.log('publishSogDialog:', src.includes('publishSogDialog'));
  console.log('publish.sog.show:', src.includes('publish.sog.show'));
  console.log('topContainer.append:', src.includes('topContainer'));
"
```

**检查清单：**
- [ ] `PublishSogDialog` 已导入
- [ ] `publishSogDialog` 实例化并 append 到 `topContainer`
- [ ] `events.function('publish.sog.show', ...)` 或 `events.on(...)` 已注册
- [ ] 不破坏现有 dialog 的注册和事件绑定
- [ ] TypeScript 编译无错误

**通过标准：** `npx tsc --noEmit` 无报错。

---

### 步骤 8：SCSS 样式

**验证方法：**

```bash
# 构建（SCSS 编译在 rollup 构建流程中）
npm run build

# 确认 CSS 产出中包含新样式
grep -q "publish-sog" dist/index.css && echo "样式已产出" || echo "样式缺失"
```

**通过标准：** `npm run build` 无 SCSS 编译错误，`dist/index.css` 中包含发布对话框相关样式。

---

### 步骤 9：i18n keys

**验证方法：**

```bash
# 确认 en.json 中包含所有新 key
node -e "
  const en = require('./static/locales/en.json');
  const keys = [
    'popup.export.publish',
    'popup.publish-sog.header',
    'popup.publish-sog.name',
    'popup.publish-sog.description',
    'popup.publish-sog.confirm',
    'popup.publish-sog.cancel-upload',
    'popup.publish-sog.close',
    'popup.publish-sog.uploading',
    'popup.publish-sog.preparing',
    'popup.publish-sog.success',
    'popup.publish-sog.preview-link',
    'popup.publish-sog.copy-link',
    'popup.publish-sog.retry',
    'popup.publish-sog.failed',
    'popup.publish-sog.copy-success',
    'popup.publish-sog.name-required'
  ];
  const missing = keys.filter(k => !en[k]);
  if (missing.length) {
    console.log('缺失 keys:', missing.join(', '));
  } else {
    console.log('所有 ' + keys.length + ' 个 key 已添加');
  }
"

# 验证 JSON 语法
node -e "JSON.parse(require('fs').readFileSync('static/locales/en.json', 'utf8')); console.log('JSON 语法正确')"
```

**通过标准：** 所有 key 存在，JSON 语法正确。

---

## 最终验证

全部步骤完成后，执行：

```bash
# 干净构建
npm run build
```

**最终通过标准：**
- [ ] `npm run build` 退出码为 0
- [ ] `dist/index.js` 生成成功
- [ ] `dist/index.css` 包含新样式
- [ ] 构建日志中无 TypeScript 错误、无 SCSS 错误、无模块解析错误

---

## 用户手动集成测试清单（参考）

以下测试由用户手动执行，此处仅列出供参考：

1. 启动 vortex-server 后端（`cd /Users/wzw/Documents/work/vortex/packages/vortex-server && npm run dev`）
2. 启动 SuperSplat 开发环境（`npm run develop`）
3. 加载 3D 场景 → 菜单 File → Export → SOG Package
4. 配置导出参数 → 点击 Publish 按钮
5. 输入项目名称 → 点击 Confirm Publish
6. 观察上传进度（每文件进度条 + 整体进度）
7. 验证上传完成后显示预览链接
8. 复制预览链接并在浏览器中打开
9. 测试取消上传
10. 测试上传失败重试（可断网模拟）


