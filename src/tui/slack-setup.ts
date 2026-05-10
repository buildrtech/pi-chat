import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { saveChatConfig } from "../config.js";
import type { ChatConfig, SlackAccountConfig } from "../core/config-types.js";
import { makeAccountKey } from "../core/keys.js";
import { refreshAccountSnapshot, updateAccountIdentityFromSnapshot, validateAccountDraft } from "../services/index.js";
import { runWithLoader, showNotice } from "./dialogs.js";

interface SlackDraft {
	name: string;
	botToken: string;
	appToken: string;
}

function ensureUniqueKey(existing: Record<string, unknown>, base: string): string {
	if (!existing[base]) return base;
	let index = 2;
	while (existing[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

function buildSlackManifest(name: string): string {
	return JSON.stringify(
		{
			display_information: {
				name,
			},
			features: {
				bot_user: {
					display_name: name,
					always_online: true,
				},
			},
			oauth_config: {
				scopes: {
					bot: [
						"app_mentions:read",
						"channels:history",
						"channels:read",
						"chat:write",
						"files:read",
						"files:write",
						"groups:history",
						"groups:read",
						"im:history",
						"im:read",
						"mpim:history",
						"mpim:read",
						"team:read",
						"users:read",
					],
				},
			},
			settings: {
				event_subscriptions: {
					bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"],
				},
				org_deploy_enabled: false,
				socket_mode_enabled: true,
				token_rotation_enabled: false,
			},
		},
		null,
		2,
	);
}

async function showSlackSetupManifest(ctx: ExtensionContext, name: string): Promise<void> {
	await showNotice(
		ctx,
		"Slack app setup",
		`Create a Slack app at https://api.slack.com/apps using this JSON manifest, install it to the workspace, then generate an app-level token with connections:write.\n\n${buildSlackManifest(name)}`,
		"info",
	);
}

async function promptSlackDraft(ctx: ExtensionContext): Promise<SlackDraft | undefined> {
	const label = await ctx.ui.input("Slack account label", "slack-bot");
	if (label === undefined) return undefined;
	const name = label.trim() || "slack-bot";
	await showSlackSetupManifest(ctx, name);
	const botToken = await ctx.ui.input("Slack bot token (xoxb-...)", "");
	if (botToken === undefined || !botToken.trim()) return undefined;
	const appToken = await ctx.ui.input("Slack app token (xapp-...)", "");
	if (appToken === undefined || !appToken.trim()) return undefined;
	return { name, botToken: botToken.trim(), appToken: appToken.trim() };
}

export async function createSlackAccountWithGuidedSetup(
	ctx: ExtensionContext,
	config: ChatConfig,
): Promise<string | undefined> {
	const draft = await promptSlackDraft(ctx);
	if (!draft) return undefined;
	const validation = await runWithLoader(ctx, "Validating Slack bot token...", () =>
		validateAccountDraft({
			service: "slack",
			botToken: draft.botToken,
			appToken: draft.appToken,
			name: draft.name,
		}),
	);
	if (validation.error) {
		await showNotice(ctx, "Slack setup error", validation.error, "error");
		return undefined;
	}
	if (!validation.value) return undefined;
	const teamId = validation.value.identity.workspaceId;
	if (!teamId) {
		await showNotice(ctx, "Slack setup error", "Slack validation did not return a workspace ID.", "error");
		return undefined;
	}
	const key = ensureUniqueKey(config.accounts, makeAccountKey("slack", draft.name || teamId));
	let account: SlackAccountConfig = {
		service: "slack",
		name: draft.name,
		botToken: draft.botToken,
		appToken: draft.appToken,
		teamId,
		teamName: validation.value.identity.workspaceName,
		channels: {},
		access: { ignoreBots: true },
	};
	const snapshot = await runWithLoader(ctx, `Discovering Slack conversations in ${account.teamName ?? teamId}...`, () =>
		refreshAccountSnapshot(key, account),
	);
	if (snapshot.error) {
		await showNotice(ctx, "Slack setup error", snapshot.error, "error");
		return undefined;
	}
	if (!snapshot.value) return undefined;
	account = updateAccountIdentityFromSnapshot(account, snapshot.value) as SlackAccountConfig;
	config.accounts[key] = account;
	await saveChatConfig(config);
	await showNotice(ctx, "Slack account created", `Created ${key}`, "info");
	return key;
}
