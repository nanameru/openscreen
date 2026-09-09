export interface RecordingLibraryItem {
	path: string;
	name: string;
	createdAt: number;
	sizeBytes: number;
	durationMs?: number;
	stopReason?: "low-disk";
}
