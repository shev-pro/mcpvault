/**
 * Parse runtime options without importing server.ts, which starts the MCP
 * server as a side effect. Unknown positional arguments remain part of the
 * vault path so unquoted paths with spaces continue to work.
 */
function parsePositiveFiniteNumber(value, flagName) {
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flagName} requires a positive number`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flagName} must be a positive number`);
    }
    return parsed;
}
export function parseCliArgs(args) {
    const pathArgs = [];
    const excludePaths = [];
    let readOnly = false;
    let maxUploadMb;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--max-upload-mb") {
            maxUploadMb = parsePositiveFiniteNumber(args[index + 1], "--max-upload-mb");
            index += 1;
            continue;
        }
        if (arg.startsWith("--max-upload-mb=")) {
            maxUploadMb = parsePositiveFiniteNumber(arg.slice("--max-upload-mb=".length), "--max-upload-mb");
            continue;
        }
        if (arg === "--read-only") {
            const next = args[index + 1]?.toLowerCase();
            if (next === "true" || next === "false") {
                readOnly = next === "true";
                index += 1;
            }
            else {
                readOnly = true;
            }
            continue;
        }
        if (arg.startsWith("--read-only=")) {
            const value = arg.slice("--read-only=".length).toLowerCase();
            if (value !== "true" && value !== "false") {
                throw new Error("--read-only must be true or false");
            }
            readOnly = value === "true";
            continue;
        }
        if (arg === "--exclude") {
            const value = args[index + 1]?.trim();
            if (!value || value.startsWith("--")) {
                throw new Error("--exclude requires a subtree path");
            }
            excludePaths.push(value);
            index += 1;
            continue;
        }
        if (arg.startsWith("--exclude=")) {
            const value = arg.slice("--exclude=".length).trim();
            if (!value) {
                throw new Error("--exclude requires a subtree path");
            }
            excludePaths.push(value);
            continue;
        }
        pathArgs.push(arg);
    }
    return {
        vaultPathArg: pathArgs.join(" ").trim(),
        readOnly,
        excludePaths,
        ...(maxUploadMb !== undefined ? { maxUploadMb } : {}),
    };
}
