import type { NativeMacHelperErrorEvent } from "../../src/lib/nativeMacRecording";

export const NATIVE_MAC_UNEXPECTED_STOP_ERROR_CODE = "capture-stopped-with-error";

export type NativeMacUnexpectedStopState = NativeMacHelperErrorEvent | null;

export type NativeMacUnexpectedStopTransition = {
	pending: NativeMacUnexpectedStopState;
	notification: NativeMacHelperErrorEvent | null;
};

export function isNativeMacUnexpectedStopError(
	event: Record<string, unknown>,
): event is NativeMacHelperErrorEvent {
	return (
		event.event === "error" &&
		event.code === NATIVE_MAC_UNEXPECTED_STOP_ERROR_CODE &&
		typeof event.message === "string"
	);
}

/**
 * Waits for the helper's writer acknowledgement before notifying the renderer.
 * The stream error arrives first, while AVAssetWriter may still be finalizing the
 * partial MP4; stopping the helper at that point can truncate the recovery file.
 */
export function advanceNativeMacUnexpectedStop(
	pending: NativeMacUnexpectedStopState,
	event: Record<string, unknown>,
): NativeMacUnexpectedStopTransition {
	if (event.event === "recording-started") {
		return { pending: null, notification: null };
	}

	if (isNativeMacUnexpectedStopError(event)) {
		return { pending: event, notification: null };
	}

	if (event.event === "recording-stopped" && pending) {
		return { pending: null, notification: pending };
	}

	return { pending, notification: null };
}
