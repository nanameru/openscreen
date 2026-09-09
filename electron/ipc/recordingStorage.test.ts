import { describe, expect, it, vi } from "vitest";
import { getRecordingStorageStatus } from "./recordingStorage";

describe("getRecordingStorageStatus", () => {
	it("uses available blocks from the recording volume", async () => {
		const statfs = vi.fn(async () => ({ bavail: 25n, bsize: 4096n, blocks: 100n }));

		await expect(getRecordingStorageStatus("/recordings", statfs)).resolves.toEqual({
			availableBytes: 102_400,
			totalBytes: 409_600,
		});
		expect(statfs).toHaveBeenCalledWith("/recordings");
	});
});
