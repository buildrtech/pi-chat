import { WebClient } from "@slack/web-api";

import type { SlackAccountConfig } from "../core/config-types.js";
import type {
	AccountValidationResult,
	DiscoveredChannel,
	DiscoveredUser,
	DiscoverySnapshot,
} from "../core/discovery-types.js";
import type { AccountDraft, DiscoveryProvider } from "./types.js";

interface SlackClient {
	auth: {
		test(): Promise<{
			ok?: boolean;
			error?: string;
			team?: string;
			team_id?: string;
			user?: string;
			user_id?: string;
			bot_id?: string;
		}>;
	};
	team: {
		info(options?: { team?: string }): Promise<{
			ok?: boolean;
			error?: string;
			team?: { id?: string; name?: string };
		}>;
	};
	conversations: {
		list(options: { exclude_archived?: boolean; limit?: number; cursor?: string; types?: string }): Promise<{
			ok?: boolean;
			error?: string;
			channels?: SlackConversation[];
			response_metadata?: { next_cursor?: string };
		}>;
	};
	users: {
		list(options: { limit?: number; cursor?: string }): Promise<{
			ok?: boolean;
			error?: string;
			members?: SlackUser[];
			response_metadata?: { next_cursor?: string };
		}>;
	};
}

interface SlackConversation {
	id?: string;
	is_archived?: boolean;
	is_im?: boolean;
	is_mpim?: boolean;
	is_private?: boolean;
	name?: string;
	user?: string;
}

interface SlackUser {
	id?: string;
	deleted?: boolean;
	is_bot?: boolean;
	name?: string;
	real_name?: string;
	profile?: {
		bot_id?: string;
		display_name?: string;
		real_name?: string;
	};
}

function slackClient(botToken: string): SlackClient {
	return new WebClient(botToken) as SlackClient;
}

function assertSlackOk(result: { ok?: boolean; error?: string }, action: string): void {
	if (!result.ok) throw new Error(result.error || `Slack ${action} failed`);
}

function conversationName(conversation: SlackConversation, users: Map<string, DiscoveredUser>): string {
	if (conversation.is_im) {
		const user = conversation.user ? users.get(conversation.user) : undefined;
		return user ? `DM: ${user.displayName || user.name}` : `DM: ${conversation.user ?? conversation.id}`;
	}
	const prefix = conversation.is_private ? "private" : conversation.is_mpim ? "mpim" : "channel";
	return conversation.name ? `#${conversation.name}` : `${prefix}:${conversation.id}`;
}

async function listSlackUsers(client: SlackClient): Promise<DiscoveredUser[]> {
	const users: DiscoveredUser[] = [];
	let cursor: string | undefined;
	do {
		const result = await client.users.list({ limit: 200, cursor });
		assertSlackOk(result, "users.list");
		for (const user of result.members ?? []) {
			if (!user.id || user.deleted) continue;
			const name = user.name || user.profile?.real_name || user.real_name || user.id;
			const displayName = user.profile?.display_name || user.profile?.real_name || user.real_name || name;
			users.push({
				id: user.id,
				name,
				displayName,
				isBot: user.is_bot,
				botId: user.profile?.bot_id,
			});
		}
		cursor = result.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return users.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
}

async function listSlackConversationsByType(client: SlackClient, users: Map<string, DiscoveredUser>, type: string) {
	const channels: DiscoveredChannel[] = [];
	let cursor: string | undefined;
	do {
		const result = await client.conversations.list({
			exclude_archived: true,
			limit: 200,
			cursor,
			types: type,
		});
		assertSlackOk(result, "conversations.list");
		for (const channel of result.channels ?? []) {
			if (!channel.id || channel.is_archived) continue;
			channels.push({
				id: channel.id,
				name: conversationName(channel, users),
				dm: channel.is_im || channel.is_mpim,
			});
		}
		cursor = result.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return channels;
}

async function listSlackChannels(
	client: SlackClient,
	users: Map<string, DiscoveredUser>,
): Promise<DiscoveredChannel[]> {
	const channels: DiscoveredChannel[] = [];
	for (const type of ["public_channel", "private_channel", "im", "mpim"]) {
		channels.push(...(await listSlackConversationsByType(client, users, type)));
	}
	return channels.sort((a, b) => a.name.localeCompare(b.name));
}

async function validateSlackBot(botToken: string): Promise<AccountValidationResult> {
	const client = slackClient(botToken);
	const auth = await client.auth.test();
	assertSlackOk(auth, "auth.test");
	if (!auth.user_id) throw new Error("Slack auth.test did not return a bot user ID");
	const team = await client.team.info(auth.team_id ? { team: auth.team_id } : undefined);
	assertSlackOk(team, "team.info");
	const teamId = team.team?.id || auth.team_id;
	const teamName = team.team?.name || auth.team;
	return {
		identity: {
			id: auth.user_id,
			name: auth.user || auth.user_id,
			userName: auth.user,
			workspaceId: teamId,
			workspaceName: teamName,
		},
		warnings: undefined,
	};
}

export const slackDiscoveryProvider: DiscoveryProvider = {
	service: "slack",
	async validate(draft: AccountDraft): Promise<AccountValidationResult> {
		if (!draft.botToken.startsWith("xoxb-")) throw new Error("Slack bot token should start with xoxb-");
		if (draft.appToken && !draft.appToken.startsWith("xapp-"))
			throw new Error("Slack app token should start with xapp-");
		return validateSlackBot(draft.botToken);
	},
	async fetchSnapshot(accountId: string, account: SlackAccountConfig): Promise<DiscoverySnapshot> {
		const client = slackClient(account.botToken);
		const validation = await validateSlackBot(account.botToken);
		const users = await listSlackUsers(client);
		const userMap = new Map(users.map((user) => [user.id, user]));
		const channels = await listSlackChannels(client, userMap);
		return {
			accountId,
			service: "slack",
			fetchedAt: new Date().toISOString(),
			identity: {
				...validation.identity,
				workspaceId: validation.identity.workspaceId || account.teamId,
				workspaceName: validation.identity.workspaceName || account.teamName,
			},
			channels,
			users,
			roles: [],
			warnings: validation.warnings,
			capabilities: {
				canListChannels: channels.length > 0,
				canListUsers: users.length > 0,
				canListRoles: false,
			},
		};
	},
};
