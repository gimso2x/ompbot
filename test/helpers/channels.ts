import type { ChannelPort } from "../../src/channel/port";
import { ChannelRegistry } from "../../src/channel/registry";

/** A registry holding `ports`, for code that routes its posts by conversation (approvals, lanes, tasks, host tools). */
export function registryOf(...ports: ChannelPort[]): ChannelRegistry {
	const channels = new ChannelRegistry();
	for (const port of ports) channels.register(port);
	return channels;
}
