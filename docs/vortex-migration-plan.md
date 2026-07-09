# supersplat 产物迁移到 Vortex 实施计划

## Context

将 supersplat 的 Rollup 构建产物（dist/）部署到 Vortex 的发布流程中，URL 路径为 `/gaussian/splat-editor/`。supersplat 保持独立 Rollup 构建，产物放入 `examples/gaussian/splat-editor/`，走 Vortex 标准的 Vite 构建管道，最终由 Fastify 直接托管。

## 核心流程

```
supersplat/ ──Rollup──> dist/ ──复制──> vortex/examples/gaussian/splat-editor/
                                              │
                              Vite 构建 (vite.examples.config.ts)
                              ├── buildInput 排除 splat-editor（不二次打包）
                              └── viteStaticCopy 原样透传 splat-editor/**
                                              │
                                              v
                                     dist/client/gaussian/splat-editor/
                                              │
                              Makefile: cp dist/client/* → dist/server/static/
                                              │
                                              v
                                     Fastify 托管（非 CDN，同域）
```

## 部署架构（非 CDN 模式）

从 Makefile 确认：

```
make pack (无 CDN_ENV)
  ├── Vite build examples           → dist/client/
  ├── 构建后端                       → dist/server/
  ├── cp dist/client/* → dist/server/static/   ← 前端由 Fastify 直接托管
  └── Docker COPY dist/server .
```

前后端同域，Fastify 同时处理 `/api/*` 和静态文件。**无跨域、无 CDN MIME/CORS 风险。**

## 已澄清的决策

| 决策项 | 结论 |
|--------|------|
| 迁移方式 | 产物迁移 |
| 构建 | supersplat 保持 Rollup 独立构建 |
| 产物位置 | `vortex/examples/gaussian/splat-editor/` |
| Vite 处理方式 | viteStaticCopy 原样透传 + buildInput 排除 |
| 最终部署 | Fastify 静态托管（非 CDN，同域） |
| URL 路径 | `/gaussian/splat-editor/` |
| BASE_HREF | 空字符串 |
| 配置暴露 | `window.__SUPERSPLAT_CONFIG__`，全部字段 |
| 配置注入 | index.html 内联 `<script>` 初始化结构 |
| API host | 默认 `http://localhost:8080`（独立开发），Vortex 环境通过 window 覆盖为 `''` |
| AK/SK | 源码保留默认值，可通过 window 覆盖 |
| Service Worker | 构建时 `BUILD_SW` 环境变量控制 |
| 发布流程 | sog-upload，PlayCanvas publish 隐藏 UI |
| 复制时机 | 手动 |

---

## 实施步骤

### 步骤 1：supersplat 源码改动

**改动文件**：`src/utils/config.ts`、`src/main.ts`、`src/index.html`、`rollup.config.mjs`、`src/ui/menu.ts`

#### 1.1 `src/utils/config.ts` — 配置暴露到 window

```typescript
declare global {
    interface Window {
        __SUPERSPLAT_CONFIG__?: {
            upload?: Partial<typeof UPLOAD_CONFIG>;
            aws?: Partial<typeof UPLOAD_CONFIG.awsConfig>;
            api?: Partial<typeof API_CONFIG>;
        };
    }
}

const DEFAULT_API_CONFIG = {
    apiHost: 'http://localhost:8080',  // 独立开发默认值，Vortex 环境通过 window 覆盖为 ''
    previewHost: 'https://localhost:3001',
    previewPath: '/gaussian/share-viewer/'
};

export const UPLOAD_CONFIG = { /* 当前值 */ awsConfig: { /* 当前值 */ } };
export const API_CONFIG = { ...DEFAULT_API_CONFIG };

function deepMerge(target: any, source: any) { /* 深度合并 */ }

export function mergeWindowConfig(): void {
    const ext = window.__SUPERSPLAT_CONFIG__;
    if (!ext) return;
    if (ext.upload) deepMerge(UPLOAD_CONFIG, ext.upload);
    if (ext.aws) deepMerge(UPLOAD_CONFIG.awsConfig, ext.aws);
    if (ext.api) deepMerge(API_CONFIG, ext.api);
}
```

✅ **已验证**：产物保留运行时属性访问，未被内联。

#### 1.2 `src/main.ts` — 启动时合并配置 + SW 条件化

```typescript
import { mergeWindowConfig } from './utils/config';

const main = async () => {
    mergeWindowConfig();  // 最早执行

    // ... 原有代码 ...

    // SW 注册由构建时 BUILD_SW 控制，生产构建时 if(false) 被 terser 移除
    if (process.env.BUILD_SW) {
        navigator.serviceWorker?.register('./sw.js');
    }
};
```

#### 1.3 `src/index.html` — 内联配置脚本

