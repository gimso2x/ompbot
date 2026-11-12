import type { OmpAskQuestion, OmpDialogRequest, OmpDialogResponse } from "../omp/driver";
import type { ApprovalBroker, ApprovalOrigin, ChoiceCardHandle, ChoiceEvent } from "./approval";

/** More options than this: a numbered list and "번호로 답장" instead of buttons. */
export const MAX_CHOICE_BUTTONS = 5;
/** Slack allows at most 25 elements in one actions block; an `ask` question past it is answered by number. */
export const MAX_CARD_BUTTONS = 25;
/**
 * omp times a dialog out by itself at its `timeout`; the card's own deadline comes this much earlier so a partly
 * answered `ask` reaches omp with the owner's answers (omp's own timeout would overwrite them with its defaults).
 */
const DEADLINE_LEAD_MS = 1_000;
const REPLY_HINT = "버튼을 누르거나 이 스레드에 답장해 주세요";
const YES = /^(예|네|응|ㅇㅇ|ㅇ|좋아|yes|y|ok|확인)$/i;

const TIMEOUT_LINE = (fallback: string) => `⌛ 시간 초과: ${fallback}로 처리됨`;
/** What omp does with an unanswered `ask` (`timedOutAskDialogResult`): each question's recommended option, else its first. */
const ASK_FALLBACK = "추천(없으면 1번) 선택지";
const ASK_TIMEOUT_LINE = `⌛ 시간 초과: ${ASK_FALLBACK}로 자동 선택`;
const CANCELLED_LINE = "🚫 취소됨";

/** Card deadline for a dialog: just before omp's own `timeout`, else the broker default. */
function deadlineOf(request: OmpDialogRequest): number | undefined {
	if (!("timeout" in request) || request.timeout === undefined) return undefined;
	return Math.max(request.timeout - DEADLINE_LEAD_MS, 0);
}

/** `1. label` lines of a numbered option list; the recommended one is marked. */
function numbered(labels: readonly string[], recommended?: number): string {
	return labels.map((label, index) => `${index + 1}. ${label}${index === recommended ? " (추천)" : ""}`).join("\n");
}

/** A reply naming an option: its 1-based number or its exact label. */
function optionOf(labels: readonly string[], text: string): number | undefined {
	const trimmed = text.trim();
	if (/^\d+$/.test(trimmed)) {
		const index = Number(trimmed) - 1;
		return index >= 0 && index < labels.length ? index : undefined;
	}
	const exact = labels.indexOf(trimmed);
	return exact === -1 ? undefined : exact;
}

/** Ends the card for a non-answer: the timeout or the withdrawal line, and the matching omp response. */
async function endUnanswered(
	card: ChoiceCardHandle,
	kind: "timeout" | "cancelled",
	fallback: string,
): Promise<OmpDialogResponse> {
	await card.close(kind === "timeout" ? TIMEOUT_LINE(fallback) : CANCELLED_LINE);
	return kind === "timeout" ? { cancelled: true, timedOut: true } : { cancelled: true };
}

async function answerSelect(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "select" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const { options } = request;
	const asButtons = options.length <= MAX_CHOICE_BUTTONS;
	const text = asButtons
		? `❓ ${request.title}\n${REPLY_HINT}`
		: `❓ ${request.title}\n${numbered(options)}\n번호로 이 스레드에 답장해 주세요`;
	const card = await broker.choose(
		origin,
		{ text, buttons: asButtons ? options : [], fallback: "취소", timeoutMs: deadlineOf(request) },
		{ signal },
	);
	const result = await card.next();
	if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "취소");
	// A reply naming an option picks it; any other reply text is the value itself.
	const reply = result.kind === "text" ? result.text.trim() : "";
	const index = result.kind === "choice" ? result.index : optionOf(options, reply);
	const value = (index === undefined ? undefined : options[index]) ?? reply;
	await card.close(`✅ 선택: ${value}`, value);
	return { value };
}

async function answerConfirm(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "confirm" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const card = await broker.choose(
		origin,
		{
			text: `❓ ${request.title}\n${request.message}\n${REPLY_HINT}`,
			buttons: ["예", "아니오"],
			// omp reads a timed-out (or withdrawn) confirm as `false`: the owner sees that outcome, not a cancel.
			fallback: "아니오",
			timeoutMs: deadlineOf(request),
		},
		{ signal },
	);
	const result = await card.next();
	if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "아니오");
	// Anything but a clear yes is a no (fail-closed).
	const confirmed = result.kind === "choice" ? result.index === 0 : YES.test(result.text.trim());
	const label = confirmed ? "예" : "아니오";
	await card.close(`✅ 선택: ${label}`, label);
	return { confirmed };
}

