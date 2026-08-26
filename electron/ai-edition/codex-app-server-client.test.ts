import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	CodexAppServerClient,
	type CodexAppServerProcess,
	resolveCodexExecutable,
} from "./codex-app-server-client";

class FakeCodexProcess extends EventEmitter implements CodexAppServerProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly requests: Array<Record<string, unknown>> = [];
	killed = false;

	constructor(
		private readonly respond: (request: Record<string, unknown>) => Record<string, unknown> | null,
	) {
		super();
		let buffered = "";
		this.stdin.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline === -1) break;
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (!line) continue;
				const request = JSON.parse(line) as Record<string, unknown>;
				this.requests.push(request);
				const response = this.respond(request);
				if (response) this.stdout.write(`${JSON.stringify(response)}\n`);
			}
		});
	}

	kill(): boolean {
		this.killed = true;
		this.emit("exit", 0, null);
		return true;
	}
}

function resultFor(
	request: Record<string, unknown>,
	result: unknown,
): Record<string, unknown> | null {
	if (!("id" in request)) return null;
	return { jsonrpc: "2.0", id: request.id, result };
}

describe("CodexAppServerClient", () => {
	it("honors an explicit Codex executable path for packaged app environments", () => {
		const previous = process.env.OPENSCREEN_CODEX_PATH;
		process.env.OPENSCREEN_CODEX_PATH = "/Applications/Codex/bin/codex";
		try {
			expect(resolveCodexExecutable()).toBe("/Applications/Codex/bin/codex");
		} finally {
			if (previous === undefined) delete process.env.OPENSCREEN_CODEX_PATH;
			else process.env.OPENSCREEN_CODEX_PATH = previous;
		}
	});

	it("initializes honestly as openscreen and reads a ChatGPT account", async () => {
		const process = new FakeCodexProcess((request) => {
			if (request.method === "initialize") {
				return resultFor(request, {
					userAgent: "codex_cli_rs/0.149.1",
					codexHome: "/tmp/codex",
					platformFamily: "unix",
					platformOs: "macos",
				});
			}
			if (request.method === "account/read") {
				return resultFor(request, {
					account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
					requiresOpenaiAuth: true,
				});
			}
			return null;
		});
		const client = new CodexAppServerClient({
			spawnProcess: async () => process,
			requestTimeoutMs: 1_000,
		});

		await expect(client.readAccount()).resolves.toEqual({
			available: true,
			connected: true,
			account: { email: "user@example.com", planType: "plus" },
		});
		const initialize = process.requests.find((request) => request.method === "initialize");
		expect(initialize).toMatchObject({
			params: {
				clientInfo: { name: "openscreen", title: "OpenScreen", version: "1.10.0" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		});
		expect(process.requests).toContainEqual({ jsonrpc: "2.0", method: "initialized" });
	});

	it("starts browser login and resolves only after the matching completion notification", async () => {
		const process = new FakeCodexProcess((request) => {
			if (request.method === "initialize") return resultFor(request, {});
			if (request.method === "account/login/start") {
				return resultFor(request, {
					type: "chatgpt",
					loginId: "login-1",
					authUrl: "https://auth.openai.com/oauth/authorize?client=codex",
				});
			}
			return null;
		});
		const client = new CodexAppServerClient({
			spawnProcess: async () => process,
			requestTimeoutMs: 1_000,
		});

		const login = await client.startLogin();
		expect(login).toEqual({
			loginId: "login-1",
			authUrl: "https://auth.openai.com/oauth/authorize?client=codex",
		});
		const completion = client.waitForLogin("login-1", 1_000);
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "account/login/completed",
				params: { loginId: "login-1", success: true, error: null },
			})}\n`,
		);
		await expect(completion).resolves.toEqual({ success: true, error: null });
	});

	it("rejects a non-HTTPS authentication URL", async () => {
		const process = new FakeCodexProcess((request) => {
			if (request.method === "initialize") return resultFor(request, {});
			if (request.method === "account/login/start") {
				return resultFor(request, {
					type: "chatgpt",
					loginId: "login-1",
					authUrl: "file:///tmp/fake-login.html",
				});
			}
			return null;
		});
		const client = new CodexAppServerClient({
			spawnProcess: async () => process,
			requestTimeoutMs: 1_000,
		});

		await expect(client.startLogin()).rejects.toThrow("HTTPS");
	});

	it("lists visible Codex models and terminates its child process", async () => {
		const process = new FakeCodexProcess((request) => {
			if (request.method === "initialize") return resultFor(request, {});
			if (request.method === "model/list") {
				return resultFor(request, {
					data: [
						{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false },
						{ id: "hidden", model: "hidden", hidden: true },
					],
					nextCursor: null,
				});
			}
			return null;
		});
		const client = new CodexAppServerClient({
			spawnProcess: async () => process,
			requestTimeoutMs: 1_000,
		});

		await expect(client.listModels()).resolves.toEqual(["gpt-5.6-sol"]);
		client.close();
		expect(process.killed).toBe(true);
	});

	it("round-trips a dynamic tool call during a Codex turn", async () => {
		let process: FakeCodexProcess;
		process = new FakeCodexProcess((request) => {
			if (request.method === "initialize") return resultFor(request, {});
			if (request.method === "thread/start") {
				return resultFor(request, { thread: { id: "thread-1" } });
			}
			if (request.method === "turn/start") {
				queueMicrotask(() => {
					process.stdout.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							id: "tool-call-1",
							method: "item/tool/call",
							params: {
								threadId: "thread-1",
								turnId: "turn-1",
								callId: "call-1",
								namespace: null,
								tool: "addTrim",
								arguments: { startSec: 1, endSec: 2 },
							},
						})}\n`,
					);
				});
				return resultFor(request, { turn: { id: "turn-1" } });
			}
			if (request.id === "tool-call-1" && isToolResponse(request)) {
				queueMicrotask(() => {
					process.stdout.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							method: "item/agentMessage/delta",
							params: {
								threadId: "thread-1",
								turnId: "turn-1",
								itemId: "message-1",
								delta: "Trimmed.",
							},
						})}\n`,
					);
					process.stdout.write(
						`${JSON.stringify({
							jsonrpc: "2.0",
							method: "turn/completed",
							params: {
								threadId: "thread-1",
								turn: { id: "turn-1", status: "completed", items: [] },
							},
						})}\n`,
					);
				});
			}
			return null;
		});
		const client = new CodexAppServerClient({
			spawnProcess: async () => process,
			requestTimeoutMs: 1_000,
		});

		const calls: Array<{ name: string; args: unknown }> = [];
		const result = await client.runTurn({
			model: "gpt-5.6-sol",
			systemPrompt: "Edit the video.",
			message: "Remove the pause.",
			tools: [
				{
					name: "addTrim",
					description: "Add a trim.",
					inputSchema: { type: "object" },
				},
			],
			onToolCall: async (name, args) => {
				calls.push({ name, args });
				return { success: true, resultText: '{"ok":true}' };
			},
		});

		expect(calls).toEqual([{ name: "addTrim", args: { startSec: 1, endSec: 2 } }]);
		expect(result.text).toBe("Trimmed.");
		const toolResponse = process.requests.find((request) => request.id === "tool-call-1");
		expect(toolResponse).toMatchObject({
			result: {
				success: true,
				contentItems: [{ type: "inputText", text: '{"ok":true}' }],
			},
		});
	});
});

function isToolResponse(request: Record<string, unknown>): boolean {
	return "result" in request && !("method" in request);
}
