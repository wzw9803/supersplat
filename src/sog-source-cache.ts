import { MemoryFileSystem, ZipFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';
import { BlobReadSource } from './io/read/file-systems';
import { Splat } from './splat';
import { State } from './splat-state';
import { SerializeSettings } from './splat-serialize';

type SogSourceFormat = 'bundled' | 'unbundled';

interface SogSourceCacheEntry {
    format: SogSourceFormat;
    // bundled: single File (.sog ZIP file)
    // unbundled: multiple Files (meta.json, sh0.webp, sh1.webp, ...)
    files: Array<{ name: string; data: File | Blob }>;
}

// Module-level cache: splat.uid → cache entry
const cache = new Map<number, SogSourceCacheEntry>();

// Data fingerprint captured at import time, used to detect changes that require re-serialization.
interface SplatFingerprint {
    transformPaletteVersion: number;
    localPosition: [number, number, number];
    localRotation: [number, number, number, number];
    localScale: [number, number, number];
    tintClr: [number, number, number];
    temperature: number;
    saturation: number;
    brightness: number;
    blackPoint: number;
    whitePoint: number;
    transparency: number;
}

const fingerprintCache = new Map<number, SplatFingerprint>();

const cacheSourceFile = (
    splat: Splat,
    files: Array<{ name: string; data: File | Blob }>,
    format: SogSourceFormat
): void => {
    cache.set(splat.uid, { format, files });
};

const getSourceCache = (splat: Splat): SogSourceCacheEntry | undefined => {
    return cache.get(splat.uid);
};

const evictSplat = (splat: Splat): void => {
    cache.delete(splat.uid);
};

const clearSourceCache = (): void => {
    cache.clear();
    fingerprintCache.clear();
};

const evictFingerprint = (splat: Splat): void => {
    fingerprintCache.delete(splat.uid);
};

/**
 * Capture the current data state of a splat as a fingerprint.
 * Called at import time after caching source files.
 */
const captureFingerprint = (splat: Splat): void => {
    const pos = splat.entity.getLocalPosition();
    const rot = splat.entity.getLocalRotation();
    const scl = splat.entity.getLocalScale();
    fingerprintCache.set(splat.uid, {
        transformPaletteVersion: splat._transformPaletteVersion ?? 0,
        localPosition: [pos.x, pos.y, pos.z],
        localRotation: [rot.x, rot.y, rot.z, rot.w],
        localScale: [scl.x, scl.y, scl.z],
        tintClr: [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b],
        temperature: splat.temperature,
        saturation: splat.saturation,
        brightness: splat.brightness,
        blackPoint: splat.blackPoint,
        whitePoint: splat.whitePoint,
        transparency: splat.transparency
    });
};

/**
 * Check if the splat's current data state matches the import-time fingerprint.
 * Uses value comparison for entity transform and color params (O(1)),
 * version counter for transform palette (O(1)),
 * and Uint8Array scan for deleted gaussians (O(n) with early exit).
 */
const isDataClean = (splat: Splat): boolean => {
    const fp = fingerprintCache.get(splat.uid);
    if (!fp) return false;

    // Scan state array for deleted bits (SOG imports always start with all zeros).
    // Early-exit on first non-zero deleted bit.
    const state = splat.splatData.getProp('state') as Uint8Array;
    if (state) {
        for (let i = 0; i < state.length; i++) {
            if ((state[i] & State.deleted) !== 0) return false;
        }
    }

    // Transform palette version (tracked by SplatsTransformOp)
    if ((splat._transformPaletteVersion ?? 0) !== fp.transformPaletteVersion) return false;

    // Entity transform value comparison
    const pos = splat.entity.getLocalPosition();
    const rot = splat.entity.getLocalRotation();
    const scl = splat.entity.getLocalScale();
    if (pos.x !== fp.localPosition[0] || pos.y !== fp.localPosition[1] || pos.z !== fp.localPosition[2]) return false;
    if (rot.x !== fp.localRotation[0] || rot.y !== fp.localRotation[1] ||
        rot.z !== fp.localRotation[2] || rot.w !== fp.localRotation[3]) return false;
    if (scl.x !== fp.localScale[0] || scl.y !== fp.localScale[1] || scl.z !== fp.localScale[2]) return false;

    // Color adjustment value comparison
    if (splat.tintClr.r !== fp.tintClr[0] || splat.tintClr.g !== fp.tintClr[1] || splat.tintClr.b !== fp.tintClr[2]) return false;
    if (splat.temperature !== fp.temperature) return false;
    if (splat.saturation !== fp.saturation) return false;
    if (splat.brightness !== fp.brightness) return false;
    if (splat.blackPoint !== fp.blackPoint) return false;
    if (splat.whitePoint !== fp.whitePoint) return false;
    if (splat.transparency !== fp.transparency) return false;

    return true;
};

const SOG_DEFAULT_MAX_SH_BANDS = 3;
const SOG_DEFAULT_MIN_OPACITY = 0.004;
const SOG_DEFAULT_REMOVE_INVALID = true;
const SOG_DEFAULT_ITERATIONS = 10;

/**
 * Check whether all export options that affect SOG data content are at their defaults.
 * Non-default options mean the user expects output that differs from the cached source.
 */
const areExportOptionsDefault = (
    serializeSettings?: SerializeSettings,
    iterations?: number
): boolean => {
    return (
        (serializeSettings?.maxSHBands ?? SOG_DEFAULT_MAX_SH_BANDS) === SOG_DEFAULT_MAX_SH_BANDS &&
        (serializeSettings?.minOpacity ?? SOG_DEFAULT_MIN_OPACITY) === SOG_DEFAULT_MIN_OPACITY &&
        (serializeSettings?.removeInvalid ?? SOG_DEFAULT_REMOVE_INVALID) === SOG_DEFAULT_REMOVE_INVALID &&
        (iterations ?? SOG_DEFAULT_ITERATIONS) === SOG_DEFAULT_ITERATIONS
    );
};

/**
 * Determine whether the fast publish path can be used.
 * Conditions: single splat, cached SOG source, data unchanged, export options at defaults.
 */
const canSkipSerialize = (
    splats: Splat[],
    serializeSettings?: SerializeSettings,
    iterations?: number
): boolean => {
    if (splats.length !== 1) return false;
    const splat = splats[0];
    if (!cache.has(splat.uid)) return false;
    if (!isDataClean(splat)) return false;
    if (!areExportOptionsDefault(serializeSettings, iterations)) return false;
    return true;
};

/**
 * Read a File/Blob into a Uint8Array.
 */
const readFileToBytes = async (file: File | Blob): Promise<Uint8Array> => {
    const arrayBuffer = await file.arrayBuffer();
    return new Uint8Array(arrayBuffer);
};

/**
 * Build upload-ready files from cached SOG source files.
 *
 * Handles all 4 format combinations:
 *   bundled→bundled:   direct pass-through, rename to output.sog
 *   unbundled→unbundled: direct pass-through, names already match
 *   bundled→unbundled:  ZipReadFileSystem unzip
 *   unbundled→bundled:  MemoryFileSystem + ZipFileSystem repack
 *
 * scene.json is always generated as a separate file when sceneConfig is provided.
 *
 * @param splats - The splat array (must have exactly 1 element with a cache hit).
 * @param sceneConfig - Optional scene configuration to serialize as scene.json.
 * @param targetFormat - Desired output format; defaults to the cached source format.
 * @returns Array of {name, data} ready for upload.
 */
const buildFilesFromCache = async (
    splats: Splat[],
    sceneConfig?: Record<string, unknown>,
    targetFormat?: 'bundled' | 'unbundled'
): Promise<Array<{ name: string; data: Uint8Array }>> => {
    const splat = splats[0];
    const entry = cache.get(splat.uid);
    if (!entry) {
        throw new Error('No cached source files for splat');
    }

    const sourceFormat = entry.format;
    const outputFormat = targetFormat || sourceFormat;
    const result: Array<{ name: string; data: Uint8Array }> = [];

    // ---- SOG data files ----
    if (sourceFormat === 'bundled' && outputFormat === 'bundled') {
        // Direct pass-through: read the .sog file and rename to output.sog
        const sogFile = entry.files[0];
        const data = await readFileToBytes(sogFile.data);
        result.push({ name: 'output.sog', data });
    } else if (sourceFormat === 'unbundled' && outputFormat === 'unbundled') {
        // Direct pass-through: read all cached files (meta.json, sh*.webp)
        for (const file of entry.files) {
            const data = await readFileToBytes(file.data);
            result.push({ name: file.name, data });
        }
    } else if (sourceFormat === 'bundled' && outputFormat === 'unbundled') {
        // Unzip the .sog file to extract meta.json + webp files
        const sogFile = entry.files[0];
        const source = new BlobReadSource(sogFile.data as Blob);
        const zipFs = new ZipReadFileSystem(source);

        try {
            const names = await zipFs.list();
            for (const name of names) {
                const entrySource = await zipFs.createSource(name);
                const stream = entrySource.read();
                const data = await stream.readAll();
                stream.close();
                result.push({ name, data });
            }
        } finally {
            zipFs.close();
        }
    } else if (sourceFormat === 'unbundled' && outputFormat === 'bundled') {
        // Repack meta.json + webp files into output.sog ZIP
        const memFs = new MemoryFileSystem();

        // Write all cached files into the memory FS
        for (const file of entry.files) {
            const writer = await memFs.createWriter(file.name);
            const data = await readFileToBytes(file.data);
            await writer.write(data);
            await writer.close();
        }

        // Create the ZIP
        const zipWriter = await memFs.createWriter('output.sog');
        const zipFs = new ZipFileSystem(zipWriter);
        try {
            for (const [fname, data] of memFs.results.entries()) {
                if (fname === 'output.sog') continue; // skip the zip-in-progress
                const writer = await zipFs.createWriter(fname);
                await writer.write(data);
                await writer.close();
            }
        } finally {
            await zipFs.close();
        }

        const zipData = memFs.results.get('output.sog');
        if (zipData) {
            result.push({ name: 'output.sog', data: zipData });
        }
    }

    // ---- scene.json (separate file, always generated when sceneConfig is present) ----
    if (sceneConfig) {
        const sceneJson = JSON.stringify(sceneConfig, null, 2);
        result.push({ name: 'scene.json', data: new TextEncoder().encode(sceneJson) });
    }

    return result;
};

export {
    SogSourceFormat,
    SogSourceCacheEntry,
    SplatFingerprint,
    cacheSourceFile,
    getSourceCache,
    evictSplat,
    evictFingerprint,
    clearSourceCache,
    captureFingerprint,
    isDataClean,
    areExportOptionsDefault,
    canSkipSerialize,
    buildFilesFromCache
};
