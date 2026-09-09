export const LOW_DISK_STOP_BYTES = 1_073_741_824;

export type RecordingStorageStatus = {
	availableBytes: number;
	totalBytes: number;
};

/** Stateful guard: one recording can request at most one low-disk stop. */
export function createLowDiskRecordingGuard(stopBytes = LOW_DISK_STOP_BYTES) {
	let stopRequested = false;

	return {
		check(status: RecordingStorageStatus, thresholdBytes = stopBytes): boolean {
			if (stopRequested || !Number.isFinite(status.availableBytes)) return false;
			if (status.availableBytes > thresholdBytes) return false;
			stopRequested = true;
			return true;
		},
		reset(): void {
			stopRequested = false;
		},
	};
}
