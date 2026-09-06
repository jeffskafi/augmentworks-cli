import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guidance = (await readFile(resolve(root, "agent-resources/guidance.md"), "utf8")).trim();

const skill = `---
name: augmentworks
description: This skill should be used when the user asks to integrate AugmentWorks, run local agent testing, or the repository already has augmentworks.yaml. Do not use it for unrelated coding.
---

${guidance}
`;

const cursor = `---
description: Integrate or run AugmentWorks CLI assessments when the user asks for AugmentWorks, local agent testing, or the repo already has augmentworks.yaml. Do not use for unrelated coding.
alwaysApply: false
---

${guidance}
`;

const codex = `# AugmentWorks (optional snippet)

Copy into a repository \`AGENTS.md\` only when that repository uses AugmentWorks.
Do not add this globally. Installation is manual and reversible.

${guidance}
`;

await mkdir(resolve(root, "agent-resources/augmentworks"), { recursive: true });
await mkdir(resolve(root, "agent-resources/cursor"), { recursive: true });
await mkdir(resolve(root, "agent-resources/codex"), { recursive: true });
await writeFile(resolve(root, "agent-resources/augmentworks/SKILL.md"), `${skill.trim()}\n`, "utf8");
await writeFile(resolve(root, "agent-resources/cursor/augmentworks.mdc"), `${cursor.trim()}\n`, "utf8");
await writeFile(resolve(root, "agent-resources/codex/AGENTS.snippet.md"), `${codex.trim()}\n`, "utf8");
process.stdout.write("Wrote agent-resources wrappers from agent-resources/guidance.md\n");
