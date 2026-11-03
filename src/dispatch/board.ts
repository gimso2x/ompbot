/**
 * herdr-web-ui task board links (gajae-way hub fleet `owner_link` pattern): a card is addressed by the pane id on
 * the web UI's own (local) machine and by `<machine id>:<pane id>` on a machine it reaches over ssh. The machine
 * list comes from the web UI's `/api/machines`; when the card cannot be resolved the board root is linked instead.
 */

/** `config.json` `herdrBoard`: the public board page and the web UI API the card keys are resolved against. */
export interface HerdrBoardConfig {
	/** Public board page, e.g. `https://herdr.example.com/task/`. */
	url: string;
	/** herdr-web-ui origin reachable from this host. Default {@link DEFAULT_BOARD_API}. */
	api?: string;
}

export const DEFAULT_BOARD_API = "http://127.0.0.1:7317";
const MACHINES_TIMEOUT_MS = 5_000;

interface BoardMachine {
	id?: unknown;
	name?: unknown;
	kind?: unknown;
}

/** Resolves a link from a dispatch host (`null` = this host) and an agent's pane id. */
export type BoardLinkResolver = (host: string | null, paneId: string | undefined) => Promise<string>;

/**
 * The card link of `paneId` on `host` (`null` = the web UI's local machine, any other value = the machine of that
 * name). Falls back to the board root when the pane is unknown or the machine list cannot be read; `onError` hears
 * why.
 */
export async function boardCardLink(
	board: HerdrBoardConfig,
	host: string | null,
	paneId: string | undefined,
	options: { fetch?: typeof fetch; onError?: (error: string) => void } = {},
): Promise<string> {
	if (paneId === undefined || paneId === "") return board.url;
	const api = (board.api ?? DEFAULT_BOARD_API).replace(/\/+$/, "");
	try {
		const response = await (options.fetch ?? fetch)(`${api}/api/machines`, {
			signal: AbortSignal.timeout(MACHINES_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`machines HTTP ${response.status}`);
		const body = (await response.json()) as { machines?: BoardMachine[] };
		const machine = body.machines?.find((candidate) =>
			host === null ? candidate.kind === "local" : candidate.name === host,
		);
		if (machine === undefined || typeof machine.id !== "string") {
			throw new Error(`no board machine for ${host ?? "local"}`);
		}
		const key = machine.kind === "local" ? paneId : `${machine.id}:${paneId}`;
		return `${board.url}${board.url.includes("?") ? "&" : "?"}card=${key}`;
	} catch (error) {
		options.onError?.(error instanceof Error ? error.message : String(error));
		return board.url;
	}
}
