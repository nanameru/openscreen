import { describe, expect, it } from "vitest";
import { createLowDiskRecordingGuard, LOW_DISK_STOP_BYTES } from "./lowDiskRecordingGuard";

describe("createLowDiskRecordingGuard", () => {
	it("requests a stop only once at the safety threshold", () => {
		const guard = createLowDiskRecordingGuard();

		expect(
			guard.check({ availableBytes: LOW_DISK_STOP_BYTES + 1, totalBytes: 10_000_000_000 }),
		).toBe(false);
		expect(guard.check({ availableBytes: LOW_DISK_STOP_BYTES, totalBytes: 10_000_000_000 })).toBe(
			true,
		);
		expect(guard.check({ availableBytes: 0, totalBytes: 10_000_000_000 })).toBe(false);
	});

	it("can be reset for the next recording", () => {
		const guard = createLowDiskRecordingGuard(100);
		expect(guard.check({ availableBytes: 50, totalBytes: 1000 })).toBe(true);
		guard.reset();
		expect(guard.check({ availableBytes: 50, totalBytes: 1000 })).toBe(true);
	});

	it("accepts a runtime threshold for an end-to-end safety check", () => {
		const guard = createLowDiskRecordingGuard();
		expect(guard.check({ availableBytes: 500, totalBytes: 1000 }, 600)).toBe(true);
	});
});
