import fs from "node:fs/promises";

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
