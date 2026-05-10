import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { ResolvedConversation, SlackAccountConfig } from "../core/config-types.js";
import type { InboundMessageInput } from "../core/runtime-types.js";
import { chunkText } from "../render/chunking.js";
import { formatMarkdownForService, maxMessageLength, normalizeSlackInboundMrkdwn } from "../render/format.js";
import { StreamingPreview } from "../render/streaming.js";
import { fetchBinary, readLocalAttachment, storeDownloadedAttachment, textMentionsBot } from "./common.js";
import type { LiveConnection, LiveConnectionHandlers } from "./types.js";

interface SlackClient {
	auth: {
		test(): Promise<{ ok?: boolean; error?: string; user?: string; user_id?: string }>;
	};
	chat: {
		postMessage(options: SlackPostMessageOptions): Promise<{ ok?: boolean; error?: string; ts?: string }>;
		update(options: { channel: string; ts: string; markdown_text?: string; text?: string }): Promise<SlackWebResult>;
		delete(options: { channel: string; ts: string }): Promise<SlackWebResult>;
	};
	conversations: {
		history(options: {
			channel: string;
			oldest?: string;
			limit?: number;
			cursor?: string;
			inclusive?: boolean;
		}): Promise<{
			ok?: boolean;
			error?: string;
			messages?: SlackMessageEvent[];
			response_metadata?: { next_cursor?: string };
		}>;
	};
	filesUploadV2(options: {
		channel_id: string;
		thread_ts?: string;
		file: Buffer | string;
		filename?: string;
		title?: string;
		initial_comment?: string;
	}): Promise<{ ok?: boolean; error?: string }>;
}

interface SlackWebResult {
	ok?: boolean;
	error?: string;
}

interface SlackPostMessageOptions {
	channel: string;
	markdown_text?: string;
	text?: string;
	thread_ts?: string;
	unfurl_links?: boolean;
	unfurl_media?: boolean;
}

interface SlackFile {
	id?: string;
	name?: string;
	title?: string;
	mimetype?: string;
	url_private_download?: string;
	url_private?: string;
}

interface SlackMessageEvent {
	type?: string;
	channel?: string;
	channel_type?: string;
	ts?: string;
	event_ts?: string;
	user?: string;
	username?: string;
	bot_id?: string;
	app_id?: string;
	text?: string;
	thread_ts?: string;
	subtype?: string;
	files?: SlackFile[];
}

interface SlackEventEnvelope {
	ack?: () => Promise<void>;
	body?: { event?: SlackMessageEvent };
	event?: SlackMessageEvent;
	retry_num?: number;
}

function slackClient(botToken: string): SlackClient {
	return new WebClient(botToken) as SlackClient;
}

function assertSlackOk(result: SlackWebResult, action: string): void {
	if (!result.ok) throw new Error(result.error || `Slack ${action} failed`);
}

async function withSlackClient(account: SlackAccountConfig): Promise<{
	web: SlackClient;
	socket: SocketModeClient;
	botUserId: string;
}> {
	const web = slackClient(account.botToken);
	const auth = await web.auth.test();
	assertSlackOk(auth, "auth.test");
	const botUserId = account.botUserId || auth.user_id;
	if (!botUserId) throw new Error("Slack auth.test did not return a bot user ID");
	const socket = new SocketModeClient({ appToken: account.appToken });
	await socket.start();
	return { web, socket, botUserId };
}

function shouldIgnoreSlackEvent(
	event: SlackMessageEvent,
	conversation: ResolvedConversation,
	botUserId: string,
): boolean {
	if (event.type !== "message" && event.type !== "app_mention") return true;
	if (!event.channel || !event.ts) return true;
	if (event.user && event.user === botUserId) return true;
	if (event.user && event.user === (conversation.account as SlackAccountConfig).botUserId) return true;
	if (event.bot_id && !conversation.access.allowedBotIds?.includes(event.bot_id)) return true;
	if (event.subtype && event.subtype !== "file_share" && !event.bot_id) return true;
	return false;
}

async function slackFileToAttachment(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	messageId: string,
	index: number,
	file: SlackFile,
): Promise<NonNullable<InboundMessageInput["attachments"]>[number] | undefined> {
	const url = file.url_private_download || file.url_private;
	if (!url) return undefined;
	const data = await fetchBinary(url, { Authorization: `Bearer ${account.botToken}` });
	const name = file.name || file.title || `slack-file-${file.id ?? index}`;
	return storeDownloadedAttachment(conversation, messageId, index, name, data, file.mimetype, url);
}

async function toInboundMessageInput(
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	botUserId: string,
	event: SlackMessageEvent,
): Promise<InboundMessageInput | undefined> {
	if (event.channel !== conversation.channel.id) return undefined;
	if (shouldIgnoreSlackEvent(event, conversation, botUserId)) return undefined;
	const messageId = event.ts ?? event.event_ts;
	if (!messageId) return undefined;
	const rawText = event.text || "";
	const attachments: NonNullable<InboundMessageInput["attachments"]> = [];
	let index = 0;
	for (const file of event.files ?? []) {
		const attachment = await slackFileToAttachment(conversation, account, messageId, ++index, file);
		if (attachment) attachments.push(attachment);
	}
	return {
		messageId,
		replyToMessageId: event.thread_ts ?? messageId,
		userId: event.user || event.username || event.channel || "unknown",
		botId: event.bot_id,
		userName: event.username,
		text: normalizeSlackInboundMrkdwn(rawText),
		mentionedBot: event.type === "app_mention" || textMentionsBot(rawText, account.botUsername, botUserId),
		isBot: Boolean(event.bot_id),
		attachments,
	};
}

