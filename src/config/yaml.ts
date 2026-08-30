import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

export class StrictYamlError extends Error {
  readonly code: string;
  readonly path: string | undefined;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "StrictYamlError";
    this.code = code;
    this.path = path;
  }
}

const CORE_TAGS = new Set([
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:map"
]);

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent.length === 0 ? key : `${parent}.${key}`;
}

function inspectNode(node: unknown, path = ""): void {
  if (node === null || node === undefined) return;
  if (isAlias(node)) {
    throw new StrictYamlError(
      "YAML_ALIAS_FORBIDDEN",
      "YAML aliases and anchors are not allowed in AugmentWorks configuration.",
      path || undefined
    );
  }

  if (typeof node === "object" && "tag" in node) {
    const tag = (node as { tag?: unknown }).tag;
    if (typeof tag === "string" && !CORE_TAGS.has(tag)) {
      throw new StrictYamlError(
        "YAML_CUSTOM_TAG_FORBIDDEN",
        `Custom YAML tag ${JSON.stringify(tag)} is not allowed.`,
        path || undefined
      );
    }
  }

  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new StrictYamlError(
          "YAML_KEY_INVALID",
          "Every YAML mapping key must be a plain string.",
          path || undefined
        );
      }
      const key = pair.key.value;
      const nextPath = childPath(path, key);
      if (key === "<<") {
        throw new StrictYamlError(
          "YAML_MERGE_FORBIDDEN",
          "YAML merge keys are not allowed in AugmentWorks configuration.",
          nextPath
        );
      }
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new StrictYamlError(
          "YAML_KEY_FORBIDDEN",
          `YAML key ${JSON.stringify(key)} is reserved for prototype-safety.`,
          nextPath
        );
      }
      inspectNode(pair.value, nextPath);
    }
    return;
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => inspectNode(item, childPath(path, index)));
  }
}

export function parseYamlStrict(source: string): unknown {
  const document = parseDocument(source, {
    schema: "core",
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true
  });

  const firstProblem = document.errors[0] ?? document.warnings[0];
  if (firstProblem !== undefined) {
    const problemCode = "code" in firstProblem ? String(firstProblem.code) : "";
    const code = problemCode === "DUPLICATE_KEY"
      ? "YAML_DUPLICATE_KEY"
      : problemCode === "TAG_RESOLVE_FAILED"
        ? "YAML_CUSTOM_TAG_FORBIDDEN"
        : "YAML_PARSE_ERROR";
    throw new StrictYamlError(code, firstProblem.message);
  }

  inspectNode(document.contents);
  return document.toJS({ maxAliasCount: 0 });
}
