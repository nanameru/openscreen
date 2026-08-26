import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "../../ai-edition/codex-app-server-client";
import type { LlmConfig, LlmConfigStore } from "../../ai-edition/llm-config-store";
import { AiEditionService, type AiEditionServiceOptions } from "./aiEditionService";

function harness(
	statuses: Array<{
		available: boolean;
		connected: boolean;
		account?: { email: string; planType: string };
	}>,
) {
	let config: LlmConfig | null = null;
	const store = {
		getConfig: () => config,
		setConfig: async (next: LlmConfig) => {
			config = next;
		},
		getCredential: () => null,
		removeCredential: vi.fn(),
	} as unknown as LlmConfigStore;
	let readIndex = 0;
	const client = {
		readAccount: async () => statuses[Math.min(readIndex++, statuses.length - 1)],
		startLogin: async () => ({ loginId: "login-1", authUrl: "https://auth.openai.com/codex" }),
		waitForLogin: async () => ({ success: true, error: null }),
		listModels: async () => ["gpt-5.6-sol"],
	} as unknown as CodexAppServerClient;
	const openExternal = vi.fn(async () => undefined);
	const service = new AiEditionService({
		documents: { listProjects: async () => [] },
		llmConfig: () => store,
		codexClient: () => client,
		openExternal,
	} as unknown as AiEditionServiceOptions);
	return { service, openExternal, getConfig: () => config };
}

describe("AiEditionService Codex connection", () => {
	it("reports Codex account state without exposing a token", async () => {
		const { service } = harness([
			{
				available: true,
				connected: true,
				account: { email: "user@example.com", planType: "plus" },
			},
		]);
		const snapshot = await service.llmGetSnapshot();
		expect(snapshot.connectedProviders).toContain("codex");
		expect(snapshot.codex).toMatchObject({
			available: true,
			connected: true,
			email: "user@example.com",
			planType: "plus",
		});
		expect(snapshot.credentialSummary.find((row) => row.providerId === "codex")).toMatchObject({
			credentialKind: "codex",
		});
	});

	it("opens the HTTPS Codex login URL and selects Codex after completion", async () => {
		const { service, openExternal, getConfig } = harness([
			{ available: true, connected: false },
			{ available: true, connected: true, account: { email: "user@example.com", planType: "pro" } },
		]);
		const result = await service.llmConnectCodex();
		expect(result.success).toBe(true);
		expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/codex");
		expect(getConfig()).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
	});
});
