// ---- 类型声明 ----
declare global {
    interface Window {
        __SUPERSPLAT_CONFIG__?: {
            upload?: Partial<typeof UPLOAD_CONFIG>;
            aws?: Partial<typeof UPLOAD_CONFIG.awsConfig>;
            api?: Partial<typeof API_CONFIG>;
        };
    }
}

// ---- 默认值 ----
const DEFAULT_UPLOAD_CONFIG = {
    fileThreshold: 10 * 1024,  // 文件上限值 10 GB
    pieceSize: 16,  // 单个分片大小 16 MB
    preview: 0,   // 传0为只能以下载方式访问，传非0都是可以在线预览
    useTestEndpoint: false,
    mediaConfig: {
        mediaPreview: false  // 是否开启媒体预览
    },
    mediaPreview: false,
    awsConfig: {
        bucket: 'twin-model',
        ak: 'TX6OAEXN6Q9GO83J88TI',
        sk: 't4iN+BvuX4Bz69M0VxC7SjIPuq/6nOfhh/toMUgj',
        cdnHost: 'https://file-media.ke.com',
        endpoint: 'https://storage.lianjia.com/'
    },
    isPrivateBucket: true  // 是否私有桶
};

const DEFAULT_API_CONFIG = {
    apiHost: 'http://localhost:8080',
    previewHost: 'https://localhost:3001',
    previewPath: '/gaussian/share-viewer/'
};

// ---- 可变配置对象（可被 mergeWindowConfig 修改） ----
export const UPLOAD_CONFIG = {
    ...DEFAULT_UPLOAD_CONFIG,
    awsConfig: { ...DEFAULT_UPLOAD_CONFIG.awsConfig }
};

export const API_CONFIG = { ...DEFAULT_API_CONFIG };

// ---- 深度合并 ----
function deepMerge(target: Record<string, any>, source: Record<string, any>) {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!target[key]) target[key] = {};
            deepMerge(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
}

// ---- 合并 window 配置（在 main.ts 启动时最早调用） ----
export function mergeWindowConfig(): void {
    const ext = window.__SUPERSPLAT_CONFIG__;
    if (!ext) return;
    if (ext.upload) deepMerge(UPLOAD_CONFIG as any, ext.upload);
    if (ext.aws) deepMerge(UPLOAD_CONFIG.awsConfig as any, ext.aws);
    if (ext.api) deepMerge(API_CONFIG as any, ext.api);
}
