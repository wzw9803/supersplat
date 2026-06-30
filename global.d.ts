/// <reference types="@webgpu/types" />
/// <reference types="wicg-file-system-access" />

declare namespace NodeJS {
    interface ProcessEnv {
        BUILD_SW?: string;
    }
}
declare const process: {
    env: NodeJS.ProcessEnv;
};

interface FileSystemFileHandle {
    remove(): Promise<void>;
}

declare module '*.png' {
    const value: any;
    export default value;
}

declare module '*.svg' {
    const value: any;
    export default value;
}

declare module '*.scss' {
    const value: any;
    export default value;
}
