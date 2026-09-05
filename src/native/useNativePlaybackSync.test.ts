// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";

const native = vi.hoisted(() => ({ seek: vi.fn(), play: vi.fn() }));
vi.mock("./nativeCompositorStore", () => ({
	getCurrentNativeViewId: () => 1,
	subscribeNativeCompositor: () => () => undefined,
	setNativeTime: native.seek,
	setNativePlaying: native.play,
}));

import { useNativePlaybackSync } from "./useNativePlaybackSync";

const clips: AxcutClip[] = [
	{
		id: "clip",
		assetId: "asset",
		sourceStartSec: 0,
		sourceEndSec: 30,
		timelineStartSec: 0,
		timelineEndSec: 30,
		wordRefs: [],
		origin: "user",
		reason: "test",
	},
];
const initial = { playing: true, time: 0, requestId: 0 };
function useSync(props: typeof initial) {
	useNativePlaybackSync(props.playing, props.time, clips, clips, props.requestId);
}

describe("native playback sync", () => {
	let wallTime: number;
	beforeEach(() => {
		vi.clearAllMocks();
		wallTime = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => wallTime);
	});
	afterEach(() => vi.restoreAllMocks());
	it.each([0.5, 1, 1.5, 2])("does not seek during uninterrupted %sx playback", (speed) => {
		const view = renderHook(useSync, { initialProps: initial });
		for (let tick = 1; tick <= 120; tick++) {
			wallTime = 1000 + (tick * 1000) / 60;
			view.rerender({ ...initial, time: (tick * speed) / 60 });
		}
		expect(native.seek).not.toHaveBeenCalled();
		view.unmount();
	});
	it("seeks once for explicit input while playing, then continues freely", () => {
		const view = renderHook(useSync, { initialProps: initial });
		view.rerender({ ...initial, time: 9, requestId: 1 });
		expect(native.seek).toHaveBeenCalledExactlyOnceWith(9);
		view.rerender({ ...initial, time: 9.2, requestId: 1 });
		expect(native.seek).toHaveBeenCalledTimes(1);
		view.rerender({ playing: false, time: 9.2, requestId: 1 });
		expect(native.seek).toHaveBeenLastCalledWith(9.2);
		view.rerender({ playing: false, time: 5, requestId: 2 });
		expect(native.seek).toHaveBeenLastCalledWith(5);
		view.unmount();
	});
});
