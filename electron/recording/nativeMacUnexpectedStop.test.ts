import { describe, expect, it } from "vitest";
import {
	advanceNativeMacUnexpectedStop,
	isNativeMacUnexpectedStopError,
} from "./nativeMacUnexpectedStop";

const streamError = {
	event: "error",
	code: "capture-stopped-with-error",
	message: "SCStreamErrorDomain Code=-3821",
};

describe("native macOS unexpected stop", () => {
	it("notifies only after the partial recording has finished writing", () => {
		const failed = advanceNativeMacUnexpectedStop(null, streamError);
		expect(failed.notification).toBeNull();

		const finalized = advanceNativeMacUnexpectedStop(failed.pending, {
			event: "recording-stopped",
			screenPath: "/recordings/a.mp4",
		});
		expect(finalized).toEqual({ pending: null, notification: streamError });
	});

	it("does not treat a normal recording stop as unexpected", () => {
		expect(
			advanceNativeMacUnexpectedStop(null, {
				event: "recording-stopped",
				screenPath: "/recordings/a.mp4",
			}),
		).toEqual({ pending: null, notification: null });
	});

	it("recognizes only the stream failure that can be salvaged", () => {
		expect(isNativeMacUnexpectedStopError(streamError)).toBe(true);
		expect(
			isNativeMacUnexpectedStopError({
				event: "error",
				code: "writer-failed",
				message: "disk full",
			}),
		).toBe(false);
	});
});
