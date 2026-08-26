import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface CodexAppServerProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "spawn", listener: () => void): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	once(event: "spawn", listener: () => void): this;
	kill(signal?: NodeJS.Signals): boolean;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id: number | string;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
	jsonrpc?: string;
	method: string;
	params?: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface CodexAccountStatus {
	available: boolean;
	connected: boolean;
	account?: { email: string | null; planType: string };
	error?: string;
}

export interface CodexLoginStart {
	loginId: string;
	authUrl: string;
}

export interface CodexLoginCompletion {
	success: boolean;
	error: string | null;
}

export interface CodexAppServerClientOptions {
	spawnProcess?: () => Promise<CodexAppServerProcess>;
	requestTimeoutMs?: number;
	clientVersion?: string;
}

export interface CodexDynamicTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface CodexDynamicToolResult {
	success: boolean;
	resultText: string;
}

export interface CodexRunTurnOptions {
	model: string;
	effort?: string;
	systemPrompt: string;
	message: string;
	tools: CodexDynamicTool[];
	onToolCall: (name: string, args: unknown) => Promise<CodexDynamicToolResult>;
	onText?: (delta: string) => void;
	onThinking?: (delta: string) => void;
	turnTimeoutMs?: number;
}

export interface CodexRunTurnResult {
	text: string;
	threadId: string;
	turnId: string;
}

