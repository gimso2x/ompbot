import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Server } from "bun";
import { loadConfig } from "../config";
import type { LiveView } from "../core/live-turn";
import { callDaemon } from "../daemon/ipc";
import { readMonitorDetail } from "../dashboard/monitor-detail";
import { startDashboardServer } from "../dashboard/server";
import { readBoardPrompts, readBoardTasks } from "../dashboard/snapshot";
import { boardSourceFor, hasConfig, snapshotReader } from "../dashboard/snapshot-assembly";
import { readThreadConversation } from "../dashboard/thread-conversation";
import { readTurnTrace } from "../dashboard/trace";
import { realProcessRunner } from "../dispatch/omp";
import { redact } from "../redact";
import { indexEnvSecrets } from "../safety/secret-index";
import { hostTimezone } from "../time";

export const DASHBOARD_USAGE = `  dashboard [--port <n>] [--bind 127.0.0.1|::1]
                                 read-only status page on a loopback port until SIGTERM: HTML at /, JSON at
                                 /api/snapshot, a turn's waterfall at /api/turn/<id>/trace, a monitor's masked
                                 instruction and runs at /api/monitor/detail?id=<id>, a conversation's
                                 masked omp session at /api/thread/conversation?origin=<key>, what its running turn
                                 is writing at /api/thread/live?origin=<key> (stream: /api/thread/live/events) (also
                                 under a prefix like /task/); --port/--bind override config
                                 dashboard {port, bind?, herdrWebUrl?}; no port in either → exit 2. With config
                                 herdrBoard it also shows the herdr agent board (api/board, api/board/events,
                                 ?card=<key> detail with the pane's conversation and plan)
`;

const LOOPBACK = ["127.0.0.1", "::1"] as const;

export { boardSourceFor };

function usage(message: string): number {
	process.stderr.write(`dashboard: ${message}\n${DASHBOARD_USAGE}`);
	return 2;
}

/**
 * `ompbot dashboard`: a process of its own beside the daemon (it still answers "daemon down"). Reads config.json
 * without touching the token files, seeds the redaction value index from the environment and guard files, opens the
 * database read-only per snapshot, and serves until SIGTERM/SIGINT.
 */
export async function dashboardCommand(args: string[], homeDir: string): Promise<number> {
	let values: { port?: string; bind?: string };
	try {
		({ values } = parseArgs({ args, options: { port: { type: "string" }, bind: { type: "string" } } }));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
	if (values.port !== undefined && !/^\d{1,5}$/.test(values.port)) return usage("--port must be 1-65535");
	const flagPort = values.port === undefined ? undefined : Number(values.port);
	if (flagPort !== undefined && (flagPort < 1 || flagPort > 65535)) return usage("--port must be 1-65535");
	const flagBind = values.bind;
	if (flagBind !== undefined && !(LOOPBACK as readonly string[]).includes(flagBind)) {
		return usage("--bind must be 127.0.0.1 or ::1");
	}

	const config = hasConfig(homeDir) ? loadConfig(homeDir, { checkTokens: false }) : undefined;
	const port = flagPort ?? config?.dashboard?.port;
	if (port === undefined) return usage("no port: pass --port or set config dashboard.port");
	const hostname = flagBind ?? config?.dashboard?.bind ?? "127.0.0.1";
	// Value masking like the daemon's, minus the Slack token files this process does not read.
	indexEnvSecrets(process.env);

	const now = () => Date.now();
	const board = boardSourceFor(config, homeDir);
	const snapshot = snapshotReader({
		homeDir,
		config,
		now,
		callDaemon,
		run: realProcessRunner,
		...(board === undefined ? {} : { board: () => board.current() }),
	});

	let server: Server<undefined>;
	try {
		server = startDashboardServer({
			port,
			hostname,
			snapshot,
			trace: (inboundId) => readTurnTrace(homeDir, inboundId, now()),
			conversation: (origin, before) => readThreadConversation(homeDir, origin, before),
			// The daemon's procedure file roots (MonitorScheduler in daemon.ts).
			monitorDetail: (id) =>
				readMonitorDetail(
					homeDir,
					{
						workspaceDir: config?.workspaceDir,
						scriptsRoot: join(homeDir, "scripts"),
						timezone: config?.timezone ?? hostTimezone(),
					},
					id,
				),
			// 800 ms bound: a wedged daemon must not hold a read past the next tick (callDaemon defaults to 120 s).
			live: async (origin) => {
				const answer = await callDaemon(join(homeDir, "ompbot.sock"), { op: "live", origin }, 800);
				if (typeof answer !== "object" || answer === null || !("ok" in answer) || answer.ok !== true) {
					throw new Error("daemon live op failed");
				}
				return "live" in answer ? (answer.live as LiveView | null) : null;
			},
			onError: (error) =>
				process.stderr.write(
					`dashboard snapshot_failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
				),
			...(board === undefined
				? {}
				: {
						board: {
							source: board,
							tasks: () => {
								try {
									return readBoardTasks(homeDir);
								} catch (error) {
									process.stderr.write(
										`dashboard board_tasks_failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
									);
									return [];
								}
							},
							prompts: () => {
								try {
									return readBoardPrompts(homeDir);
								} catch (error) {
									process.stderr.write(
										`dashboard board_prompts_failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
									);
									return [];
								}
							},
							...(config?.dashboard?.herdrWebUrl === undefined ? {} : { herdrWebUrl: config.dashboard.herdrWebUrl }),
						},
					}),
		});
	} catch (error) {
		process.stderr.write(`dashboard: cannot listen on ${hostname}:${port}: ${String(error)}\n`);
		return 1;
	}
	board?.start();
	const host = hostname.includes(":") ? `[${hostname}]` : hostname;
	process.stdout.write(`dashboard listening url=http://${host}:${server.port}/\n`);

	const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
	process.once("SIGTERM", () => stop());
	process.once("SIGINT", () => stop());
	await stopped;
	board?.stop();
	server.stop(true);
	return 0;
}
