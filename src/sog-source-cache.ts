import { MemoryFileSystem, ZipFileSystem, ZipReadFileSystem } from '@playcanvas/splat-transform';
import { BlobReadSource } from './io/read/file-systems';
import { Splat } from './splat';

type SogSourceFormat = 'bundled' | 'unbundled';

interface SogSourceCacheEntry {
    format: SogSourceFormat;
    // bundled: single File (.sog ZIP file)
    // unbundled: multiple Files (meta.json, sh0.webp, sh1.webp, ...)
    files: Array<{ name: string; data: File | Blob }>;
}

// Module-level cache: splat.uid → cache entry
const cache = new Map<number, SogSourceCacheEntry>();

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
};

const canSkipSerialize = (splats: Splat[]): boolean => {
    if (splats.length !== 1) return false;
    return cache.has(splats[0].uid);
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
    cacheSourceFile,
    getSourceCache,
    evictSplat,
    clearSourceCache,
    canSkipSerialize,
    buildFilesFromCache
};
