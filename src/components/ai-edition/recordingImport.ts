// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import { createId } from "@/lib/ai-edition/document/ids";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

export type RecordingImportResult = {
	imported: boolean;
	continued: boolean;
	stopReason?: "low-disk";
};

/**
 * Imports the recording the HUD handed over into a new project, and consumes the
 * hand-off so it is imported exactly once.
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
	const continuationProjectId = result.session?.continuationProjectId;
	if (continuationProjectId) {
		await useProjectStore.getState().loadProject(continuationProjectId);
	} else {
		await useProjectStore.getState().createProject(`Recording ${new Date().toLocaleString()}`);
	}
	const addedAsset = await useProjectStore.getState().addAsset(screenPath, label);
	// A new project's hand-off is consumed once the asset is persisted. A
	// continuation stays available until its timeline append is saved so a failed
	// project load cannot lose the user's take.
	if (!continuationProjectId) {
		await api.setCurrentRecordingSession(null);
	}

	// ponytail: MediaRecorder WebMs ship with duration = NaN until
	// fix-webm-duration patches the EBML header; until that flows through the
	// asset, drop a default 60s clip into the timeline so the editor isn't stuck
	// on "No clips yet" the moment the user lands in the project. Real duration
	// overwrites this when handleLoadedMetadata fires with a finite value.
	let doc = useProjectStore.getState().document;
	if (continuationProjectId && doc && addedAsset) {
		const durationSec = Math.max(0.001, (result.session?.durationMs ?? 60_000) / 1000);
		const timelineStartSec = doc.timeline.clips.reduce(
			(max, clip) => Math.max(max, clip.timelineEndSec),
			0,
		);
		const next = {
			...doc,
			assets: doc.assets.map((asset) =>
				asset.id === addedAsset.id ? { ...asset, durationSec } : asset,
			),
			timeline: {
				...doc.timeline,
				clips: [
					...doc.timeline.clips,
					{
						id: createId("clip"),
						assetId: addedAsset.id,
						sourceStartSec: 0,
						sourceEndSec: durationSec,
						timelineStartSec,
						timelineEndSec: timelineStartSec + durationSec,
						wordRefs: [],
						origin: "system" as const,
						reason: "Continued recording",
					},
				],
			},
		};
		await useProjectStore.getState().saveDocument(next, { history: false });
		doc = next;
		await api.setCurrentRecordingSession(null);
	} else if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
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
		continued: Boolean(continuationProjectId),
		...(result.session?.stopReason ? { stopReason: result.session.stopReason } : {}),
	};
}