async function answerText(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "input" | "editor" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	if (request.method === "input" && request.secret === true) {
		const card = await broker.choose(
			origin,
			{
				text: `🔒 ${request.title}\n비밀값은 슬랙에 쓰지 마세요 — 이 입력은 취소합니다`,
				buttons: [],
				fallback: "취소",
			},
			{ signal },
		);
		await card.close(CANCELLED_LINE);
		return { cancelled: true };
	}
	const hint =
		request.method === "input"
			? request.placeholder
			: request.prefill === undefined
				? undefined
				: "(편집할 기존 내용 있음)";
	const card = await broker.choose(
		origin,
		{
			text: `❓ ${request.title}${hint === undefined || hint === "" ? "" : `\n${hint}`}\n이 스레드에 답장해 주세요`,
			buttons: [],
			fallback: "취소",
			timeoutMs: deadlineOf(request),
		},
		{ signal },
	);
	for (;;) {
		const result = await card.next();
		if (result.kind === "timeout" || result.kind === "cancelled") return endUnanswered(card, result.kind, "취소");
		if (result.kind !== "text") continue; // no buttons on this card; a stale click is not an answer
		await card.close("✅ 답장을 받았습니다", result.text);
		return { value: result.text };
	}
}

interface AskAnswer {
	selectedOptions: string[];
	customInput?: string;
}

/**
 * Buttons of an `ask` card, with the question each one answers: drawn once per card, so a click's index means the
 * same button for the card's whole life. Single-select questions with at most `MAX_CHOICE_BUTTONS` options get
 * buttons while the card stays within `MAX_CARD_BUTTONS`; the rest are answered by number.
 */
function askButtons(questions: readonly OmpAskQuestion[]): Array<{ label: string; question: number; option: number }> {
	const many = questions.length > 1;
	const buttons: Array<{ label: string; question: number; option: number }> = [];
	questions.forEach((question, q) => {
		if (question.multi === true || question.options.length > MAX_CHOICE_BUTTONS) return;
		if (buttons.length + question.options.length > MAX_CARD_BUTTONS) return;
		question.options.forEach((option, o) => {
			buttons.push({ label: many ? `${q + 1}. ${option.label}` : option.label, question: q, option: o });
		});
	});
	return buttons;
}

function answerLine(answer: AskAnswer): string {
	return (
		[...answer.selectedOptions, ...(answer.customInput === undefined ? [] : [answer.customInput])].join(", ") ||
		"(빈 답)"
	);
}

/** The `ask` card body: one block per question, answered ones show their answer. `buttoned`: questions with buttons. */
function askText(
	questions: readonly OmpAskQuestion[],
	answers: ReadonlyArray<AskAnswer | undefined>,
	buttoned: ReadonlySet<number>,
): string {
	const blocks = questions.map((question, q) => {
		const head = `*${q + 1}. ${question.header === undefined ? "" : `[${question.header}] `}${question.question}*`;
		const answer = answers[q];
		if (answer !== undefined) return `${head}\n→ ${answerLine(answer)}`;
		const labels = question.options.map((option) =>
			option.description === undefined ? option.label : `${option.label} — ${option.description}`,
		);
		const how =
			question.multi === true
				? "번호를 쉼표로 답장해 주세요(예: 1,3)"
				: buttoned.has(q)
					? "버튼을 누르거나 번호로 답장해 주세요"
					: "번호로 답장해 주세요";
		return `${head}\n${numbered(labels, question.recommended)}\n${how}`;
	});
	return `❓ 질문 ${questions.length}개 — 답하지 않은 첫 질문부터 답장이 채워집니다\n${blocks.join("\n\n")}`;
}

/** A text answer to one `ask` question: option numbers/labels, else free text (`customInput`). */
function textAnswer(question: OmpAskQuestion, text: string): AskAnswer {
	const labels = question.options.map((option) => option.label);
	const trimmed = text.trim();
	if (question.multi === true) {
		const parts = trimmed.split(/[,\s]+/).filter((part) => part !== "");
		const picked = parts.map((part) => optionOf(labels, part));
		if (parts.length > 0 && picked.every((index) => index !== undefined)) {
			return { selectedOptions: [...new Set(picked.map((index) => labels[index as number] as string))] };
		}
		return { selectedOptions: [], customInput: trimmed };
	}
	const index = optionOf(labels, trimmed);
	return index === undefined
		? { selectedOptions: [], customInput: trimmed }
		: { selectedOptions: [labels[index] as string] };
}

