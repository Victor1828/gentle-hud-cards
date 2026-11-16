import { dirname, join } from "node:path";

/** Env override for a gentle-pi install the node-binary heuristic cannot find. */
export const ROOT_OVERRIDE_ENV = "GENTLE_HUD_GENTLE_PI_ROOT";

export interface LocateInput {
	env: Record<string, string | undefined>;
	/** process.execPath: `<prefix>/bin/node`, so globals live in `<prefix>/lib/node_modules`. */
	execPath: string;
	exists(path: string): boolean;
}

/**
 * Find the installed gentle-pi package root, or undefined when it is missing.
 * A root counts only when it still ships `lib/shell-card.ts`, so a renamed or
 * restructured gentle-pi is reported as absent instead of half-loaded.
 */
export function locateGentlePi({ env, execPath, exists }: LocateInput): string | undefined {
	const candidates = [env[ROOT_OVERRIDE_ENV], join(dirname(dirname(execPath)), "lib", "node_modules", "gentle-pi")];
	return candidates.find((root): root is string => !!root && exists(join(root, "lib", "shell-card.ts")));
}
