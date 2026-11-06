// Type of distAssets.generated.ts, which scripts/embedDist.ts writes during `bun run build` and git
// ignores (a tracked file rewritten by every build dirtied the tree). tsc reads the .ts when it exists
// and this declaration on a fresh tree; at runtime a missing module means "nothing embedded".
export declare const assets: Record<string, string>