async function answerAsk(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: Extract<OmpDialogRequest, { method: "ask" }>,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	const { questions } = request;
	const answers: Array<AskAnswer | undefined> = questions.map(() => undefined);
	const buttons = askButtons(questions);
	const labels = buttons.map((button) => button.label);
	const buttoned = new Set(buttons.map((button) => button.question));
	const recommended = buttons.flatMap((button, index) =>
		questions[button.question]?.recommended === button.option ? [index] : [],
	);
	const card = await broker.choose(
		origin,
		{
			text: askText(questions, answers, buttoned),
			buttons: labels,
			recommended,
			fallback: ASK_FALLBACK,
			timeoutMs: deadlineOf(request),
		},
		{ signal },
	);
	const toResponse = (): OmpDialogResponse => ({
		answers: questions.map((question, q) => {
			const answer = answers[q] ?? { selectedOptions: [] };
			return {
				id: question.id,
				selectedOptions: answer.selectedOptions,
				...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
			};
		}),
	});
	const summary = () =>
		questions.map((_question, q) => `${q + 1}) ${answerLine(answers[q] ?? { selectedOptions: [] })}`).join(" · ");
	for (;;) {
		const result = await card.next();
		if (result.kind === "cancelled") return endUnanswered(card, "cancelled", ASK_FALLBACK);
		if (result.kind === "timeout") {
			const untouched = answers.every((answer) => answer === undefined);
			// omp's own fallback, so the card says what omp picks.
			questions.forEach((question, q) => {
				if (answers[q] !== undefined) return;
				// Clamped into the option range, as omp's `timedOutAskDialogResult` does.
				const pick = Math.min(Math.max(question.recommended ?? 0, 0), question.options.length - 1);
				const label = question.options[pick]?.label;
				answers[q] = { selectedOptions: label === undefined ? [] : [label] };
			});
			// Nothing answered: omp fills every question itself and marks the result `timedOut` for the model.
			// Partly answered: the owner's answers go back as they are, the rest as omp would fill them.
			await card.close(`${ASK_TIMEOUT_LINE} — ${summary()}`, untouched ? undefined : summary());
			return untouched ? { cancelled: true, timedOut: true } : toResponse();
		}
		applyAskEvent(questions, answers, buttons, result);
		if (answers.every((answer) => answer !== undefined)) {
			await card.close(`✅ 답: ${summary()}`, summary());
			return toResponse();
		}
		await card.update(askText(questions, answers, buttoned), labels);
	}
}

/** A click answers its question (if still open); a reply answers the first unanswered question. */
function applyAskEvent(
	questions: readonly OmpAskQuestion[],
	answers: Array<AskAnswer | undefined>,
	buttons: ReadonlyArray<{ question: number; option: number }>,
	event: ChoiceEvent,
): void {
	if (event.kind === "choice") {
		const button = buttons[event.index];
		const label = button === undefined ? undefined : questions[button.question]?.options[button.option]?.label;
		if (button !== undefined && label !== undefined && answers[button.question] === undefined) {
			answers[button.question] = { selectedOptions: [label] };
		}
		return;
	}
	const first = answers.indexOf(undefined);
	const question = questions[first];
	if (question !== undefined) answers[first] = textAnswer(question, event.text);
}

/**
 * Puts one omp dialog to the owner as a choice card in `origin`'s conversation and returns the omp response.
 * select/confirm get buttons (a numbered list past `MAX_CHOICE_BUTTONS`), input/editor take a reply, ask gets one
 * block per question; a secret input is cancelled at once, since a secret must never be typed into Slack.
 */
export function answerDialogOnSlack(
	broker: ApprovalBroker,
	origin: ApprovalOrigin,
	request: OmpDialogRequest,
	signal: AbortSignal,
): Promise<OmpDialogResponse> {
	switch (request.method) {
		case "select":
			return answerSelect(broker, origin, request, signal);
		case "confirm":
			return answerConfirm(broker, origin, request, signal);
		case "input":
		case "editor":
			return answerText(broker, origin, request, signal);
		case "ask":
			return answerAsk(broker, origin, request, signal);
	}
}
