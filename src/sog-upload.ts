import KeUpload from '@ke/upload-sdk';
import { Splat } from './splat';
import { serializeSogToFiles, SogSettings } from './splat-serialize';
import { API_CONFIG, UPLOAD_CONFIG } from './utils/config';

type UploadFileState = {
    uuid: string;
    name: string;
    total: number;
    doneCount: number;
    status: 'pending' | 'uploading' | 'success' | 'error' | 'paused';
    errorMessage?: string;
    cdnUrl?: string;
};

type UploadProgress = {
    files: UploadFileState[];
    overallProgress: number; // 0-100
};

type ProgressCallback = (progress: UploadProgress) => void;

type PublishResult = {
    shareId: string;
    previewUrl: string;
};

/**
 * Sanitize project name for use in S3 key paths.
 * Replaces non-alphanumeric/non-CJK characters with underscores,
 * truncates to 64 characters.
 */
const sanitizeName = (name: string): string => {
    return name
        .replace(/[^a-zA-Z0-9一-鿿_-]/g, '_')
        .slice(0, 64);
};

/**
 * Determine the main file whose CDN URL will be sent to the API.
 */
const getMainFileName = (settings: SogSettings): string => {
    if (settings.sceneConfig) {
        return 'scene.json';
    }
    if (settings.sogFormat === 'bundled') {
        return 'output.sog';
    }
    return 'meta.json';
};

/**
 * Upload a SOG package to cloud storage and create a share record via the backend API.
 *
 * @param splats - The splat data to serialize and upload
 * @param sogSettings - SOG export settings (from ExportPopup)
 * @param projectName - User-provided project name
 * @param onProgress - Callback for per-file upload progress updates
 * @param cancelSignal - AbortSignal-like object; when its `aborted` property becomes true, cancels all uploads
 * @returns PublishResult with shareId and previewUrl
 */
