import fs from "node:fs/promises";
import path from "node:path";
import type { RecordingLibraryItem } from "../../src/lib/recordingLibrary";
import { normalizeRecordingSession } from "../../src/lib/recordingSession";

export type RecordingStorageStatus = {
	availableBytes: number;
	totalBytes: number;
};

type StatFsResult = {
	bavail: number | bigint;
	bsize: number | bigint;
	blocks: number | bigint;
};

/** Read free space from the volume that actually contains the recording directory. */
export async function getRecordingStorageStatus(
	recordingsDir: string,
	statfs: (path: string) => Promise<StatFsResult> = fs.statfs,
): Promise<RecordingStorageStatus> {
	const stats = await statfs(recordingsDir);
	const blockSize = BigInt(stats.bsize);
	const availableBytes = BigInt(stats.bavail) * blockSize;
	const totalBytes = BigInt(stats.blocks) * blockSize;

	return {
		availableBytes: Number(availableBytes),
		totalBytes: Number(totalBytes),
	};
}

type RecordingLibraryFs = Pick<typeof fs, "readdir" | "readFile" | "stat">;
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov"]);

/** Lists saved screen recordings without copying or changing any source file. */
export async function listRecordingLibrary(
	recordingsDir: string,
	fsApi: RecordingLibraryFs = fs,
): Promise<RecordingLibraryItem[]> {
	let entries;
	try {
		entries = await fsApi.readdir(recordingsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const recordings = await Promise.all(
		entries.map(async (entry): Promise<RecordingLibraryItem | null> => {
			if (!entry.isFile()) return null;
			const parsed = path.parse(entry.name);
			if (!VIDEO_EXTENSIONS.has(parsed.ext.toLowerCase()) || parsed.name.endsWith("-webcam")) {
				return null;
			}

			const videoPath = path.join(recordingsDir, entry.name);
			let stats;
			try {
				stats = await fsApi.stat(videoPath);
			} catch {
				// A recording can disappear between readdir and stat; skip that one stale entry.
				return null;
			}
			let session = null;
			try {
				const manifest = await fsApi.readFile(
					path.join(recordingsDir, `${parsed.name}.session.json`),
					"utf-8",
				);
				session = normalizeRecordingSession(JSON.parse(manifest));
				if (session?.screenVideoPath !== videoPath) session = null;
			} catch {
				// Older recordings may not have a manifest; stat metadata still makes them reusable.
			}

			return {
				path: videoPath,
				name: entry.name,
				createdAt: session?.createdAt ?? (stats.birthtimeMs || stats.mtimeMs),
				sizeBytes: stats.size,
				...(session?.durationMs !== undefined ? { durationMs: session.durationMs } : {}),
				...(session?.stopReason ? { stopReason: session.stopReason } : {}),
			};
		}),
	);

	return recordings
		.filter((item): item is RecordingLibraryItem => item !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}
