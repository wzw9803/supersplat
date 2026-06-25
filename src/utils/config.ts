export const UPLOAD_CONFIG = {
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

export const API_CONFIG = {
    apiHost: 'http://localhost:8080',
    previewHost: 'https://localhost:3001',
    previewPath: '/gaussian/share-viewer/'
};
