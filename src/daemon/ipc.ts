import { chmodSync, rmSync } from "node:fs";

/** One JSON request line in, one JSON response line out, then the connection closes. */
export type IpcHandler = (request: unknown) => Promise<unknown>;

export interface IpcServer {
	stop(): void;
}

export function startIpcServer(path: string, handler: IpcHandler): IpcServer {
	rmSync(path, { force: true }); // the single-instance lock is held, so a leftover socket file is stale
	// Created under umask 0177 so the socket is never visible with wider permissions, then pinned to 0600.
	const previousUmask = process.umask(0o177);
	let server: Bun.UnixSocketListener<{ buffer: string }>;
	try {
		server = Bun.listen<{ buffer: string }>({
			unix: path,
			socket: {
				open(socket) {
					socket.data = { buffer: "" };
				},
				data(socket, chunk) {
					socket.data.buffer += chunk.toString("utf8");
					const newline = socket.data.buffer.indexOf("\n");
					if (newline === -1) return;
					const line = socket.data.buffer.slice(0, newline);
					socket.data.buffer = "";
					void (async () => {
						let response: unknown;
						try {
							response = await handler(JSON.parse(line));
						} catch (error) {
							response = { ok: false, error: error instanceof Error ? error.message : String(error) };
						}
						socket.write(`${JSON.stringify(response)}\n`);
						socket.end();
					})();
				},
			},
		});
	} finally {
		process.umask(previousUmask);
	}
	chmodSync(path, 0o600);
	return {
		stop() {
			server.stop(true);
			rmSync(path, { force: true });
		},
	};
}

/** Sends one request to the daemon socket and resolves with its response; rejects when nothing is listening. */
export async function callDaemon(path: string, request: unknown, timeoutMs = 120_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let buffer = "";
	let settled = false;
	const timer = setTimeout(() => finish(new Error(`ipc timeout after ${timeoutMs}ms`)), timeoutMs);
	function finish(error: Error | undefined, value?: unknown): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error) reject(error);
		else resolve(value);
	}
	const socket = await Bun.connect({
		unix: path,
		socket: {
			open(s) {
				s.write(`${JSON.stringify(request)}\n`);
			},
			data(_s, chunk) {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				try {
					finish(undefined, JSON.parse(buffer.slice(0, newline)));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			},
			close() {
				finish(new Error("ipc connection closed without a response"));
			},
			error(_s, error) {
				finish(error);
			},
		},
	}).catch((error: unknown) => {
		clearTimeout(timer);
		throw error;
	});
	try {
		return await promise;
	} finally {
		socket.end();
	}
}
