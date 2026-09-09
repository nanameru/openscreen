// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount, or returns to the project that launched recording.
// The slot has to be emptied once the editor has handled it, because opening the
// editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

export type RecordingImportResult = {
	imported: boolean;
	continued: boolean;
	savedToLibrary?: boolean;
	stopReason?: "low-disk";
};

/**
 * Imports a HUD recording into a new project. Recordings launched from an
 * existing editor return to that project but stay in the recording library until
 * the user explicitly adds them. Either path consumes the hand-off exactly once.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
export async function importPendingRecording(): Promise<RecordingImportResult> {
	const api = window.electronAPI;
	if (!api) return { imported: false, continued: false };

	const result = await api.getCurrentRecordingSession();
	const screenPath = result.success ? result.session?.screenVideoPath : undefined;
	if (!screenPath) return { imported: false, continued: false };

	const label = screenPath.split(/[\\/]/).pop() || "Recording";
	const returnProjectId = result.session?.returnProjectId;
	if (returnProjectId) {
		await useProjectStore.getState().loadProject(returnProjectId);
		await api.setCurrentRecordingSession(null);
		return {
			imported: true,
			continued: false,
			savedToLibrary: true,
			...(result.session?.stopReason ? { stopReason: result.session.stopReason } : {}),
		};
	} else {
		await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
	}
	await useProjectStore.getState().addAsset(screenPath, label);
	await api.setCurrentRecordingSession(null);

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	let doc = useProjectStore.getState().document;
	if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
		// `history: false`. Nothing here is an edit: the user finished a recording and the
		// editor built them a project around it, unattended, on mount. Recording it left a
		// brand-new project sitting at `past.length === 1` before the user had touched
		// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
		// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
		await useProjectStore
			.getState()
			.replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
				history: false,
			});
	}
	return {
		imported: true,
		continued: false,
		...(result.session?.stopReason ? { stopReason: result.session.stopReason } : {}),
	};
}
