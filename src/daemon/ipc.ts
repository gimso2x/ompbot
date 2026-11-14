import { chmodSync, rmSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** The largest delay `setTimeout` keeps; a longer one is cut to 1 ms with a warning. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Bytes still to go out on a socket whose `write` took only part of them. */
interface Outgoing {
	rest: Buffer;
	/** Close the socket once the last byte is out. */
	endWhenDone: boolean;
}

/** Writes what the socket takes now; the `drain` handler calls it again for the rest. */
function pump(socket: Bun.Socket<unknown>, out: Outgoing): void {
	if (out.rest.length > 0) out.rest = out.rest.subarray(Math.max(0, socket.write(out.rest)));
	if (out.rest.length === 0 && out.endWhenDone) socket.end();
}

interface ServerConnection {
	/** Decodes across chunk boundaries, so a multibyte character split between two chunks stays whole. */
	decoder: StringDecoder;
	buffer: string;
	out: Outgoing;
}

/** One JSON request line in, one JSON response line out, then the connection closes. */
export type IpcHandler = (request: unknown) => Promise<unknown>;

export interface IpcServer {
	stop(): void;
}

export function startIpcServer(path: string, handler: IpcHandler): IpcServer {
	rmSync(path, { force: true }); // the single-instance lock is held, so a leftover socket file is stale
	// Created under umask 0177 so the socket is never visible with wider permissions, then pinned to 0600.
	const previousUmask = process.umask(0o177);
	let server: Bun.UnixSocketListener<ServerConnection>;
	try {
		server = Bun.listen<ServerConnection>({
			unix: path,
			socket: {
				open(socket) {
					socket.data = {
						decoder: new StringDecoder("utf8"),
						buffer: "",
						out: { rest: Buffer.alloc(0), endWhenDone: true },
					};
				},
				drain(socket) {
					pump(socket, socket.data.out);
				},
				data(socket, chunk) {
					socket.data.buffer += socket.data.decoder.write(chunk);
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
						socket.data.out.rest = Buffer.from(`${JSON.stringify(response)}\n`);
						pump(socket, socket.data.out);
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

/** The daemon took the request but gave no answer (timeout, or it closed first): it may still be acting on it. */
export class IpcNoResponse extends Error {}

/**
 * Sends one request to the daemon socket and resolves with its response; rejects when nothing is listening, and with
 * `IpcNoResponse` when the request went out but no answer came.
 */
export async function callDaemon(path: string, request: unknown, timeoutMs = 120_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const decoder = new StringDecoder("utf8");
	const out: Outgoing = { rest: Buffer.from(`${JSON.stringify(request)}\n`), endWhenDone: false };
	let buffer = "";
	let settled = false;
	const timer = setTimeout(
		() => finish(new IpcNoResponse(`ipc timeout after ${timeoutMs}ms`)),
		Math.min(timeoutMs, MAX_TIMER_MS),
	);
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
				pump(s, out);
			},
			drain(s) {
				pump(s, out);
			},
			data(_s, chunk) {
				buffer += decoder.write(chunk);
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				try {
					finish(undefined, JSON.parse(buffer.slice(0, newline)));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			},
			close() {
				finish(new IpcNoResponse("ipc connection closed without a response"));
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
