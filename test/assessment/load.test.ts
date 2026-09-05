import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAssessmentFile } from "../../src/assessment/load.js";
import { runDoctor } from "../../src/commands/doctor.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aw-assessment-"));
  directories.push(directory);
  return directory;
}

const ASSESSMENT = `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
references:
  local:
    - path: references/faq.md
      id: synthetic-faq
      kind: reference_facts
`;

const CONFIG = `version: 1
target:
  name: chat-staging
  connector: http
  base_url: \${CHATBOT_BASE_URL}
  operations:
    send:
      method: POST
      path: /chat
`;

describe("assessment file loader", () => {
  it("loads YAML, hashes references, and freezes the assessment", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(resolve(cwd, "references"));
    await writeFile(resolve(cwd, "augmentworks.assessment.yaml"), ASSESSMENT, "utf8");
    await writeFile(resolve(cwd, "references/faq.md"), "# Synthetic FAQ\n", "utf8");

    const loaded = await loadAssessmentFile({
      path: "augmentworks.assessment.yaml",
      cwd,
      profile: "quick"
    });

    expect(loaded.profile).toBe("quick");
    expect(loaded.evaluationMode).toBe("hybrid");
    expect(loaded.disclosureVersion).toBe("aw-judge-disclosure/1");
    expect(loaded.yamlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.freezeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.localReferences).toHaveLength(1);
    expect(loaded.localReferences[0]?.relativePath).toBe("references/faq.md");
    expect(loaded.document.packets[0]).toEqual({ key: "response-quality", version: "0.1.0" });
  });

  it("rejects path traversal, globs, credentials, and symlink escapes", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(resolve(cwd, "references"));
    await writeFile(resolve(cwd, "references/faq.md"), "ok\n", "utf8");
    await writeFile(
      resolve(cwd, "traversal.yaml"),
      `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
references:
  local:
    - path: references/../../secret.md
      id: escape
      kind: reference_facts
`,
      "utf8"
    );
    await writeFile(
      resolve(cwd, "glob.yaml"),
      `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
references:
  local:
    - path: references/*.md
      id: glob
      kind: reference_facts
`,
      "utf8"
    );
    await writeFile(
      resolve(cwd, "creds.yaml"),
      `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
judge_api_key: never-store-this
`,
      "utf8"
    );
    const outside = resolve(cwd, "outside.md");
    await writeFile(outside, "secret\n", "utf8");
    await symlink(outside, resolve(cwd, "references/link.md"));
    await writeFile(
      resolve(cwd, "symlink.yaml"),
      `schema_version: aw-assessment-file/1
profile: quick
evaluation_mode: hybrid
packets:
  - key: response-quality
    version: 0.1.0
references:
  local:
    - path: references/link.md
      id: linked
      kind: reference_facts
`,
      "utf8"
    );

    await expect(loadAssessmentFile({ path: "traversal.yaml", cwd })).rejects.toMatchObject({
      code: "ASSESSMENT_FILE_INVALID"
    });
    await expect(loadAssessmentFile({ path: "glob.yaml", cwd })).rejects.toMatchObject({
      code: "ASSESSMENT_FILE_INVALID"
    });
    await expect(loadAssessmentFile({ path: "creds.yaml", cwd })).rejects.toMatchObject({
      code: "ASSESSMENT_CREDENTIAL_FORBIDDEN"
    });
    await expect(loadAssessmentFile({ path: "symlink.yaml", cwd })).rejects.toMatchObject({
      code: "ASSESSMENT_REFERENCE_INVALID"
    });
  });
});

describe("doctor --assessment", () => {
  it("validates an assessment file without target or cloud calls", async () => {
    const cwd = await temporaryDirectory();
    await mkdir(resolve(cwd, "references"));
    await writeFile(resolve(cwd, "augmentworks.yaml"), CONFIG, "utf8");
    await writeFile(resolve(cwd, "augmentworks.assessment.yaml"), ASSESSMENT, "utf8");
    await writeFile(resolve(cwd, "references/faq.md"), "# Synthetic FAQ\n", "utf8");

    const report = await runDoctor({
      cwd,
      assessment: "augmentworks.assessment.yaml",
      profile: "quick",
      processEnv: {
        CHATBOT_BASE_URL: "http://127.0.0.1:9",
        CHATBOT_API_KEY: "unused-doctor-assessment"
      }
    });

    expect(report.ok).toBe(true);
    expect(report.offline).toBe(true);
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "ASSESSMENT_FILE_VALID",
        "ASSESSMENT_YAML_HASH",
        "ASSESSMENT_REFERENCES",
        "ASSESSMENT_FREEZE_HASH",
        "OFFLINE_CHECK_COMPLETE"
      ])
    );
    expect(report.assessment?.freezeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.diagnostics.some((item) => item.message.includes("http://127.0.0.1:9"))).toBe(
      false
    );
  });
});
