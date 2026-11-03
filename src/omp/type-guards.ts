/** Canonical object guard for this package: narrows to an object; fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