```html
<script>
  if (!window.__SUPERSPLAT_CONFIG__) window.__SUPERSPLAT_CONFIG__ = {};
  const c = window.__SUPERSPLAT_CONFIG__;
  if (!c.upload) c.upload = {};
  if (!c.api) c.api = {};
  if (!c.aws) c.aws = {};
  // 非本地环境自动使用相对路径（兜底逻辑）
  if (!c.api.apiHost && window.location.hostname !== 'localhost') {
    c.api.apiHost = '';
  }
</script>
<script type="module" src="./index.js"></script>
```

移除 `<base href="__BASE_HREF__">`。

**apiHost 机制**：
- 默认值：`config.ts` 中 `http://localhost:8080`（supersplat 独立开发用）
- 内联脚本兜底：非 localhost 域名自动设为 `''`（相对路径）
- 外部覆盖：在加载此 HTML 前设置 `window.__SUPERSPLAT_CONFIG__.api.apiHost` 可完全控制

#### 1.4 `rollup.config.mjs` — SW 构建条件化

```javascript
import replace from '@rollup/plugin-replace';

const BUILD_SW = process.env.BUILD_SW === 'true';

// application plugins 中添加：
replace({
    preventAssignment: true,
    'process.env.BUILD_SW': JSON.stringify(BUILD_SW),
}),

// SW 入口条件化
const serviceWorker = BUILD_SW ? [{ input: 'src/sw.ts', ... }] : [];
export default [application, ...serviceWorker];
```

#### 1.5 `src/ui/menu.ts` — 隐藏 PlayCanvas publish 菜单项

搜索 `publish` 关键词，注释相关菜单入口。

### 步骤 2：构建与复制

```bash
# 生产构建
BUILD_TYPE=release npm run build       # 无 SW

# 开发构建
BUILD_TYPE=release BUILD_SW=true npm run build  # 含 SW
```

**复制脚本：**

```bash
# copy-to-vortex.sh — 复制 dist/ 到 Vortex examples/
TARGET="/Users/wzw/Documents/work/vortex/packages/vortex/examples/gaussian/splat-editor"
rm -rf "$TARGET"/*
cp -r dist/* "$TARGET"/
```

```json
// package.json
{
    "scripts": {
        "copy-to-vortex": "bash copy-to-vortex.sh",
        "build:vortex": "BUILD_TYPE=release npm run build && npm run copy-to-vortex"
    }
}
```

### 步骤 3：Vortex 侧配置

**文件**：`packages/vortex/vite.examples.config.ts`

#### 3.1 buildInput 排除 splat-editor

```typescript
const buildInput = isBuilding
    ? glob.sync('examples/**/*.html', { cwd: __dirname }).reduce(
        (entries, file) => {
            const name = file.replace('examples/', '').replace('.html', '');
            if (name.startsWith('gaussian/splat-editor')) return entries;  // 排除
            entries[name] = resolve(__dirname, file);
            return entries;
        },
        {} as Record<string, string>
    )
    : { main: resolve(__dirname, 'examples/index.html') };
```

#### 3.2 viteStaticCopy 透传 splat-editor

```typescript
// 在现有 viteStaticCopy targets 数组中新增：
{
    src: 'gaussian/splat-editor/**/*',
    dest: 'gaussian/splat-editor',
},
```

### 步骤 4：验证

#### 4.0 Dev vs Prod 差异

| 维度 | 开发 | 生产 | 可 Dev 验证 |
|------|------|------|:---:|
| 文件服务 | Vite dev server (root=examples/) | Fastify (dist/server/static/) | ✅ 同为静态文件 |
| `/api/*` | Vite proxy → localhost:8080 | Fastify 直接处理 | ✅ 同域相对路径 |
| WASM/i18n | Vite 提供 | Fastify 提供 | ✅ |
| S3 上传 | 直连 | 同 | ✅ |
| 编辑器/导出 | 纯客户端 | 同 | ✅ |
| SW | 按 BUILD_SW | 不产出 | ✅ |

**Dev 和生产高度一致，Dev 验证通过即生产可信。**

#### 4.1 开发验证

```bash
cd supersplat && npm run build:vortex
cd /Users/wzw/Documents/work/vortex && pnpm --filter @vortex/engine dev
# 访问 https://localhost:3001/gaussian/splat-editor/
```

- [ ] 页面加载无 404
- [ ] WASM/i18n 加载
- [ ] PLY 加载、编辑、导出
- [ ] SOG Publish 流程
- [ ] window 配置覆盖
- [ ] SW 未注册

#### 4.2 生产构建验证

```bash
make pack                                     # Vortex 标准构建
cd supersplat && npm run copy-to-vortex:prod  # 或修改 Makefile 加入此步骤
# 验证 dist/server/static/gaussian/splat-editor/ 完整
```

---

## 风险点

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| ~~Rollup 内联优化~~ | ~~高~~ | ✅ 已验证不内联 |
| ~~API 跨域~~ | ~~高~~ | ✅ 非 CDN，同域 |
| ~~CDN MIME/CORS~~ | ~~中~~ | ✅ 非 CDN，Fastify 托管 |
| PlayCanvas 版本差异 | 低 | supersplat 独立 node_modules，不受影响 |
| 空 BASE_HREF | 低 | 现代浏览器支持 |
