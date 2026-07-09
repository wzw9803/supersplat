import KeUpload from '@ke/upload-sdk';
import { Splat } from './splat';
import { serializeSogToFiles, SogSettings } from './splat-serialize';
import { API_CONFIG, UPLOAD_CONFIG } from './utils/config';

type PublishPhase = 'prepare' | 'upload' | 'complete';

type UploadFileState = {
    uuid: string;
    name: string;         // original filename with extension, used for CDN URL construction
    total: number;
    doneCount: number;
    status: 'pending' | 'uploading' | 'success' | 'error' | 'paused';
    errorMessage?: string;
};

type PublishProgress = {
    phase: PublishPhase;
    prepareProgress?: number;   // 0-100
    uploadProgress?: number;    // 0-100 (aggregate of all files)
    files?: UploadFileState[];  // per-file state list
};

type ProgressCallback = (progress: PublishProgress) => void;

type PublishResult = {
    shareId: string;
    shareUrl: string;
    onlineShareUrl: string;
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
 * The upload proceeds through three phases:
 *   1. prepare  — serializes splat data to in-memory files (progress reported via
 *      serializeSogToFiles' progressCallback)
 *   2. upload   — uploads each file sequentially via KeUpload, with per-file retry support
 *      driven by `retrySignal`
 *   3. complete — POSTs the main file CDN URL to the backend API and returns the share URL
 *
 * CDN URLs are constructed manually from `UPLOAD_CONFIG.awsConfig.cdnHost` rather than
 * relying on `data.url` from the SDK callback (which returns a signed S3 direct-access URL).
 *
 * @param splats        - The splat data to serialize and upload.
 * @param sogSettings   - SOG export settings (from ExportPopup).
 * @param projectName   - User-provided project name.
 * @param projectDetail - User-provided project description.
 * @param owner         - User-provided creator name.
 * @param vrUrl         - User-provided VR URL.
 * @param onProgress    - Callback for phased progress updates.
 * @param cancelSignal - AbortSignal-like object; setting `aborted = true` cancels the
 *                       prepare phase. Upload/complete phases ignore it.
 * @param retrySignal  - Mutable ref object; set `fileName` to the name of a failed file
 *                       to trigger a retry via `KeUpload.retry()`.
 * @param prebuiltFiles - Optional pre-built files from cache, skipping serialization.
 * @returns PublishResult with shareId and shareUrl.
 */
const uploadSogPackage = async (
    splats: Splat[],
    sogSettings: SogSettings,
    projectName: string,
    projectDetail: string,
    owner: string,
    vrUrl: string,
    onProgress?: ProgressCallback,
    cancelSignal?: { aborted: boolean },
    retrySignal?: { fileName: string | null },
    prebuiltFiles?: Array<{ name: string; data: Uint8Array }>
): Promise<PublishResult> => {
    // ---- Phase 1: Prepare files ----
    let files: Array<{ name: string; data: Uint8Array }>;

    if (prebuiltFiles && prebuiltFiles.length > 0) {
        // Fast path: use cached source files, skip extractDataTable + writeSogInternal
        onProgress?.({ phase: 'prepare', prepareProgress: 100 });
        files = prebuiltFiles;
    } else {
        // Normal path: serialize from GSplatData
        onProgress?.({ phase: 'prepare', prepareProgress: 0 });

        // Progress callback that bridges serializeSogToFiles' progress to our PublishProgress
        const prepareProgressCb = (_phase: string, progress: number) => {
            onProgress?.({ phase: 'prepare', prepareProgress: progress });
        };

        try {
            files = await serializeSogToFiles(splats, sogSettings, cancelSignal, prepareProgressCb);
        } catch (err) {
            // Re-throw cancellation / serialization errors so the dialog can handle them
            throw err;
        }
    }

    if (!files || files.length === 0) {
        throw new Error('No files to upload');
    }

    // Build upload path prefix
    const sanitized = sanitizeName(projectName);
    const basePath = `splat/${Date.now()}-${crypto.randomUUID()}/${sanitized}`;

    onProgress?.({ phase: 'prepare', prepareProgress: 100 });

    // ---- Phase 2: Upload files ----
    const cdnHost = UPLOAD_CONFIG.awsConfig.cdnHost;
    const cdnBucket = UPLOAD_CONFIG.awsConfig.bucket;
    const fileStateMap = new Map<string, UploadFileState>();   // uuid -> state
    const fileUrlMap = new Map<string, string>();               // fileName -> CDN URL
    const uuidToFileName = new Map<string, string>();           // uuid -> fileName
    const fileNameToUuid = new Map<string, string>();           // fileName -> uuid

    // Completion is tracked via polling fileStateMap (not per-file promises),
    // so that individual files can be retried on error without rejecting an aggregate Promise.all.

    /**
     * Compute aggregate upload progress and notify.
     */
    const notifyUploadProgress = () => {
        if (!onProgress) return;
        const states = Array.from(fileStateMap.values());
        let totalPieces = 0;
        let donePieces = 0;
        for (const s of states) {
            const t = s.total || 1;
            totalPieces += t;
            if (s.status === 'success') {
                donePieces += t;
            } else if (s.status === 'error') {
                donePieces += 0; // errors contribute nothing — user must retry
            } else {
                donePieces += s.doneCount;
            }
        }
        const uploadProgress = totalPieces > 0 ? Math.round((donePieces / totalPieces) * 100) : 0;
        onProgress({ phase: 'upload', uploadProgress, files: states });
    };

    /**
     * Start the upload for a single file via KeUpload.load().
     * Callbacks update fileStateMap and notify progress.
     * Completion is tracked via the polling loop (not per-file promises).
     */
    const startFileUpload = (file: { name: string; data: Uint8Array }): void => {
        // Normalize filename: strip leading '/' from webp files (e.g. "/sh0.webp" → "sh0.webp")
        const fileName = file.name.replace(/^\//, '');
        const fileNameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
        const fileObj = new File([file.data as unknown as BlobPart], fileName);

        KeUpload.load(
            fileObj,
            {
                ...UPLOAD_CONFIG,
                fileName: fileNameWithoutExt,
                filePath: basePath
            },
            ({ error, data }) => {
                const uuid = data?.uuid || error?.uuid;

                if (error) {
                    const state = fileStateMap.get(uuid);
                    if (state) {
                        state.status = 'error';
                        state.errorMessage = error.errMsg || 'Upload failed';
                    }
                    notifyUploadProgress();
                    return;
                }

                if (!data) return;

                // Upload complete — construct CDN URL manually instead of using data.url
                if (data.url) {
                    // Debug: log SDK callback data and constructed CDN URL for verification
                    console.log(`[upload] SDK callback data for "${fileName}":`, JSON.stringify(data, null, 2));

                    if (uuid) {
                        const state = fileStateMap.get(uuid);
                        if (state) {
                            state.status = 'success';
                        }
                    }
                    // CDN URL: ${cdnHost}/${bucket}/${basePath}/${fileName}
                    // (fileName was already normalized at start of startFileUpload)
                    const cdnUrl = `${cdnHost}/${cdnBucket}/${basePath}/${fileName}`;
                    console.log(`[upload] SDK data.url: ${data.url}`);
                    console.log(`[upload] Constructed CDN URL for "${fileName}": ${cdnUrl}`);

                    fileUrlMap.set(fileName, cdnUrl);
                    notifyUploadProgress();
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
                    notifyUploadProgress();
                    return;
                }

                // File initialized — first callback with metadata
                if (typeof data.total !== 'undefined') {
                    const newState: UploadFileState = {
                        uuid: uuid || '',
                        name: fileName,
                        total: data.total,
                        doneCount: 0,
                        status: 'uploading'
                    };
                    fileStateMap.set(newState.uuid, newState);
                    uuidToFileName.set(newState.uuid, fileName);
                    fileNameToUuid.set(fileName, newState.uuid);
                    notifyUploadProgress();
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
                    notifyUploadProgress();
                    return;
                }
            }
        );
    };

    // Kick off uploads for all files
    for (const file of files) {
        startFileUpload(file);
    }

    // Re-architect: we don't use the per-file promises directly.
    // Instead we poll for completion and handle retries.

    /**
     * Check whether all files have reached 'success'.
     */
    const allFilesDone = (): boolean => {
        for (const file of files) {
            // Use cleaned name (strip leading '/') to match what startFileUpload stores
            const cleanName = file.name.replace(/^\//, '');
            const uuid = fileNameToUuid.get(cleanName);
            if (!uuid) return false;
            const state = fileStateMap.get(uuid);
            if (!state || state.status !== 'success') return false;
        }
        return true;
    };

    /**
     * Retry a failed file via KeUpload.retry().
     */
    const retryFile = (fileName: string) => {
        const uuid = fileNameToUuid.get(fileName);
        if (!uuid) return;
        const state = fileStateMap.get(uuid);
        if (!state || state.status !== 'error') return;

        // Reset state
        state.status = 'uploading';
        state.doneCount = 0;
        state.errorMessage = undefined;
        notifyUploadProgress();

        // Call SDK retry — the existing callback will handle further events
        try {
            KeUpload.retry(uuid);
        } catch (e) {
            state.status = 'error';
            state.errorMessage = `Retry failed: ${e instanceof Error ? e.message : String(e)}`;
            notifyUploadProgress();
        }
    };

    // ---- Wait for all uploads to complete (with retry support) ----
    await new Promise<void>((resolveAll, _rejectAll) => {
        let retryCheckInterval: ReturnType<typeof setInterval> | null = null;

        const checkDone = () => {
            // Check retry signal from the dialog
            if (retrySignal?.fileName) {
                const name = retrySignal.fileName;
                retrySignal.fileName = null; // consume the signal
                retryFile(name);
            }

            if (allFilesDone()) {
                if (retryCheckInterval) clearInterval(retryCheckInterval);
                resolveAll();
            }
        };

        // Poll for completion and retry signals
        retryCheckInterval = setInterval(checkDone, 200);
    });

    onProgress?.({ phase: 'upload', uploadProgress: 100, files: Array.from(fileStateMap.values()) });

    // ---- Phase 3: Complete — register with backend API ----
    onProgress?.({ phase: 'complete' });

    // Determine main file CDN URL
    const mainFileName = getMainFileName(sogSettings);
    const sceneUrl = fileUrlMap.get(mainFileName);

    if (!sceneUrl) {
        throw new Error(`Main file URL not found: ${mainFileName}. Available files: ${Array.from(fileUrlMap.keys()).join(', ')}`);
    }

    console.log(`[upload] Main file "${mainFileName}" CDN URL sent to API: ${sceneUrl}`);

    // POST to backend API to create share record
    const apiUrl = `${API_CONFIG.apiHost}/api/scene-shares`;
    let shareId: string;
    let apiResult: any;

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sceneUrl, projectName, projectDetail, owner, vrUrl })
        });

        if (!response.ok) {
            throw new Error(`API returned ${response.status}: ${response.statusText}`);
        }

        apiResult = await response.json();
        console.log(`[upload] API response:`, JSON.stringify(apiResult, null, 2));
        shareId = apiResult.shareId || apiResult.id || apiResult.data?.shareId || apiResult.data?.id;

        if (!shareId) {
            throw new Error(`API response missing shareId: ${JSON.stringify(apiResult)}`);
        }
    } catch (err) {
        throw new Error(`Failed to create share record: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Use shareUrl from backend response (no manual fallback)
    const shareUrl = apiResult?.shareUrl || '';
    const onlineShareUrl = apiResult?.onlineShareUrl || '';

    return { shareId, shareUrl, onlineShareUrl };
};

export { uploadSogPackage };
export type { UploadFileState, PublishProgress, ProgressCallback, PublishResult, PublishPhase };
