/**
 * Agent message markdown → HTML for the card detail panel. The subset and parser follow the owner's herdr-board
 * shared/markdown.ts: fenced code, headings, lists, quotes, tables, rules and inline code/bold/italic/strike/links.
 * Every piece of message text is HTML-escaped before it is wrapped in a fixed tag, links are http(s) only, and there
 * are no images, raw HTML, scripts or iframes: `![x](url)` stays the text `!` plus an ordinary link.
 *
 * Self-contained on purpose (no imports, no module-level helpers): the page ships this function's source as part of
 * its inline script, so the browser renders conversations with this very code.
 */
export function renderMarkdown(source: string): string {
	const esc = (value: string): string =>
		value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
	const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
	const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
	const QUOTE = /^ {0,3}>\s?(.*)$/;
	const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
	const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
	const INLINE =
		/(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__(?!\w)|~~(?=\S)([\s\S]*?\S)~~|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g;

	const inline = (text: string): string => {
		let out = "";
		let last = 0;
		for (const match of text.matchAll(INLINE)) {
			const at = match.index ?? 0;
			out += esc(text.slice(last, at));
			const [, ticks, code = "", label, href = "", strong1, strong2, del, em1, em2] = match;
			if (ticks !== undefined) {
				out += `<code>${esc(code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code)}</code>`;
			} else if (label !== undefined) {
				out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inline(label)}</a>`;
			} else if (strong1 !== undefined || strong2 !== undefined) {
				out += `<strong>${inline(strong1 ?? strong2 ?? "")}</strong>`;
			} else if (del !== undefined) {
				out += `<del>${inline(del)}</del>`;
			} else {
				out += `<em>${inline(em1 ?? em2 ?? "")}</em>`;
			}
			last = at + match[0].length;
		}
		return out + esc(text.slice(last));
	};
	const cells = (line: string): string[] => {
		let row = line.trim();
		if (row.startsWith("|")) row = row.slice(1);
		if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
		return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
	};
	const tableStart = (line: string, next: string | undefined): boolean =>
		line.includes("|") && TABLE_SEPARATOR.test(next ?? "");

	const blocks = (text: string): string => {
		const lines = text.replace(/\r\n?/g, "\n").split("\n");
		const out: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i] ?? "";
			if (line.trim() === "") {
				i++;
				continue;
			}
			const fence = FENCE.exec(line);
			if (fence) {
				const marker = fence[1] ?? "```";
				const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
				const body: string[] = [];
				i++;
				while (i < lines.length && !close.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
				i++; // closing fence (or past the end when it never closes)
				out.push(`<pre class="md-code"><code>${esc(body.join("\n"))}</code></pre>`);
				continue;
			}
			const heading = HEADING.exec(line);
			if (heading) {
				const level = Math.min(6, Math.max(3, (heading[1] ?? "#").length + 2));
				out.push(`<h${level} class="md-h">${inline(heading[2] ?? "")}</h${level}>`);
				i++;
				continue;
			}
			if (RULE.test(line)) {
				out.push("<hr>");
				i++;
				continue;
			}
			if (QUOTE.test(line)) {
				const inner: string[] = [];
				while (i < lines.length && QUOTE.test(lines[i] ?? "")) inner.push(QUOTE.exec(lines[i++] ?? "")?.[1] ?? "");
				out.push(`<blockquote>${blocks(inner.join("\n"))}</blockquote>`);
				continue;
			}
			if (tableStart(line, lines[i + 1])) {
				const head = cells(line)
					.map((cell) => `<th>${inline(cell)}</th>`)
					.join("");
				i += 2;
				const rows: string[] = [];
				while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
					rows.push(
						`<tr>${cells(lines[i++] ?? "")
							.map((cell) => `<td>${inline(cell)}</td>`)
							.join("")}</tr>`,
					);
				}
				out.push(
					`<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
				);
				continue;
			}
			const first = LIST.exec(line);
			if (first) {
				const ordered = /\d/.test(first[2] ?? "");
				const base = (first[1] ?? "").length;
				const start = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
				let topSeq = start;
				let hadSub = false;
				const items: string[] = [];
				while (i < lines.length) {
					const item = LIST.exec(lines[i] ?? "");
					if (item) {
						if (/\d/.test(item[2] ?? "") !== ordered && (item[1] ?? "").length <= base) break;
						let body = item[3] ?? "";
						let box = "";
						const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
						if (task) {
							box = task[1] === " " ? "☐ " : "☑ ";
							body = task[2] ?? "";
						}
						const depth = Math.min(3, Math.floor(Math.max(0, (item[1] ?? "").length - base) / 2));
						let valAttr = "";
						if (ordered) {
							if (depth === 0) {
								const n = topSeq++;
								if (hadSub) valAttr = ` value="${n}"`;
							} else {
								hadSub = true;
							}
						}
						items.push(`<li class="md-d${depth}"${valAttr}>${box}${inline(body)}</li>`);
						i++;
						continue;
					}
					const cont = lines[i] ?? "";
					if (cont.trim() !== "" && /^\s+/.test(cont) && items.length > 0) {
						items[items.length - 1] = (items[items.length - 1] ?? "").replace(
							/<\/li>$/,
							`<br>${inline(cont.trim())}</li>`,
						);
						i++;
						continue;
					}
					break;
				}
				out.push(
					ordered
						? `<ol${start === 1 ? "" : ` start="${start}"`}>${items.join("")}</ol>`
						: `<ul>${items.join("")}</ul>`,
				);
				continue;
			}
			const para: string[] = [line];
			i++;
			while (i < lines.length) {
				const next = lines[i] ?? "";
				if (
					next.trim() === "" ||
					FENCE.test(next) ||
					HEADING.test(next) ||
					RULE.test(next) ||
					QUOTE.test(next) ||
					LIST.test(next) ||
					tableStart(next, lines[i + 1])
				) {
					break;
				}
				para.push(next);
				i++;
			}
			out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
		}
		return out.join("");
	};
	return blocks(source);
}
