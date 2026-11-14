import type { SpanKind, SpanStatus, TraceSpan, TurnTrace } from "./trace";

/** What the waterfall shows besides the trace: the page clock, folds, the focused row and the open details. */
export interface TraceViewState {
	/** The page clock (epoch ms); running spans grow into it. */
	now: number;
	/** Folded (true) or opened (false) by hand; without an entry a finished sub-agent starts folded. */
	fold: Record<string, boolean>;
	focus: string | null;
	/** The span whose details are open. */
	open: string | null;
	/** The turn's request line, after the root's name. */
	title: string;
}

/**
 * The turn's waterfall: a tree of rows (name, a bar on the turn's clock, duration, cost), the axis, the "now" line and
 * the details of the open span. Patchable in place: every changing piece carries `data-part`, and `data-sig` changes
 * exactly when the rows themselves do. Self-contained (shipped to the page).
 */
export function renderTrace(answer: TurnTrace, state: TraceViewState): string {
	const esc = (value: unknown): string =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	if (!answer.ok) {
		const why: Record<string, string> = {
			no_database: "DB가 없어 트레이스를 읽지 못했어요",
			unknown_turn: "이 턴은 기록에 없어요",
			not_dispatched: "아직 시작하지 않은 턴이에요. 시작되면 트레이스가 나타납니다",
			no_session: "이 턴의 세션 파일을 찾지 못했어요",
		};
		return `<p class="note">${esc(why[answer.error] ?? answer.error)}</p>`;
	}
	const KIND: Record<SpanKind, string> = { agent: "턴", subagent: "하위 에이전트", llm: "모델 호출", tool: "도구" };
	const STATUS: Record<SpanStatus, [string, string]> = {
		running: ["실행 중", "is-info"],
		done: ["완료", "is-success"],
		failed: ["실패", "is-danger"],
	};
	const clock = Math.max(0, state.now - answer.startedAt);
	const endOf = (span: TraceSpan): number => Math.max(span.start, span.end ?? clock);
	const dur = (ms: number): string => {
		if (ms < 10_000) return `${(ms / 1000).toFixed(1)}초`;
		if (ms < 60_000) return `${Math.floor(ms / 1000)}초`;
		if (ms < 3_600_000)
			return `${Math.floor(ms / 60_000)}분${ms % 60_000 >= 1000 ? ` ${Math.floor((ms % 60_000) / 1000)}초` : ""}`;
		return `${Math.floor(ms / 3_600_000)}시간${ms % 3_600_000 >= 60_000 ? ` ${Math.floor((ms % 3_600_000) / 60_000)}분` : ""}`;
	};
	const money = (amount: number): string => (amount <= 0 ? "" : `$${amount.toFixed(amount >= 1 ? 2 : 3)}`);
	const count = (n: number): string =>
		n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

	// Roll-ups (agents add up their children), parents, and the slowest finished call.
	interface Sum {
		cost: number;
		tokensIn: number;
		tokensOut: number;
		llm: number;
		tool: number;
		agents: number;
	}
	const sums = new Map<string, Sum>();
	let slowest: TraceSpan | undefined;
	let far = 0;
	const walk = (span: TraceSpan): Sum => {
		const sum: Sum = {
			cost: span.cost ?? 0,
			tokensIn: span.tokensIn ?? 0,
			tokensOut: span.tokensOut ?? 0,
			llm: span.kind === "llm" && span.end !== undefined ? 1 : 0,
			tool: span.kind === "tool" ? 1 : 0,
			agents: span.kind === "subagent" ? 1 : 0,
		};
		far = Math.max(far, endOf(span));
		const ownTime = span.end === undefined ? -1 : span.end - span.start;
		if ((span.kind === "llm" || span.kind === "tool") && span.status !== "running" && ownTime > 0) {
			if (slowest === undefined || ownTime > (slowest.end ?? 0) - slowest.start) slowest = span;
		}
		for (const child of span.children ?? []) {
			const part = walk(child);
			sum.cost += part.cost;
			sum.tokensIn += part.tokensIn;
			sum.tokensOut += part.tokensOut;
			sum.llm += part.llm;
			sum.tool += part.tool;
			sum.agents += part.agents;
		}
		sums.set(span.id, sum);
		return sum;
	};
	const total = walk(answer.root);

	// The axis grows in round steps; a live run keeps a little room ahead of "now".
	const STEPS = [10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);
	const need = answer.live ? Math.max(far, clock) * 1.06 : far;
	const range = STEPS.find((step) => step >= need) ?? Math.ceil(need / 86_400_000) * 86_400_000;
	const frac = (ms: number): string => (Math.min(1, Math.max(0, ms / range)) || 0).toFixed(4);

	const folded = (span: TraceSpan): boolean =>
		(span.children?.length ?? 0) > 0 &&
		(state.fold[span.id] ?? (span.kind === "subagent" && span.status !== "running"));
	const rows: Array<{ span: TraceSpan; level: number }> = [];
	const visit = (span: TraceSpan, level: number): void => {
		rows.push({ span, level });
		if (!folded(span)) for (const child of span.children ?? []) visit(child, level + 1);
	};
	visit(answer.root, 1);
	const focus = rows.some((row) => row.span.id === state.focus) ? state.focus : answer.root.id;
	const chevron =
		'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	const rowHtml = ({ span, level }: { span: TraceSpan; level: number }): string => {
		const sum = sums.get(span.id);
		const own = endOf(span) - span.start;
		const cost = money(span.kind === "agent" || span.kind === "subagent" ? (sum?.cost ?? 0) : (span.cost ?? 0));
		const kids = (span.children?.length ?? 0) > 0;
		const isOpen = state.open === span.id;
		const name = span.kind === "agent" ? KIND.agent : span.name;
		const detail = span.kind === "agent" ? state.title : (span.detail ?? "");
		const label = [name, KIND[span.kind], STATUS[span.status][0], dur(own), cost]
			.filter((part) => part !== "")
			.join(", ");
		return `<div class="tw-row is-${span.kind} is-${span.status}${isOpen ? " is-open" : ""}" data-part="row" data-span="${esc(
			span.id,
		)}" style="--lv:${level - 1}" role="treeitem" aria-level="${level}"${kids ? ` aria-expanded="${!folded(span)}"` : ""} aria-selected="${isOpen}" tabindex="${
			span.id === focus ? 0 : -1
		}" aria-label="${esc(label)}"><span class="tw-name">${
			kids ? `<span class="tw-twist" data-trace-toggle>${chevron}</span>` : '<span class="tw-twist"></span>'
		}<i class="tw-sw" aria-hidden="true"></i><span class="tw-label">${esc(name)}</span>${
			detail === "" ? "" : `<span class="tw-detail">${esc(detail)}</span>`
		}${slowest !== undefined && slowest.id === span.id ? '<span class="tw-tag">가장 느림</span>' : ""}</span><span class="tw-track" aria-hidden="true"><i class="tw-bar" data-part="bar" style="--x:${frac(
			span.start,
		)};--w:${frac(own)}"></i></span><span class="tw-num" data-part="text">${esc(dur(own))}</span><span class="tw-num" data-part="text">${esc(
			cost,
		)}</span></div>`;
	};

	const ticks = [0, 0.25, 0.5, 0.75, 1];
	const axis = ticks.map((t) => `<span style="--x:${t}">${t === 0 ? "0" : esc(dur(range * t))}</span>`).join("");
	const guides = ticks
		.slice(1, -1)
		.map((t) => `<i class="tw-tick" style="--x:${t}"></i>`)
		.join("");
	const [stateWord, stateTone] = STATUS[answer.root.status];
	const summary = [
		`<b>${esc(dur(endOf(answer.root)))}</b>`,
		`모델 ${total.llm}회`,
		`도구 ${total.tool}회`,
		total.agents > 0 ? `하위 ${total.agents}` : "",
		total.tokensIn + total.tokensOut > 0 ? `토큰 ${count(total.tokensIn)} → ${count(total.tokensOut)}` : "",
		total.cost > 0 ? `<b>${esc(money(total.cost))}</b>` : "",
	]
		.filter((part) => part !== "")
		.join('<span aria-hidden="true"> · </span>');
	// Below the root: sub-agents are the only spans with children, so the button shows only when there are some.
	const branches = rows.filter((row) => row.level > 1 && (row.span.children?.length ?? 0) > 0);
	const foldable = branches.length > 0;
	const anyOpen = branches.some((row) => !folded(row.span));

	const picked = state.open === null ? undefined : rows.find((row) => row.span.id === state.open)?.span;
	let pop = "";
	if (picked !== undefined) {
		const sum = sums.get(picked.id);
		const agent = picked.kind === "agent" || picked.kind === "subagent";
		const at = new Date(answer.startedAt + picked.start);
		const clockText = [at.getHours(), at.getMinutes(), at.getSeconds()]
			.map((n) => String(n).padStart(2, "0"))
			.join(":");
		const facts: Array<[string, string]> = [
			["시작", `+${esc(dur(picked.start))} <span class="note-sub">${clockText}</span>`],
			[
				"소요",
				picked.status === "running"
					? `${esc(dur(endOf(picked) - picked.start))}째 실행 중`
					: esc(dur(endOf(picked) - picked.start)),
			],
			...(picked.kind === "agent" && state.title !== "" ? [["요청", esc(state.title)] as [string, string]] : []),
			...(picked.detail !== undefined && picked.kind !== "agent"
				? [["내용", esc(picked.detail)] as [string, string]]
				: []),
			...(picked.model !== undefined && picked.model !== picked.name
				? [["모델", esc(picked.model)] as [string, string]]
				: []),
			...(agent && sum !== undefined
				? [
						["호출", `모델 ${sum.llm}회 · 도구 ${sum.tool}회${sum.agents > 0 ? ` · 하위 ${sum.agents}` : ""}`] as [
							string,
							string,
						],
					]
				: []),
			...((sum?.tokensIn ?? 0) + (sum?.tokensOut ?? 0) > 0
				? [
						[
							agent ? "토큰 합계" : "토큰",
							`입력 ${esc(count(sum?.tokensIn ?? 0))} · 출력 ${esc(count(sum?.tokensOut ?? 0))}`,
						] as [string, string],
					]
				: []),
			...((sum?.cost ?? 0) > 0 ? [[agent ? "비용 합계" : "비용", esc(money(sum?.cost ?? 0))] as [string, string]] : []),
			...(picked.error === undefined
				? []
				: [["오류", `<span class="is-error">${esc(picked.error)}</span>`] as [string, string]]),
		];
		const [word, tone] = STATUS[picked.status];
		pop = `<div class="tw-pop-head"><i class="tw-sw" aria-hidden="true"></i><h4 id="tw-pop-title" class="tw-pop-title">${esc(
			picked.kind === "agent" ? KIND.agent : picked.name,
		)}</h4><span class="badge">${KIND[picked.kind]}</span><span class="badge ${tone}">${word}</span><button type="button" class="detail-close" data-trace-close>닫기 <kbd>Esc</kbd></button></div><dl class="facts">${facts
			.map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`)
			.join("")}</dl>`;
	}

	// djb2 of the row ids, folds and the slowest mark: equal means the rows can be patched in place.
	let hash = 5381;
	const sigText = `${rows.map((row) => `${row.span.id}:${folded(row.span) ? 1 : 0}`).join(",")}|${slowest?.id ?? ""}`;
	for (let i = 0; i < sigText.length; i++) hash = ((hash << 5) + hash + sigText.charCodeAt(i)) | 0;

	return `<div class="tw" data-trace data-sig="${(hash >>> 0).toString(36)}-${rows.length}"><div class="tw-head"><h3 class="h3">트레이스</h3><span class="tw-state ${stateTone}" role="status" aria-live="polite" data-part="html"><i class="tw-dot" aria-hidden="true"></i>${stateWord}</span>${
		foldable
			? `<button type="button" class="button is-ghost is-sm tw-fold-all" data-trace-fold-all data-part="text">${anyOpen ? "모두 접기" : "모두 펼치기"}</button>`
			: ""
	}<p class="tw-sum" data-part="html">${summary}</p></div><div class="tw-body"><div class="tw-axis" aria-hidden="true"><span>단계</span><span class="tw-axis-track" data-part="html">${axis}</span><span class="tw-num">시간</span><span class="tw-num">비용</span></div><div class="tw-tree" role="tree" aria-label="턴 트레이스: 모델 호출·도구·하위 에이전트"><div class="tw-rows"><div class="tw-guides" aria-hidden="true"><span></span><span class="tw-gtrack" data-part="html">${guides}</span></div>${
		answer.live
			? `<div class="tw-guides" aria-hidden="true"><span></span><span class="tw-gtrack"><i class="tw-now" data-part="bar" style="--x:${frac(clock)}"></i></span></div>`
			: ""
	}${rows.map(rowHtml).join("")}</div></div></div>${
		answer.truncated ? '<p class="note-sub">호출이 많아 앞부분은 생략했어요</p>' : ""
	}${(answer.root.children?.length ?? 0) === 0 ? '<p class="note-sub">아직 기록된 호출이 없어요</p>' : ""}<section class="tw-pop${
		picked === undefined ? "" : ` is-${picked.kind} is-${picked.status}`
	}" role="dialog" aria-labelledby="tw-pop-title" data-part="html"${picked === undefined ? " hidden" : ""}>${pop}</section></div>`;
}
