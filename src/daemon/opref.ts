import type {
	OmpCompactResult,
	OmpEntries,
	OmpEvent,
	OmpExitInfo,
	OmpFinal,
	OmpOpenResult,
	OmpSessionDriver,
	OmpState,
	TodoPhase,
} from "../omp/driver";

/**
 * omp numbers its RPC requests `req_<n>` per child process, so after a restart a new turn can reuse an `op_ref` that an
 * earlier process already used. The ledger keys deliveries by (origin, op_ref, part) and would silently drop the new
 * answer. This wrapper prefixes every opRef with an id that is unique per driver instance.
 */
export class NamespacedDriver implements OmpSessionDriver {
	/** Side question, defined only when the wrapped driver supports it (absent = unsupported, like the inner driver). */
	readonly btw?: (question: string) => Promise<string>;

	constructor(
		private readonly inner: OmpSessionDriver,
		private readonly prefix: string,
	) {
		if (inner.btw !== undefined) this.btw = inner.btw.bind(inner);
	}

	/** Pid of the omp child when the wrapped driver exposes one (`RpcOmpDriver`). */
	get pid(): number | undefined {
		return "pid" in this.inner && typeof this.inner.pid === "number" ? this.inner.pid : undefined;
	}

	start(): Promise<void> {
		return this.inner.start();
	}

	async prompt(text: string): Promise<string> {
		return `${this.prefix}:${await this.inner.prompt(text)}`;
	}

	steer(text: string): Promise<void> {
		return this.inner.steer(text);
	}

	abort(): Promise<void> {
		return this.inner.abort();
	}

	newSession(): Promise<{ cancelled: boolean }> {
		return this.inner.newSession();
	}

	openSession(): Promise<OmpOpenResult> {
		return this.inner.openSession();
	}

	switchSession(sessionFile: string): Promise<{ cancelled: boolean }> {
		return this.inner.switchSession(sessionFile);
	}

	availableModels(): Promise<string[]> {
		return this.inner.availableModels();
	}

	setModel(model: string): Promise<string> {
		return this.inner.setModel(model);
	}

	thinkingLevels(): Promise<string[]> {
		return this.inner.thinkingLevels();
	}

	setThinking(level: string): Promise<void> {
		return this.inner.setThinking(level);
	}

	setTodos(phases: TodoPhase[]): Promise<void> {
		return this.inner.setTodos(phases);
	}

	compact(instructions?: string): Promise<OmpCompactResult> {
		return this.inner.compact(instructions);
	}

	state(): Promise<OmpState> {
		return this.inner.state();
	}

	leafId(): Promise<string | null> {
		return this.inner.leafId();
	}

	entriesSince(since?: string): Promise<OmpEntries> {
		return this.inner.entriesSince(since);
	}

	onFinal(listener: (final: OmpFinal) => void): () => void {
		return this.inner.onFinal((final) => listener({ ...final, opRef: `${this.prefix}:${final.opRef}` }));
	}

	onEvent(listener: (event: OmpEvent) => void): () => void {
		return this.inner.onEvent(listener);
	}

	onExit(listener: (info: OmpExitInfo) => void): () => void {
		return this.inner.onExit(listener);
	}

	stop(): Promise<void> {
		return this.inner.stop();
	}
}
