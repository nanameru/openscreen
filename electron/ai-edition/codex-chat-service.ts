import { zodToJsonSchema } from "zod-to-json-schema";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import type { CodexAppServerClient } from "./codex-app-server-client";
import {
	buildSystemPrompt,
	buildTools,
	type CursorTelemetryReader,
	type InvokeResult,
	type OpenScreenAgentSink,
	probeCursorTelemetry,
} from "./deep-agent/service";

export interface InvokeCodexAgentArgs {
	document: AxcutDocument;
	client: Pick<CodexAppServerClient, "runTurn">;
	model: string;
	reasoningEffort?: string;
	history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	userMessage: string;
	sink: OpenScreenAgentSink;
	editsAllowed?: boolean;
	cursor?: CursorTelemetryReader;
}

function formatConversation(history: InvokeCodexAgentArgs["history"], userMessage: string): string {
	const prior = history
		.slice(0, -1)
		.map((message) => `${message.role.toUpperCase()}: ${message.content}`)
		.join("\n\n");
	if (!prior) return userMessage;
	return `Conversation so far:\n\n${prior}\n\nCURRENT USER REQUEST:\n${userMessage}`;
}

function codexEffort(value: string | undefined): string | undefined {
	if (!value || value === "none") return undefined;
	return value;
}

function toolInputSchema(schema: unknown): Record<string, unknown> {
	const candidate = schema as { toJSONSchema?: () => unknown };
	if (typeof candidate.toJSONSchema === "function") {
		return candidate.toJSONSchema() as Record<string, unknown>;
	}
	// LangChain still exposes one transformed Zod 3 schema alongside its Zod 4
	// tools. Keep the compatibility converter scoped to that legacy shape.
	return zodToJsonSchema(schema as never) as Record<string, unknown>;
}

/**
 * Runs the existing OpenScreen editing tools through Codex app-server.
 * Tool definitions, validation, consent checks, cursor IO, and document
 * mutation all remain owned by the same `buildTools` path as API providers.
 */
export async function invokeCodexOpenScreenAgent(
	args: InvokeCodexAgentArgs,
): Promise<InvokeResult> {
	const editsAllowed = args.editsAllowed !== false;
	const holder = { current: args.document };
	const initialDocumentJson = JSON.stringify(args.document);
	const availableByAssetId = await probeCursorTelemetry(args.document, args.cursor);
	const tools = buildTools(holder, args.sink, editsAllowed, {
		cursor: args.cursor,
		availableByAssetId,
	});
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

	try {
		const result = await args.client.runTurn({
			model: args.model,
			effort: codexEffort(args.reasoningEffort),
			systemPrompt: buildSystemPrompt({ editsAllowed }),
			message: formatConversation(args.history, args.userMessage),
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: toolInputSchema(tool.schema),
			})),
			onToolCall: async (name, toolArgs) => {
				const selected = toolsByName.get(name);
				if (!selected) {
					return {
						success: false,
						resultText: JSON.stringify({ error: `Unknown OpenScreen tool: ${name}` }),
					};
				}
				const output = await (selected as { invoke: (args: unknown) => Promise<unknown> }).invoke(
					toolArgs,
				);
				return {
					success: true,
					resultText: typeof output === "string" ? output : JSON.stringify(output),
				};
			},
			onText: args.sink.text,
			onThinking: args.sink.thinking,
		});
		const mutated = JSON.stringify(holder.current) !== initialDocumentJson;
		if (!result.text) {
			return {
				text: "",
				document: holder.current,
				mutated,
				reason: "Codex completed without an assistant message.",
			};
		}
		return { text: result.text, document: holder.current, mutated };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		args.sink.error(reason);
		return {
			text: "",
			document: holder.current,
			mutated: JSON.stringify(holder.current) !== initialDocumentJson,
			reason,
		};
	}
}
