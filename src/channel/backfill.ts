// What the Slack and Discord backfills share: the dead-letter verdict and the single-flight pass runner.
import { errorText } from "./text";

const TRANSIENT_STORE_ERROR = /SQLITE_(BUSY|LOCKED|FULL|IOERR)/;

/**
 * Whether an ingest failure counts toward the message's dead-letter budget. `platform`: the verdict on the platform's
 * own errors (`undefined` for any other); a busy/locked/full/io ledger is not the message's fault.
 */
export function countsTowardDeadLetter(err: unknown, platform: boolean | undefined): boolean {
	if (platform !== undefined) return platform;
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code === "string" && TRANSIENT_STORE_ERROR.test(code)) return false;
	return !TRANSIENT_STORE_ERROR.test(errorText(err));
}

/** Single-flight passes: a trigger while a pass runs asks for one follow-up pass instead of a second one beside it. */
export abstract class SingleFlightBackfill {
	#running = false;
	#followUp = false;
	#lastRun: Promise<void> = Promise.resolve();

	protected abstract pass(): Promise<unknown>;
	/** A pass that threw; must not throw itself. */
	protected abstract failed(err: unknown): void;

	trigger(): void {
		if (this.#running) {
			this.#followUp = true;
			return;
		}
		this.#running = true;
		this.#lastRun = this.#drain();
	}

	/** Resolves when no pass runs and none is pending (tests and graceful shutdown). */
	waitForIdle(): Promise<void> {
		return this.#lastRun;
	}

	async #drain(): Promise<void> {
		try {
			do {
				this.#followUp = false;
				await this.pass();
			} while (this.#followUp);
		} catch (err) {
			this.failed(err);
		} finally {
			this.#running = false;
		}
	}
}
