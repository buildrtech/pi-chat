// Formatting adapted from Vercel Chat SDK service converters (MIT).
// Source inspiration:
// - packages/adapter-telegram/src/markdown.ts
// - packages/adapter-discord/src/markdown.ts
// - packages/adapter-slack/src/format-converter.ts

import type { ChatService } from "../core/config-types.js";

export interface RenderedChunkPayload {
	text: string;
	parseMode?: "Markdown";
}

function normalizeTelegram(markdown: string): string {
	return markdown
		.replace(/\|(.+)\|/g, (match) => (match.includes("\n") ? match : match))
		.replace(/\r\n/g, "\n")
		.trim();
}

function normalizeDiscord(markdown: string): string {
	return markdown.replace(/(?<!<)@(\w+)/g, "<@$1>").trim();
}

function normalizeSlack(markdown: string): string {
	return markdown.replace(/\r\n/g, "\n").trim();
}

export function normalizeSlackInboundMrkdwn(text: string): string {
	return text
		.replace(/<@([A-Z0-9]+)>/g, "@$1")
		.replace(/<#([A-Z0-9]+)\|([^>]+)>/g, "#$2")
		.replace(/<([^>|]+)\|([^>]+)>/g, "[$2]($1)")
		.replace(/<([^>]+)>/g, "$1")
		.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1**$2**")
		.trim();
}

export function formatMarkdownForService(service: ChatService, markdown: string): RenderedChunkPayload {
	if (service === "telegram") return { text: normalizeTelegram(markdown), parseMode: "Markdown" };
	if (service === "slack") return { text: normalizeSlack(markdown) };
	return { text: normalizeDiscord(markdown) };
}

export function maxMessageLength(service: ChatService): number {
	if (service === "telegram") return 4096;
	if (service === "slack") return 12000;
	return 2000;
}
