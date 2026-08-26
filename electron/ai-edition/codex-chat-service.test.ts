import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type { CodexAppServerClient } from "./codex-app-server-client";
import { invokeCodexOpenScreenAgent } from "./codex-chat-service";

function fixtureDocument() {
	const base = createEmptyDocument({
		title: "Test",
		projectId: "proj_1",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "/tmp/recording.mp4",
				durationSec: 30,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

describe("invokeCodexOpenScreenAgent", () => {
	it("exposes the existing tools and applies a Codex dynamic tool call", async () => {
		const toolEnd = vi.fn();
		const runner: Pick<CodexAppServerClient, "runTurn"> = {
			runTurn: async (options) => {
				expect(options.tools.map((tool) => tool.name)).toContain("addTrim");
				const applied = await options.onToolCall("addTrim", {
					startSec: 5,
					endSec: 7,
					clipId: "clip_1",
					reason: "pause",
				});
				expect(applied.success).toBe(true);
				expect(JSON.parse(applied.resultText)).not.toHaveProperty("error");
				return { text: "Removed the pause.", threadId: "thread-1", turnId: "turn-1" };
			},
		};

		const result = await invokeCodexOpenScreenAgent({
			document: fixtureDocument(),
			client: runner,
			model: "gpt-5.6-sol",
			history: [],
			userMessage: "Remove the pause.",
			sink: {
				text: vi.fn(),
				thinking: vi.fn(),
				toolStart: vi.fn(),
				toolEnd,
				error: vi.fn(),
			},
		});

		expect(result.text).toBe("Removed the pause.");
		expect(result.mutated).toBe(true);
		expect(result.document.timeline.trimRanges).toHaveLength(1);
		expect(toolEnd).toHaveBeenCalledWith("addTrim", true, expect.any(String));
	});
});