const uploadSogPackage = async (
    splats: Splat[],
    sogSettings: SogSettings,
    projectName: string,
    onProgress?: ProgressCallback,
    cancelSignal?: { aborted: boolean }
): Promise<PublishResult> => {
    // 1. Serialize SOG data to in-memory files
    const files = await serializeSogToFiles(splats, sogSettings);

    if (!files || files.length === 0) {
        throw new Error('No files to upload');
    }

    // 2. Build upload path prefix
    const sanitized = sanitizeName(projectName);
    const basePath = `splat/${Date.now()}-${crypto.randomUUID()}/${sanitized}`;

    // 3. State tracking
    const fileStateMap = new Map<string, UploadFileState>();
    const fileUrlMap = new Map<string, string>(); // fileName -> CDN URL
    const uuidToFileName = new Map<string, string>();
    const pendingUuids: string[] = [];

    let cancelled = false;

    // Check cancel signal periodically
    if (cancelSignal) {
        const checkCancel = () => {
            if (cancelSignal.aborted && !cancelled) {
                cancelled = true;
                for (const uuid of pendingUuids) {
                    try {
                        KeUpload.cancel(uuid);
                    } catch (_) { /* ignore cancel errors */ }
                }
            }
        };
        // Poll cancel signal
        const interval = setInterval(checkCancel, 200);
        // Store for cleanup later
        (cancelSignal as any).__interval = interval;
    }

    // 4. Helper: notify progress
    const notifyProgress = () => {
        if (!onProgress) return;
        const fileStates = Array.from(fileStateMap.values());
        const total = fileStates.reduce((sum, f) => sum + (f.total || 1), 0);
        const done = fileStates.reduce((sum, f) => {
            if (f.status === 'success') return sum + (f.total || 1);
            if (f.status === 'error') return sum + (f.total || 1); // count as done for progress
            return sum + f.doneCount;
        }, 0);
        onProgress({
            files: fileStates,
            overallProgress: total > 0 ? Math.round((done / total) * 100) : 0
        });
    };

    // 5. Upload each file
    const uploadPromises: Promise<void>[] = [];

    for (const file of files) {
        const uploadPromise = new Promise<void>((resolve, reject) => {
            // Remove extension for fileName (SDK appends .{type} automatically)
            const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');

            // Build a File object from the in-memory data.
            // TS 6.x typing uses ArrayBufferLike for Uint8Array; casting around it.
            const fileObj = new File([file.data as unknown as BlobPart], file.name);

            KeUpload.load(
                fileObj,
                {
                    ...UPLOAD_CONFIG,
                    fileName: fileNameWithoutExt,
                    filePath: basePath
                },
                ({ error, data }) => {
                    // Handle cancel
                    if (cancelled) {
                        resolve();
                        return;
                    }

                    const uuid = data?.uuid || error?.uuid;

                    if (error) {
                        // All retries exhausted — mark file as error
                        const state = fileStateMap.get(uuid);
                        if (state) {
                            state.status = 'error';
                            state.errorMessage = error.errMsg || 'Upload failed';
                        }
                        notifyProgress();
                        reject(new Error(`Upload failed for ${file.name}: ${error.errMsg || 'unknown error'}`));
                        return;
                    }

                    if (!data) return;

                    // Upload complete — CDN URL available
                    if (data.url) {
                        if (uuid) {
                            const state = fileStateMap.get(uuid);
                            if (state) {
                                state.status = 'success';
                                state.cdnUrl = data.url;
                            }
                        }
                        fileUrlMap.set(file.name, data.url);
                        notifyProgress();
                        resolve();
                        return;
                    }

                    // Piece complete
                    if (data.status === 'done') {
                        if (uuid) {
                            const state = fileStateMap.get(uuid);
                            if (state) {
                                state.doneCount = (state.doneCount || 0) + 1;
                                state.status = 'uploading';
                            }
                        }
                        notifyProgress();
                        return;
                    }

                    // File initialized — first callback with metadata
                    if (typeof data.total !== 'undefined') {
                        const newState: UploadFileState = {
                            uuid: uuid || '',
                            name: data.name || file.name,
                            total: data.total,
                            doneCount: 0,
                            status: 'uploading'
                        };
                        fileStateMap.set(newState.uuid, newState);
                        uuidToFileName.set(newState.uuid, file.name);
                        pendingUuids.push(newState.uuid);
                        notifyProgress();
                        return;
                    }

                    // Pause / Resume
                    if (typeof data.isStop !== 'undefined') {
                        if (uuid) {
                            const state = fileStateMap.get(uuid);
                            if (state) {
                                state.status = data.isStop ? 'paused' : 'uploading';
                            }
                        }
                        notifyProgress();
                        return;
                    }
                }
            );
        });

        uploadPromises.push(uploadPromise);
    }

    // 6. Wait for all uploads
    try {
        await Promise.all(uploadPromises);
    } finally {
        // Clean up cancel polling
        if (cancelSignal && (cancelSignal as any).__interval) {
            clearInterval((cancelSignal as any).__interval);
        }
    }

    if (cancelled) {
        throw new Error('Upload cancelled');
    }

    // 7. Determine main file CDN URL
    const mainFileName = getMainFileName(sogSettings);
    const sceneUrl = fileUrlMap.get(mainFileName);

    if (!sceneUrl) {
        throw new Error(`Main file URL not found: ${mainFileName}. Available files: ${Array.from(fileUrlMap.keys()).join(', ')}`);
    }

    // 8. POST to backend API to create share record
    const apiUrl = `${API_CONFIG.apiHost}/api/scene-shares`;
    let shareId: string;
    let apiResult: any;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sceneUrl })
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        apiResult = await response.json();
        shareId = apiResult.shareId || apiResult.id || apiResult.data?.shareId || apiResult.data?.id;

        if (!shareId) {
            throw new Error(`API response missing shareId: ${JSON.stringify(apiResult)}`);
        }
    } catch (err) {
        // Files are already uploaded; API call failed
        throw new Error(`Failed to create share record: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 9. Construct preview URL (temporary — backend will provide this field later)
    const previewUrl = apiResult?.previewUrl
        || `${API_CONFIG.previewHost}${API_CONFIG.previewPath}?shareId=${shareId}`;

    return { shareId, previewUrl };
};

export { uploadSogPackage };
export type { UploadFileState, UploadProgress, ProgressCallback, PublishResult };
