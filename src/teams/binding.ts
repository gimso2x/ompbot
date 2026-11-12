// Teams' plug into the daemon: its port (Bot Connector), and its adapter serving the Bot Framework endpoint, built
// from `channels.teams`. Teams resends nothing the daemon missed, so there is no recovery and no thread reader.
import type { AdapterDeps, ChannelAdapter, ChannelBinding } from "../channel/adapter";
import { parseLoopbackListen } from "../config";
import { TeamsAdapter } from "./adapter";
import { TeamsAuth } from "./auth";
import type { TeamsChannel } from "./channel";

export interface TeamsBindingOptions {
	/** Inbound token checks; default: the real Bot Framework and Entra metadata. */
	auth?: TeamsAuth;
	/** Overrides `channels.teams.listen` (tests bind port 0). */
	listen?: { hostname: string; port: number };
	/** Turn length before the `⏳ 작업 중` line. */
	longTurnMs?: number;
}

export class TeamsBinding implements ChannelBinding {
	readonly port: TeamsChannel;
	readonly #options: TeamsBindingOptions;
	/** The adapter `createAdapter` built (its bound port, for tests that listen on port 0). */
	adapter: TeamsAdapter | undefined;

	constructor(port: TeamsChannel, options: TeamsBindingOptions = {}) {
		this.port = port;
		this.#options = options;
	}

	createAdapter(deps: AdapterDeps): ChannelAdapter {
		const teams = deps.config.channels.teams;
		if (teams === undefined) throw new Error("teams binding without channels.teams");
		const listen = this.#options.listen ?? parseLoopbackListen(teams.listen);
		if (listen === undefined) throw new Error(`channels.teams.listen is not a loopback host:port: ${teams.listen}`);
		this.port.useConversations(deps.store);
		this.adapter = new TeamsAdapter({
			channel: this.port,
			conversations: deps.store,
			core: deps.core,
			deliveries: deps.deliveries,
			tenantId: teams.tenantId,
			ownerAadObjectId: teams.ownerAadObjectId,
			guestAadObjectIds: teams.guestAadObjectIds ?? [],
			ownerMode: teams.ownerMode ?? "full",
			clock: deps.clock,
			log: deps.log,
			listen: {
				...listen,
				auth: this.#options.auth ?? new TeamsAuth({ appId: teams.appId, tenantId: teams.tenantId }),
			},
			longTurnMs: this.#options.longTurnMs,
		});
		return this.adapter;
	}
}
