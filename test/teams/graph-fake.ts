// A local stand-in for Entra's device code / token endpoints and Microsoft Graph: every request is recorded and
// answered by the route the test sets. Nothing leaves the machine; every token here is a fake string.

export interface GraphCall {
	method: string;
	path: string;
	/** Path plus query, as the client asked for it. */
	url: string;
	form: Record<string, string>;
	authorization: string | null;
}

export type GraphRoute = (call: GraphCall) => Response | Promise<Response>;

export class FakeGraph {
	readonly calls: GraphCall[] = [];
	/** Routes by path (the first one whose key the path equals, then `startsWith` for keys ending in `*`). */
	readonly routes = new Map<string, GraphRoute>();
	#server: Bun.Server<undefined> | undefined;

	get base(): string {
		return `http://127.0.0.1:${this.#server?.port}`;
	}
	get loginBase(): string {
		return `${this.base}/login`;
	}
	get graphBase(): string {
		return `${this.base}/v1.0`;
	}

	start(): void {
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.#handle(request) });
	}

	async stop(): Promise<void> {
		await this.#server?.stop(true);
	}

	callsTo(path: string): GraphCall[] {
		return this.calls.filter((call) => call.path === path);
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const text = request.method === "POST" ? await request.text() : "";
		const call: GraphCall = {
			method: request.method,
			path: url.pathname,
			url: `${url.pathname}${url.search}`,
			form: Object.fromEntries(new URLSearchParams(text)),
			authorization: request.headers.get("authorization"),
		};
		this.calls.push(call);
		const exact = this.routes.get(url.pathname);
		if (exact !== undefined) return exact(call);
		for (const [key, route] of this.routes) {
			if (key.endsWith("*") && url.pathname.startsWith(key.slice(0, -1))) return route(call);
		}
		return Response.json({ error: { code: "NotFound" } }, { status: 404 });
	}
}

export const tokenPath = (tenant: string): string => `/login/${tenant}/oauth2/v2.0/token`;
export const deviceCodePath = (tenant: string): string => `/login/${tenant}/oauth2/v2.0/devicecode`;
