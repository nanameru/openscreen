// @vitest-environment jsdom
/**
 * The fatal-error channel (PR #162).
 *
 * `createView` returns an id long before the native render thread can fail, so a host
 * that cannot create a D3D11 device used to leave the user with a black canvas and an
 * `eprintln!` nobody reads. The addon now reports the dead thread through `readFrame`,
 * and this hook turns that into `error`.
 *
 * The half worth guarding is the negative one: `readFrame` also rejects when there is no
 * Electron bridge at all (pure web `npm run dev`, jsdom), and the addon being absent is a
 * normal no-op, not a failure. Neither may raise the banner.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createCompositorView: vi.fn(),
	readCompositorFrame: vi.fn(),
	destroyCompositorView: vi.fn(),
}));

vi.mock("../compositorViewClient", () => ({
	createCompositorView: mocks.createCompositorView,
	readCompositorFrame: mocks.readCompositorFrame,
	destroyCompositorView: mocks.destroyCompositorView,
	setCompositorParam: vi.fn(),
	setCompositorPlaying: vi.fn(),
	setCompositorRect: vi.fn(),
}));

import { useNativeCompositorView } from "./useNativeCompositorView";

// jsdom ships no ResizeObserver; the hook constructs one to track the canvas box.
// Nothing here observes anything — these tests only exercise the pull loop.
globalThis.ResizeObserver = class {
	observe() {
		// inert on purpose: the canvas box never changes in these tests
	}
	unobserve() {
		// see observe()
	}
	disconnect() {
		// see observe()
	}
} as unknown as typeof ResizeObserver;

/** A canvas with a stubbed 2D context — jsdom has none, and the pull loop bails without it. */
function stubCanvasRef(): RefObject<HTMLCanvasElement> {
	const canvas = document.createElement("canvas");
	canvas.getContext = vi.fn(() => ({})) as unknown as HTMLCanvasElement["getContext"];
	return { current: canvas };
}

const DEVICE_FAILURE =
	"this display adapter has no D3D11 video decoder (0x887A0004). OpenScreen decodes every preview and export frame with D3D11VA";

describe("useNativeCompositorView", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("surfaces the native message when the render thread dies", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
	});

	it("stops polling once the error is terminal — the thread never restarts", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockRejectedValue(new Error(DEVICE_FAILURE));

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(result.current.error).toBe(DEVICE_FAILURE));
		const callsAtFailure = mocks.readCompositorFrame.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(callsAtFailure);
	});

	it("stays quiet when the addon is absent (synthetic id, no frames, no error)", async () => {
		mocks.createCompositorView.mockResolvedValue({ id: -1 });
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.readCompositorFrame).toHaveBeenCalled());
		expect(result.current.error).toBeNull();
	});

	it("stays quiet without an Electron bridge — no view id, so nothing is ever polled", async () => {
		mocks.createCompositorView.mockRejectedValue(new Error("Native bridge unavailable."));
		mocks.readCompositorFrame.mockResolvedValue(null);

		const ref = stubCanvasRef();
		const { result } = renderHook(() =>
			useNativeCompositorView(ref, { sources: { screenPath: "rec.mp4" } }),
		);

		await waitFor(() => expect(mocks.createCompositorView).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(mocks.readCompositorFrame).not.toHaveBeenCalled();
		expect(result.current.error).toBeNull();
	});
});

describe("preview frame pacing", () => {
	let callbacks: Map<number, FrameRequestCallback>;
	let nextId: number;
	beforeEach(() => {
		vi.clearAllMocks();
		callbacks = new Map();
		nextId = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callbacks.set(++nextId, callback);
			return nextId;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
		mocks.createCompositorView.mockResolvedValue({ id: 7 });
		mocks.readCompositorFrame.mockResolvedValue(null);
	});
	afterEach(() => vi.unstubAllGlobals());

	async function tick(time: number) {
		await act(async () => {
			const pending = [...callbacks.values()];
			callbacks.clear();
			for (const callback of pending) callback(time);
		});
	}

	it("polls each 60Hz frame and caps a 120Hz display", async () => {
		const ref = stubCanvasRef();
		const view = renderHook(() => useNativeCompositorView(ref));
		await act(async () => {
			/* Flush native view creation. */
		});
		await tick(0);
		await tick(8.33);
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(1);
		await tick(16.67);
		await tick(33.33);
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(3);
		view.unmount();
	});

	it("waits for bitmap presentation, then resumes without an extra skipped frame", async () => {
		let finishBitmap!: (bitmap: ImageBitmap) => void;
		const bitmapPromise = new Promise<ImageBitmap>((resolve) => {
			finishBitmap = resolve;
		});
		vi.stubGlobal(
			"ImageData",
			class {
				constructor(..._args: unknown[]) {
					/* Canvas pixels are stubbed in jsdom. */
				}
			},
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(() => bitmapPromise),
		);
		const drawImage = vi.fn();
		const canvas = document.createElement("canvas");
		canvas.getContext = vi.fn(() => ({ drawImage })) as unknown as HTMLCanvasElement["getContext"];
		mocks.readCompositorFrame.mockResolvedValueOnce({
			gen: 1,
			width: 1,
			height: 1,
			data: new Uint8Array(4),
		});
		const ref = { current: canvas };
		const view = renderHook(() => useNativeCompositorView(ref));
		await act(async () => {
			/* Flush native view creation. */
		});
		await tick(0);
		await tick(16.67);
		await tick(33.33);
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(1);
		const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
		await act(async () => finishBitmap(bitmap));
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
		expect(bitmap.close).toHaveBeenCalledOnce();
		await tick(50);
		expect(mocks.readCompositorFrame).toHaveBeenCalledTimes(2);
		expect(mocks.readCompositorFrame).toHaveBeenLastCalledWith(7, 1);
		view.unmount();
	});
});