interface ActiveTurn {
	turnId: string | null;
	text: string;
	onToolCall: CodexRunTurnOptions["onToolCall"];
	onText: (delta: string) => void;
	onThinking: (delta: string) => void;
	resolve: (value: CodexRunTurnResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function resolveCodexExecutable(): string {
	const override = process.env.OPENSCREEN_CODEX_PATH?.trim();
	if (override) return override;
	const executable = process.platform === "win32" ? "codex.exe" : "codex";
	const pathCandidates = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.map((directory) => path.join(directory, executable));
	const home = os.homedir();
	const candidates = [
		...pathCandidates,
		path.join(home, ".local", "bin", executable),
		path.join(home, ".codex", "bin", executable),
		...(process.platform === "darwin" ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] : []),
		...(process.platform === "win32" && process.env.APPDATA
			? [path.join(process.env.APPDATA, "npm", "codex.cmd")]
			: []),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? "codex";
}

function spawnDefaultCodexProcess(): Promise<CodexAppServerProcess> {
	return new Promise((resolve, reject) => {
		const command = resolveCodexExecutable();
		const child = spawn(command, ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const fail = (error: Error) => reject(error);
		child.once("error", fail);
		child.once("spawn", () => {
			child.removeListener("error", fail);
			resolve(child);
		});
	});
}

function messageFromUnknown(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertHttpsUrl(value: unknown): string {
	if (typeof value !== "string") throw new Error("Codex did not return an authentication URL.");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Codex returned an invalid authentication URL.");
	}
	if (parsed.protocol !== "https:") {
		throw new Error("Codex authentication URL must use HTTPS.");
	}
	return parsed.toString();
}

/**
 * Thin JSON-RPC client for the official `codex app-server --stdio` process.
 *
 * OpenScreen never reads Codex's auth files or tokens. Authentication state,
 * refresh, and browser login stay owned by the Codex process.
 */
export class CodexAppServerClient {
	private readonly spawnProcess: () => Promise<CodexAppServerProcess>;
	private readonly requestTimeoutMs: number;
	private readonly clientVersion: string;
	private process: CodexAppServerProcess | null = null;
	private starting: Promise<void> | null = null;
	private nextRequestId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private readonly loginCompletions = new Map<string, CodexLoginCompletion>();
	private readonly loginWaiters = new Map<
		string,
		Array<(completion: CodexLoginCompletion) => void>
	>();
	private readonly activeTurns = new Map<string, ActiveTurn>();
	private stderrTail = "";

	constructor(options: CodexAppServerClientOptions = {}) {
		this.spawnProcess = options.spawnProcess ?? spawnDefaultCodexProcess;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.clientVersion = options.clientVersion ?? "1.10.0";
	}

	async readAccount(): Promise<CodexAccountStatus> {
		try {
			const response = await this.request("account/read", { refreshToken: false });
			if (!isRecord(response)) throw new Error("Codex returned an invalid account response.");
			const account = response.account;
			if (!isRecord(account) || account.type !== "chatgpt") {
				return { available: true, connected: false };
			}
			return {
				available: true,
				connected: true,
				account: {
					email: typeof account.email === "string" ? account.email : null,
					planType: typeof account.planType === "string" ? account.planType : "unknown",
				},
			};
		} catch (error) {
			return {
				available: false,
				connected: false,
				error: messageFromUnknown(error),
			};
		}
	}

	async startLogin(): Promise<CodexLoginStart> {
		const response = await this.request("account/login/start", {
			type: "chatgpt",
			codexStreamlinedLogin: true,
			useHostedLoginSuccessPage: true,
			appBrand: "codex",
		});
		if (!isRecord(response) || response.type !== "chatgpt") {
			throw new Error("Codex did not start ChatGPT login.");
		}
		if (typeof response.loginId !== "string" || !response.loginId) {
			throw new Error("Codex did not return a login id.");
		}
		return {
			loginId: response.loginId,
			authUrl: assertHttpsUrl(response.authUrl),
		};
	}

	waitForLogin(loginId: string, timeoutMs = 5 * 60_000): Promise<CodexLoginCompletion> {
		const completed = this.loginCompletions.get(loginId);
		if (completed) return Promise.resolve(completed);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const waiters = this.loginWaiters.get(loginId) ?? [];
				this.loginWaiters.set(
					loginId,
					waiters.filter((waiter) => waiter !== finish),
				);
				reject(new Error("Timed out waiting for Codex login."));
			}, timeoutMs);
			const finish = (completion: CodexLoginCompletion) => {
				clearTimeout(timer);
				resolve(completion);
			};
			const waiters = this.loginWaiters.get(loginId) ?? [];
			waiters.push(finish);
			this.loginWaiters.set(loginId, waiters);
		});
	}

	async listModels(): Promise<string[]> {
		const models: string[] = [];
		let cursor: string | null = null;
		do {
			const response = await this.request("model/list", {
				cursor,
				limit: 100,
				includeHidden: false,
			});
			if (!isRecord(response) || !Array.isArray(response.data)) {
				throw new Error("Codex returned an invalid model list.");
			}
			for (const item of response.data) {
				if (!isRecord(item) || item.hidden === true) continue;
				const model =
					typeof item.model === "string"
						? item.model
						: typeof item.id === "string"
							? item.id
							: null;
				if (model) models.push(model);
			}
			cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
		} while (cursor);
		return [...new Set(models)];
	}

	async runTurn(options: CodexRunTurnOptions): Promise<CodexRunTurnResult> {
		await this.ensureStarted();
		const threadResponse = await this.requestWithoutStart("thread/start", {
			model: options.model || null,
			cwd: process.cwd(),
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: options.systemPrompt,
			developerInstructions:
				"You are embedded in OpenScreen. Use only the dynamic video-editing tools provided by the host. Do not use shell, filesystem, network, MCP, apps, or collaboration tools.",
			ephemeral: true,
			config: { tools: { web_search: false } },
			dynamicTools: options.tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			})),
		});
		if (!isRecord(threadResponse) || !isRecord(threadResponse.thread)) {
			throw new Error("Codex did not create a thread.");
		}
		const threadId = threadResponse.thread.id;
		if (typeof threadId !== "string" || !threadId) {
			throw new Error("Codex returned an invalid thread id.");
		}

		const completion = new Promise<CodexRunTurnResult>((resolve, reject) => {
			const timer = setTimeout(
				() => {
					const turnId = this.activeTurns.get(threadId)?.turnId ?? undefined;
					this.activeTurns.delete(threadId);
					void this.requestWithoutStart("turn/interrupt", {
						threadId,
						turnId,
					}).catch(() => undefined);
					reject(new Error("Timed out waiting for Codex turn."));
				},
				options.turnTimeoutMs ?? 10 * 60_000,
			);
			this.activeTurns.set(threadId, {
				turnId: null,
				text: "",
				onToolCall: options.onToolCall,
				onText: options.onText ?? (() => undefined),
				onThinking: options.onThinking ?? (() => undefined),
				resolve,
				reject,
				timer,
			});
		});

		try {
			const turnResponse = await this.requestWithoutStart("turn/start", {
				threadId,
				input: [{ type: "text", text: options.message, text_elements: [] }],
				effort: options.effort || null,
			});
			if (isRecord(turnResponse) && isRecord(turnResponse.turn)) {
				const active = this.activeTurns.get(threadId);
				if (active && typeof turnResponse.turn.id === "string") {
					active.turnId = turnResponse.turn.id;
				}
			}
			return await completion;
		} catch (error) {
			const active = this.activeTurns.get(threadId);
			if (active) clearTimeout(active.timer);
			this.activeTurns.delete(threadId);
			throw error;
		}
	}

	close(): void {
		const child = this.process;
		this.process = null;
		this.starting = null;
		this.rejectPending(new Error("Codex app-server was closed."));
		this.rejectActiveTurns(new Error("Codex app-server was closed."));
		if (child) child.kill();
	}

	private async ensureStarted(): Promise<void> {
		if (this.process) return;
		if (this.starting) return this.starting;
		this.starting = this.start().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async start(): Promise<void> {
		const child = await this.spawnProcess();
		this.process = child;
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => this.handleLine(line));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4_000);
		});
		child.on("error", (error) => this.handleProcessEnd(error));
		child.on("exit", (code, signal) => {
			this.handleProcessEnd(
				new Error(
					`Codex app-server exited (${code ?? "null"}${signal ? `, ${signal}` : ""}).${
						this.stderrTail ? ` ${this.stderrTail.trim()}` : ""
					}`,
				),
			);
		});

		await this.requestWithoutStart("initialize", {
			clientInfo: { name: "openscreen", title: "OpenScreen", version: this.clientVersion },
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
			},
		});
		this.notify("initialized");
	}

	private async request(method: string, params?: unknown): Promise<unknown> {
		await this.ensureStarted();
		return this.requestWithoutStart(method, params);
	}

	private requestWithoutStart(method: string, params?: unknown): Promise<unknown> {
		const child = this.process;
		if (!child) return Promise.reject(new Error("Codex app-server is not running."));
		const id = this.nextRequestId++;
		const request: JsonRpcRequest = { jsonrpc: "2.0", id, method };
		if (params !== undefined) request.params = params;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex request timed out: ${method}`));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify(request)}\n`);
		});
	}

	private notify(method: string, params?: unknown): void {
		const child = this.process;
		if (!child) return;
		const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) notification.params = params;
		child.stdin.write(`${JSON.stringify(notification)}\n`);
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		if ((typeof message.id === "number" || typeof message.id === "string") && !message.method) {
			this.handleResponse(message as unknown as JsonRpcResponse);
			return;
		}
		if (
			(typeof message.id === "number" || typeof message.id === "string") &&
			typeof message.method === "string"
		) {
			void this.handleServerRequest(
				message as unknown as JsonRpcNotification & { id: number | string },
			);
			return;
		}
		if (typeof message.method === "string") {
			this.handleNotification(message as unknown as JsonRpcNotification);
		}
	}

	private handleResponse(response: JsonRpcResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.pending.delete(response.id);
		clearTimeout(pending.timer);
		if (response.error) {
			pending.reject(
				new Error(
					response.error.message ||
						`Codex request failed with code ${response.error.code ?? "unknown"}.`,
				),
			);
			return;
		}
		pending.resolve(response.result);
	}

	private handleNotification(notification: JsonRpcNotification): void {
		if (notification.method === "item/agentMessage/delta" && isRecord(notification.params)) {
			const threadId = notification.params.threadId;
			const delta = notification.params.delta;
			if (typeof threadId === "string" && typeof delta === "string") {
				const active = this.activeTurns.get(threadId);
				if (active) {
					active.text += delta;
					active.onText(delta);
				}
			}
			return;
		}
		if (
			(notification.method === "item/reasoning/textDelta" ||
				notification.method === "item/reasoning/summaryTextDelta") &&
			isRecord(notification.params)
		) {
			const threadId = notification.params.threadId;
			const delta = notification.params.delta;
			if (typeof threadId === "string" && typeof delta === "string") {
				this.activeTurns.get(threadId)?.onThinking(delta);
			}
			return;
		}
		if (notification.method === "turn/completed" && isRecord(notification.params)) {
			this.completeTurn(notification.params);
			return;
		}
		if (notification.method !== "account/login/completed" || !isRecord(notification.params)) {
			return;
		}
		const loginId = notification.params.loginId;
		if (typeof loginId !== "string") return;
		const completion: CodexLoginCompletion = {
			success: notification.params.success === true,
			error: typeof notification.params.error === "string" ? notification.params.error : null,
		};
		this.loginCompletions.set(loginId, completion);
		const waiters = this.loginWaiters.get(loginId) ?? [];
		this.loginWaiters.delete(loginId);
		for (const waiter of waiters) waiter(completion);
	}

	private async handleServerRequest(
		request: JsonRpcNotification & { id: number | string },
	): Promise<void> {
		if (request.method !== "item/tool/call" || !isRecord(request.params)) {
			this.respondToServerRequest(request.id, undefined, {
				code: -32601,
				message: `Unsupported Codex server request: ${request.method}`,
			});
			return;
		}
		const threadId = request.params.threadId;
		const tool = request.params.tool;
		if (typeof threadId !== "string" || typeof tool !== "string") {
			this.respondToServerRequest(request.id, undefined, {
				code: -32602,
				message: "Invalid dynamic tool call.",
			});
			return;
		}
		const active = this.activeTurns.get(threadId);
		if (!active) {
			this.respondToServerRequest(request.id, undefined, {
				code: -32000,
				message: "No active OpenScreen turn for this tool call.",
			});
			return;
		}
		try {
			const result = await active.onToolCall(tool, request.params.arguments);
			this.respondToServerRequest(request.id, {
				contentItems: [{ type: "inputText", text: result.resultText }],
				success: result.success,
			});
		} catch (error) {
			this.respondToServerRequest(request.id, {
				contentItems: [
					{ type: "inputText", text: JSON.stringify({ error: messageFromUnknown(error) }) },
				],
				success: false,
			});
		}
	}

	private respondToServerRequest(
		id: number | string,
		result?: unknown,
		error?: { code: number; message: string },
	): void {
		const child = this.process;
		if (!child) return;
		const response = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
		child.stdin.write(`${JSON.stringify(response)}\n`);
	}

	private completeTurn(params: Record<string, unknown>): void {
		const threadId = params.threadId;
		if (typeof threadId !== "string") return;
		const active = this.activeTurns.get(threadId);
		if (!active) return;
		this.activeTurns.delete(threadId);
		clearTimeout(active.timer);
		const turn = isRecord(params.turn) ? params.turn : null;
		const turnId = turn && typeof turn.id === "string" ? turn.id : active.turnId;
		if (turn && turn.status === "failed") {
			const error =
				isRecord(turn.error) && typeof turn.error.message === "string"
					? turn.error.message
					: "Codex turn failed.";
			active.reject(new Error(error));
			return;
		}
		let text = active.text;
		if (!text && turn && Array.isArray(turn.items)) {
			const messages = turn.items.filter(
				(item): item is Record<string, unknown> => isRecord(item) && item.type === "agentMessage",
			);
			const final = messages.at(-1);
			if (final && typeof final.text === "string") text = final.text;
		}
		if (!turnId) {
			active.reject(new Error("Codex completed without a turn id."));
			return;
		}
		active.resolve({ text: text.trim(), threadId, turnId });
	}

	private handleProcessEnd(error: Error): void {
		this.process = null;
		this.rejectPending(error);
		this.rejectActiveTurns(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private rejectActiveTurns(error: Error): void {
		for (const active of this.activeTurns.values()) {
			clearTimeout(active.timer);
			active.reject(error);
		}
		this.activeTurns.clear();
	}
}
