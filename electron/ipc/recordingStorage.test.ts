import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRecordingStorageStatus, listRecordingLibrary } from "./recordingStorage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

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

describe("listRecordingLibrary", () => {
	it("lists screen recordings newest first and reads saved session metadata", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-recording-library-"));
		temporaryDirectories.push(dir);
		const olderPath = path.join(dir, "recording-1.webm");
		const newerPath = path.join(dir, "recording-2.mp4");
		await fs.writeFile(olderPath, "old");
		await fs.writeFile(newerPath, "newer");
		await fs.writeFile(path.join(dir, "recording-2-webcam.mp4"), "camera");
		await fs.writeFile(path.join(dir, "notes.txt"), "ignore");
		await fs.writeFile(
			path.join(dir, "recording-1.session.json"),
			JSON.stringify({ screenVideoPath: olderPath, createdAt: 100 }),
		);
		await fs.writeFile(
			path.join(dir, "recording-2.session.json"),
			JSON.stringify({
				screenVideoPath: newerPath,
				createdAt: 200,
				durationMs: 12_000,
				stopReason: "low-disk",
			}),
		);

		const recordings = await listRecordingLibrary(dir);

		expect(recordings).toHaveLength(2);
		expect(recordings[0]).toMatchObject({
			path: newerPath,
			name: "recording-2.mp4",
			createdAt: 200,
			durationMs: 12_000,
			stopReason: "low-disk",
		});
		expect(recordings.map((recording) => recording.name)).not.toContain("recording-2-webcam.mp4");
	});

	it("returns an empty library when the recordings directory does not exist", async () => {
		await expect(
			listRecordingLibrary("/definitely/missing/openscreen-recordings"),
		).resolves.toEqual([]);
	});
});
