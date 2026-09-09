import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutAsset, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { RecordingLibraryItem } from "@/lib/recordingLibrary";
import {
	addLibraryRecordingToTimeline,
	addSelectedAssetToTimeline,
	cacheLibraryRecordingDuration,
} from "./MediaStage";

describe("addSelectedAssetToTimeline", () => {
	it("reports success only once the selected asset has been added", async () => {
		// Deferred on purpose: with an immediately-resolved onAdd this test passes whether
		// onSuccess fires before or after the insertion, which is the one thing it is here
		// to pin — a success toast for a clip that is not on the timeline yet.
		let resolveAdd!: () => void;
		const onAdd = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveAdd = resolve;
				}),
		);
		const onSuccess = vi.fn();

		const pending = addSelectedAssetToTimeline(
			{ id: "asset-7", label: "", originalPath: "/recordings/demo.mp4" },
			onAdd,
			onSuccess,
		);

		expect(onAdd).toHaveBeenCalledWith("asset-7");
		expect(onSuccess).not.toHaveBeenCalled();

		resolveAdd();
		await pending;

		// Empty label falls back to the basename.
		expect(onSuccess).toHaveBeenCalledWith("demo.mp4");
	});

	it("does not report success when adding the asset fails", async () => {
		const error = new Error("insert failed");
		const onAdd = vi.fn(async () => {
			throw error;
		});
		const onSuccess = vi.fn();

		await expect(
			addSelectedAssetToTimeline(
				{ id: "asset-7", label: "Demo", originalPath: "/recordings/demo.mp4" },
				onAdd,
				onSuccess,
			),
		).rejects.toBe(error);

		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("does nothing without a selected asset", async () => {
		const onAdd = vi.fn(async () => undefined);
		const onSuccess = vi.fn();

		await addSelectedAssetToTimeline(null, onAdd, onSuccess);

		expect(onAdd).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});
});

describe("addLibraryRecordingToTimeline", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
	});

	const recording: RecordingLibraryItem = {
		path: "/recordings/part-2.mp4",
		name: "part-2.mp4",
		createdAt: 2,
		sizeBytes: 42,
		durationMs: 5_000,
	};
	const asset = {
		id: "asset-2",
		kind: "video",
		label: "part-2.mp4",
		originalPath: recording.path,
		cameraTrack: null,
	} as AxcutAsset;

	it("reuses an existing asset reference without importing another copy", async () => {
		const addAsset = vi.fn(async () => null);
		const addToTimeline = vi.fn(async () => undefined);

		await expect(
			addLibraryRecordingToTimeline(recording, [asset], addAsset, addToTimeline),
		).resolves.toBe("part-2.mp4");

		expect(addAsset).not.toHaveBeenCalled();
		expect(addToTimeline).toHaveBeenCalledWith("asset-2");
	});

	it("imports a new asset reference before adding it to the timeline", async () => {
		const addAsset = vi.fn(async () => asset);
		const addToTimeline = vi.fn(async () => undefined);

		await addLibraryRecordingToTimeline(recording, [], addAsset, addToTimeline);

		expect(addAsset).toHaveBeenCalledWith(recording.path, recording.name);
		expect(addToTimeline).toHaveBeenCalledWith("asset-2");
	});

	it("does not touch the timeline when the asset import fails", async () => {
		const addAsset = vi.fn(async () => null);
		const addToTimeline = vi.fn(async () => undefined);

		await expect(
			addLibraryRecordingToTimeline(recording, [], addAsset, addToTimeline),
		).rejects.toThrow("could not be added");
		expect(addToTimeline).not.toHaveBeenCalled();
	});

	it("caches the real duration before the timeline insertion", async () => {
		const document = {
			...createEmptyDocument({ projectId: "project-1", title: "Recording" }),
			assets: [asset],
		};
		const saveDocument = vi.fn(async (next: typeof document) => {
			useProjectStore.setState({ document: next });
			return true;
		});
		useProjectStore.setState({
			document,
			// biome-ignore lint/suspicious/noExplicitAny: focused store action stub
			saveDocument: saveDocument as any,
		});

		await cacheLibraryRecordingDuration(recording, asset);

		expect(saveDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				assets: [expect.objectContaining({ id: asset.id, durationSec: 5 })],
			}),
			{ history: false },
		);
	});
});
