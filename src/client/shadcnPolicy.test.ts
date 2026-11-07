import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(repoRoot, "src/client");
const uiRoot = path.join(clientRoot, "components/ui");
// Native form controls are the sanctioned implementation for VS Code-metric chrome
// (plan 0.3): shadow-DOM web components break label association and testing-library.
// These files are primitives, the same layer as components/ui, not screens.
const vscodePrimitivesRoot = path.join(clientRoot, "components/vscode") + path.sep;
/**
 * VS Code-metric screens that intentionally render native controls (plan 0.3: label
 * association + testing-library). Explicit list, no globs: a NEW file using raw controls
 * must fail this guard and be added here deliberately.
 */
const vscodeScreens = new Set([
  // Browser node: URL bar and cookie import form keep native controls so label queries and file input work.
  "src/client/BrowserToolbar.tsx",
  "src/client/BrowserCookieDialog.tsx",
  // Settings / Env / Channels
  "src/client/SettingsPanel.tsx",
  "src/client/SettingsAgents.tsx",
  // Native <select>/checkbox restyled with VS Code metrics (hybrid settings screen).
  "src/client/SettingsControls.tsx",
  "src/client/SettingsFields.tsx",
  // Sessions sidebar
  "src/client/SessionsFilter.tsx",
  "src/client/SessionsGroupingTabs.tsx",
  // Bottom panel / Chat (the Needs-you strip and its approval cards use the chat's VS Code-metric row buttons)
  "src/client/bottomPanelTabs.tsx",
  "src/client/inboxApprovalDialog.tsx",
  "src/client/inboxPanelSurface.tsx",
  "src/client/ChatPanel.tsx",
  // Secondary side bar: its title-bar toggle is a `titlebar__action` like the title bar's own (WorkspaceBar).
  "src/client/App.secondarySideBar.tsx",
  "src/client/chat/chatComposer.tsx",
  "src/client/chat/chatConversation.tsx",
  "src/client/chat/chatMessages.tsx",
  "src/client/chat/chatApprovalCard.tsx",
  "src/client/chat/needsYouStrip.tsx",
]);

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
    }),
  );
  return files.flat();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("shadcn policy", () => {
  it("does not use raw form controls outside shadcn UI primitives", async () => {
    const files = (await filesUnder(clientRoot)).filter(
      (file) =>
        file.endsWith(".tsx") &&
        !file.includes(`${path.sep}components${path.sep}ui${path.sep}`) &&
        !file.startsWith(vscodePrimitivesRoot) &&
        !file.endsWith(".test.tsx"),
    );
    const forbidden = /<(button|input|textarea|select)\b/;
    const violations = (await Promise.all(files.map(async (file) => {
      const source = stripComments(await readFile(file, "utf8"));
      // The VS Code phase deliberately keeps native controls on hybrid screens so label
      // association and testing-library queries keep working (RND/20 §0.3). Files that consume
      // the VS Code layer are allowed to render native controls and style them with metrics.
      if (
        /from\s+["'][^"']*vscode\//.test(source) ||
        vscodeScreens.has(path.relative(repoRoot, file))
      ) return null;
      return forbidden.test(source) ? path.relative(repoRoot, file) : null;
    }))).filter((file): file is string => file !== null);

    expect(violations, `Raw form-control markup found in: ${violations.join(", ")}`).toEqual([]);
  });

  it("keeps cn imports pointed at the shared utility", async () => {
    const files = (await filesUnder(uiRoot)).filter((file) => file.endsWith(".tsx"));
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/from\s+["']cn["']/.test(source)) violations.push(`${path.relative(repoRoot, file)} imports from "cn"`);
      if (/\bcn\s*\(/.test(source) && !/from\s+["']@\/lib\/utils["']/.test(source)) {
        violations.push(`${path.relative(repoRoot, file)} uses cn without importing @/lib/utils`);
      }
    }

    expect(violations, violations.join("; ")).toEqual([]);
  });

  it("uses the intended Tailwind and shadcn configuration", async () => {
    const css = await readFile(path.join(clientRoot, "index.css"), "utf8");
    expect(css, "index.css must import tailwindcss/theme.css").toMatch(/@import\s+["']tailwindcss\/theme\.css["']/);
    expect(css, "index.css must import tailwindcss/utilities.css").toMatch(/@import\s+["']tailwindcss\/utilities\.css["']/);
    expect(css, "index.css must not import the full tailwindcss entry").not.toContain('@import "tailwindcss";');

    const config = JSON.parse(await readFile(path.join(repoRoot, "components.json"), "utf8"));
    expect(config.style, "components.json style must be new-york").toBe("new-york");
    expect(config.tailwind?.css, "components.json tailwind.css must target src/client/index.css").toBe("src/client/index.css");
    expect(config.aliases?.ui, "components.json aliases.ui must be @/components/ui").toBe("@/components/ui");
  });

  it("keeps the expected shadcn primitives present", async () => {
    const files = new Set((await readdir(uiRoot)).filter((file) => file.endsWith(".tsx")).map((file) => file.replace(/\.tsx$/, "")));
    const expected = ["button", "card", "input", "label", "textarea", "badge", "dialog", "alert-dialog", "tabs", "scroll-area", "select", "checkbox"];
    const missing = expected.filter((file) => !files.has(file));

    expect(missing, `Missing shadcn primitive files: ${missing.join(", ")}`).toEqual([]);
  });
});
