import { redact } from "../redact";
import type { BoardCard } from "./board";

/** herdr-web-ui gets this long to answer a conversation or plan read. */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Paging parameters herdr-web-ui's conversation endpoint takes; nothing else is passed on. */
const CONVERSATION_QUERY = ["before", "since", "from"] as const;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export type PaneKind = "conversation" | "plan";

/** Masks secrets in every string of a JSON value. */
function redactJson(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(redactJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactJson(inner)]));
	}
	return value;
}

/** The upstream body as received, unless masking changed a string in it (then the masked JSON). */
function maskedBody(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return redact(body);
	}
	const masked = JSON.stringify(redactJson(parsed));
	return masked === JSON.stringify(parsed) ? body : masked;
}

/**
 * Read-only GET of herdr-web-ui's conversation or plan of one card on the board: `/api/pane/<kind>` for the web UI's
 * own machine, `/api/machines/<id>/pane/<kind>` otherwise, both ids encoded. 2xx and 409 pass through with their
 * status; any other answer is 502 `upstream`, no answer (or none in 10 s) 502 `herdr_unreachable`.
 */
export async function proxyPaneGet(
	kind: PaneKind,
	origin: string,
	card: Pick<BoardCard, "local" | "machineId" | "paneId">,
	params: URLSearchParams,
): Promise<Response> {
	const query = new URLSearchParams({ pane_id: card.paneId });
	if (kind === "conversation") {
		for (const name of CONVERSATION_QUERY) {
			const value = params.get(name);
			if (value !== null) query.set(name, value);
		}
	}
	const path = card.local ? `/api/pane/${kind}` : `/api/machines/${encodeURIComponent(card.machineId)}/pane/${kind}`;
	let upstream: Response;
	let body: string;
	try {
		upstream = await fetch(`${origin}${path}?${query}`, {
			method: "GET",
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			headers: { accept: "application/json" },
		});
		body = await upstream.text();
	} catch {
		return Response.json({ error: "herdr_unreachable" }, { status: 502, headers: HEADERS });
	}
	if ((upstream.status >= 200 && upstream.status < 300) || upstream.status === 409) {
		return new Response(maskedBody(body), { status: upstream.status, headers: HEADERS });
	}
	return Response.json({ error: "upstream", status: upstream.status }, { status: 502, headers: HEADERS });
}
