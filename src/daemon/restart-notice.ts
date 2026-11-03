import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Restart notices around a drain restart (gajae-way `restartNotice`): conversations that were active when the drain
 * started hear "재시작합니다", then "다시 연결됐습니다" from the next process or "재시작 취소" when the drain ends without
 * a restart. The marker file carries the notified threads across the restart; notices are best-effort, never ledgered.
 */

export const RESTART_NOTICE_FILE = "restart-notice.json";
/** Conversations with an owner message this recent count as active (busy ones always do). */
export const RESTART_NOTICE_ACTIVE_MS = 30 * 60_000;
/** At most this many conversations are told, newest first. */
export const RESTART_NOTICE_MAX = 10;
/** A marker older than this belongs to some earlier, unrelated drain: the next start drops it without a notice. */
export const RESTART_NOTICE_STALE_MS = 3 * 60 * 60_000;

export const RESTART_NOTICE_TEXT = {
	draining:
		"🔄 ompbot을 곧 재시작합니다. 진행 중인 작업이 끝나면 재시작하고, 그 사이 보낸 메시지는 재시작 뒤에 처리합니다.",
	back: "✅ ompbot이 재시작을 마치고 다시 연결됐습니다.",
	cancelled: "↩️ ompbot 재시작이 취소됐습니다. 기다리던 메시지를 지금 처리합니다.",
} as const;

export interface RestartNoticeMarker {
	at: number;
	threads: string[];
}

export function writeRestartMarker(homeDir: string, marker: RestartNoticeMarker): void {
	writeFileSync(join(homeDir, RESTART_NOTICE_FILE), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

/** The marker, or undefined when there is none or it is unreadable (an unreadable marker is removed too). */
export function takeRestartMarker(homeDir: string): RestartNoticeMarker | undefined {
	const path = join(homeDir, RESTART_NOTICE_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	rmSync(path, { force: true });
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"at" in parsed &&
			typeof parsed.at === "number" &&
			"threads" in parsed &&
			Array.isArray(parsed.threads) &&
			parsed.threads.every((t) => typeof t === "string")
		) {
			return { at: parsed.at, threads: parsed.threads as string[] };
		}
	} catch {
		// fall through: a torn marker is dropped
	}
	return undefined;
}

/** Busy conversations first (their turn is what the drain waits for), then recent ones; unique, capped. */
export function pickRestartThreads(busy: Array<string | undefined>, recent: string[]): string[] {
	const threads: string[] = [];
	for (const ref of [...busy, ...recent]) {
		if (ref !== undefined && !threads.includes(ref)) threads.push(ref);
	}
	return threads.slice(0, RESTART_NOTICE_MAX);
}
