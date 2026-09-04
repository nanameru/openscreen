// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:1:0", name: "Display 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;
let notifyUnexpectedStop: (() => void) | undefined;

function stubElectronAPI() {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "darwin"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		requestNativeMacCursorAccess: vi.fn(async () => ({
			success: true,
			granted: true,
			status: "granted",
			accessibilityTrusted: true,
		})),
		startNativeMacRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, path: "/recordings/a.mp4" })),
		onNativeMacCaptureStoppedUnexpectedly: vi.fn((callback: () => void) => {
			notifyUnexpectedStop = callback;
			return vi.fn();
		}),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	notifyUnexpectedStop = undefined;
	stubElectronAPI();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native macOS unexpected stop", () => {
	it("finalizes and opens the editor once when ScreenCaptureKit stops the stream", async () => {
		const view = renderHook(() => useScreenRecorder());

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);
		expect(view.result.current.recording).toBe(true);
		expect(notifyUnexpectedStop).toBeTypeOf("function");

		await act(async () => {
			notifyUnexpectedStop?.();
			notifyUnexpectedStop?.();
		});
		await settle();

		expect(api.stopNativeMacRecording).toHaveBeenCalledTimes(1);
		expect(api.setCurrentVideoPath).toHaveBeenCalledWith("/recordings/a.mp4");
		expect(api.switchToEditor).toHaveBeenCalledTimes(1);
		expect(view.result.current.recording).toBe(false);
	});
});
