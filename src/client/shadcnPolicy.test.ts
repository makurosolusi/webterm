import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clientRoot = path.join(repoRoot, "src/client");
const uiRoot = path.join(clientRoot, "components/ui");

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
      (file) => file.endsWith(".tsx") && !file.includes(`${path.sep}components${path.sep}ui${path.sep}`) && !file.endsWith(".test.tsx"),
    );
    const forbidden = /<(button|input|textarea|select)\b/;
    const violations = (await Promise.all(files.map(async (file) => {
      const source = stripComments(await readFile(file, "utf8"));
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
    const expected = ["button", "card", "input", "label", "textarea", "badge", "separator", "dialog", "alert-dialog", "dropdown-menu", "tabs", "tooltip", "scroll-area", "sheet", "select", "switch", "checkbox", "progress", "skeleton"];
    const missing = expected.filter((file) => !files.has(file));

    expect(missing, `Missing shadcn primitive files: ${missing.join(", ")}`).toEqual([]);
  });
});
