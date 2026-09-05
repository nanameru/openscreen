/**
 * Mirrors the app's transport (play/pause) and playhead (scrub/step) onto the
 * active native compositor view. Mounted once in the editor shell; a no-op
 * whenever no native view is active (flag off / addon absent), so it's safe to
 * call unconditionally.
 *
 * Playback model — why we don't push a seek every frame:
 *  - Play/pause maps to native *free-run* (`setNativePlaying`). While playing,
 *    the native decoder advances its own frames sequentially (cheap).
 *  - `currentTimeSec` ticks every rAF frame during playback. Pushing
 *    `setNativeTime` per tick would force an O(n) rewind+decode seek each frame
 *    AND fight the free-run (the render thread prioritises app-requested frames
 *    over free-run). Discrete seeks are sent while paused or when the user
 *    explicitly seeks during playback. Pausing re-snaps to the app playhead.
 *
 * The clocks can drift during free-run. Correcting that requires native clock
 * telemetry: an assumed 1x wall clock cannot measure drift at other speeds.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { resolveNativePosition } from "@/lib/ai-edition/timeline/timelineMap";
import {
	getCurrentNativeViewId,
	setNativePlaying,
	setNativeTime,
	subscribeNativeCompositor,
} from "./nativeCompositorStore";

export function useNativePlaybackSync(
	playing: boolean,
	currentTimeSec: number,
	/** Trim-compressed playback segments (`resolveVisibleClips`) — the native stream. */
	visibleSegments: readonly AxcutClip[],
	/** RAW clip layout (`document.timeline.clips`) `currentTimeSec` is expressed against. */
	rawClips: readonly AxcutClip[],
	/** Changes only for a user seek, never for a playback-clock tick. */
	seekRequestId?: number,
): void {
	const activePosition = useMemo(
		() => resolveNativePosition(currentTimeSec, [...visibleSegments], [...rawClips]),
		[visibleSegments, rawClips, currentTimeSec],
	);
	const activeClipId = activePosition?.clip.id ?? null;
	const sourceTimeSec = activePosition?.sourceTimeSec ?? null;

	// Reactive "is a native view active?" so activation mid-session re-pushes the
	// current transport/playhead (time & playing aren't memoised in the store).
	const active = useSyncExternalStore(
		subscribeNativeCompositor,
		() => getCurrentNativeViewId() !== null,
	);

	// Play/pause → native free-run.
	useEffect(() => {
		if (!active) {
			return;
		}
		setNativePlaying(playing);
	}, [active, playing]);

	// A wall-clock estimate is not native decoder telemetry. At 1.5x it
	// falsely reports 100ms of drift every 200ms and repeatedly rewinds the
	// decoder. During playback, seek only in response to explicit user input.
	const lastSeekRequestIdRef = useRef(seekRequestId);
	const lastActiveClipIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!active || sourceTimeSec === null || !activeClipId) {
			return;
		}
		const explicitlySeeking = seekRequestId !== lastSeekRequestIdRef.current;
		lastSeekRequestIdRef.current = seekRequestId;

		// When clip changes, let setActiveClip handle the atomic clip-switch-and-seek.
		if (lastActiveClipIdRef.current !== activeClipId) {
			lastActiveClipIdRef.current = activeClipId;
			return;
		}

		if (!playing || explicitlySeeking) {
			setNativeTime(sourceTimeSec);
		}
	}, [active, playing, activeClipId, sourceTimeSec, seekRequestId]);
}