async function sendSlackMessage(
	web: SlackClient,
	channelId: string,
	content: string,
	attachmentPaths: string[] = [],
	_signal?: AbortSignal,
	replyToMessageId?: string,
): Promise<string> {
	const rendered = formatMarkdownForService("slack", content);
	const chunks = chunkText(rendered.text, maxMessageLength("slack"));
	let firstMessageId: string | undefined;
	for (let i = 0; i < chunks.length; i++) {
		const result = await web.chat.postMessage({
			channel: channelId,
			markdown_text: chunks[i],
			thread_ts: i === 0 ? replyToMessageId : undefined,
			unfurl_links: false,
			unfurl_media: false,
		});
		assertSlackOk(result, "chat.postMessage");
		firstMessageId ??= result.ts;
	}
	for (const path of attachmentPaths) {
		const file = await readLocalAttachment(path);
		const result = await web.filesUploadV2({
			channel_id: channelId,
			thread_ts: replyToMessageId ?? firstMessageId,
			file: Buffer.from(file.data),
			filename: file.name,
			title: file.name,
		});
		assertSlackOk(result, "files.uploadV2");
	}
	return firstMessageId || "";
}

async function catchUpSlack(
	web: SlackClient,
	conversation: ResolvedConversation,
	account: SlackAccountConfig,
	botUserId: string,
	handlers: LiveConnectionHandlers,
	afterTs?: string,
): Promise<void> {
	const allMessages: SlackMessageEvent[] = [];
	let cursor: string | undefined;
	do {
		const result = await web.conversations.history({
			channel: conversation.channel.id,
			oldest: afterTs,
			inclusive: false,
			limit: 100,
			cursor,
		});
		assertSlackOk(result, "conversations.history");
		allMessages.push(...(result.messages ?? []));
		cursor = result.response_metadata?.next_cursor || undefined;
	} while (cursor);
	for (const message of allMessages.filter((item) => item.ts).sort((a, b) => Number(a.ts) - Number(b.ts))) {
		const event: SlackMessageEvent = { ...message, type: "message", channel: conversation.channel.id };
		const input = await toInboundMessageInput(conversation, account, botUserId, event);
		if (!input) continue;
		await handlers.onMessage(input, { messageId: input.messageId, cursor: input.messageId });
	}
}

export async function connectSlackLive(
	conversation: ResolvedConversation,
	handlers: LiveConnectionHandlers,
	lastMessageTs?: string,
): Promise<LiveConnection> {
	const account = conversation.account as SlackAccountConfig;
	const { web, socket, botUserId } = await withSlackClient(account);
	await catchUpSlack(web, conversation, account, botUserId, handlers, lastMessageTs);
	await handlers.onCaughtUp();
	const preview = new StreamingPreview(conversation.service, {
		create: async (text, _parseMode, replyToMessageId) =>
			sendSlackMessage(web, conversation.channel.id, text, [], undefined, replyToMessageId),
		edit: async (id, text) => {
			const rendered = formatMarkdownForService("slack", text);
			const result = await web.chat.update({
				channel: conversation.channel.id,
				ts: id,
				markdown_text: rendered.text,
			});
			assertSlackOk(result, "chat.update");
		},
		delete: async (id) => {
			const result = await web.chat.delete({ channel: conversation.channel.id, ts: id });
			assertSlackOk(result, "chat.delete");
		},
	});
	const onSlackEvent = (payload: SlackEventEnvelope) => {
		void (async () => {
			try {
				await payload.ack?.();
				if (payload.retry_num !== undefined) return;
				const event = payload.event || payload.body?.event;
				if (!event) return;
				const input = await toInboundMessageInput(conversation, account, botUserId, event);
				if (!input) return;
				await handlers.onMessage(input, { messageId: input.messageId, cursor: input.messageId });
			} catch (error) {
				await handlers.onError(error instanceof Error ? error : new Error(String(error)));
			}
		})();
	};
	socket.on("slack_event", onSlackEvent);
	socket.on("error", (error) => {
		void handlers.onError(error instanceof Error ? error : new Error(String(error)));
	});
	socket.on("disconnected", () => {
		void handlers.onDisconnect?.();
	});

	return {
		conversation,
		disconnect: async () => {
			socket.off("slack_event", onSlackEvent);
			await socket.disconnect();
		},
		sendImmediate: async (text, replyToMessageId) =>
			sendSlackMessage(web, conversation.channel.id, text, [], undefined, replyToMessageId),
		send: async (text, attachmentPaths = [], signal, replyToMessageId) =>
			sendSlackMessage(web, conversation.channel.id, text, attachmentPaths, signal, replyToMessageId),
		startTyping: async () => {},
		stopTyping: async () => {},
		syncPreview: async (markdown, done = false) => preview.update(markdown, done),
		clearPreview: async () => preview.clear(),
		setReplyTo: (messageId) => preview.setReplyTo(messageId),
	};
}
