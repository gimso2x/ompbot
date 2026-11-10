/**
 * What an owner's whole message does to a lane's running state — decided here, in code, never by a model
 * (`src/core/normalize.ts` keeps the same principle for owner gating). Only the exact listed phrases count;
 * `잠깐 이거 확인해줘` or `멈춰야 하나?` are ordinary messages. `!resume` stays the session command it already
 * is (`CommandKind` `resume`), so it is deliberately absent; adding a phrase is a change to these sets only.
 */

/** What the message does: `pause` stops the lane's turn and holds it, `resume` gives it back. */
export type LaneControl = "pause" | "resume";

const PAUSE_PHRASES: Record<string, true> = {
	멈춰: true,
	멈춰줘: true,
	멈춰봐: true,
	잠깐: true,
	잠깐만: true,
	잠시만: true,
	그만: true,
	그만해: true,
	일시정지: true,
	중단: true,
	중지: true,
	stop: true,
	pause: true,
	"!pause": true,
};

const RESUME_PHRASES: Record<string, true> = {
	계속: true,
	계속해: true,
	계속해줘: true,
	재개: true,
	재개해: true,
	continue: true,
	"!unpause": true,
};

/** The whole message, trimmed, stripped of trailing `. ! ~ ?` and lowercased. */
function normalizeControlText(text: string): string {
	return text
		.trim()
		.replace(/[.!~?]+$/, "")
		.toLowerCase();
}

/**
 * `pause`/`resume` when the whole message is exactly one of the listed phrases (leading/trailing whitespace and
 * trailing `. ! ~ ?` allowed, case-insensitive); `undefined` for everything else.
 */
export function classifyLaneControl(text: string): LaneControl | undefined {
	const whole = normalizeControlText(text);
	if (whole === "") return undefined;
	if (PAUSE_PHRASES[whole] === true) return "pause";
	if (RESUME_PHRASES[whole] === true) return "resume";
	return undefined;
}
