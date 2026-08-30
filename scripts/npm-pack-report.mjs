function decodeJsonValue(source, start) {
  const opening = source[start];
  if (opening !== "[" && opening !== "{") return undefined;

  const stack = [opening];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character);
      continue;
    }
    if (character !== "]" && character !== "}") continue;

    const expectedOpening = character === "]" ? "[" : "{";
    if (stack.pop() !== expectedOpening) return undefined;
    if (stack.length !== 0) continue;

    try {
      return JSON.parse(source.slice(start, index + 1));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function looksLikePackReport(value) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const report = value[0];
  return (
    report !== null &&
    typeof report === "object" &&
    (Object.hasOwn(report, "filename") || Object.hasOwn(report, "files"))
  );
}

export function parsePackReport(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // npm can forward lifecycle-script stdout before its --json result. Scan
    // complete JSON values instead of assuming the entire stream is JSON.
    for (let index = 0; index < stdout.length; index += 1) {
      if (stdout[index] !== "[") continue;
      const candidate = decodeJsonValue(stdout, index);
      if (looksLikePackReport(candidate)) parsed = candidate;
    }
  }

  if (parsed === undefined) {
    throw new Error(`npm pack did not return a JSON report\n${stdout}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack must produce exactly one tarball");
  }

  const report = parsed[0];
  if (report === null || typeof report !== "object") {
    throw new Error("npm pack returned an invalid report");
  }
  if (typeof report.filename !== "string") {
    throw new Error("npm pack report is missing its filename");
  }
  if (!Array.isArray(report.files)) {
    throw new Error("npm pack report is missing its file inventory");
  }
  return report;
}
