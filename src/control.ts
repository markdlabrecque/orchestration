import { CONTRACT, capabilitiesResponse } from "./capabilities.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function controlResponse(stdin: string) {
  const base = { contract: CONTRACT, receipt: null, snapshot: null };
  const reject = (code: string, message: string) => ({
    ...base,
    outcome: "rejected" as const,
    code,
    message,
  });
  let request: unknown;
  try {
    request = JSON.parse(stdin);
  } catch {
    return reject("invalid-request", "Expected one JSON request object");
  }
  if (!isObject(request))
    return reject("invalid-request", "Expected a request object");
  const match =
    typeof request.contract === "string"
      ? /^orch\.control\/(\d+)$/.exec(request.contract)
      : null;
  if (!match)
    return reject("invalid-request", "Expected contract orch.control/<major>");
  if (Number(match[1]) !== 1)
    return {
      ...reject(
        "unsupported-version",
        `Unsupported contract ${request.contract}`,
      ),
      supportedMajors: [1],
    };
  if (typeof request.requestId !== "string" || !request.requestId.trim())
    return reject("invalid-request", "Expected a non-empty requestId string");
  if (typeof request.op !== "string" || !request.op.trim())
    return reject("invalid-request", "Expected a non-empty op string");
  if ("params" in request && !isObject(request.params))
    return reject("invalid-request", "Expected params to be an object");
  if (request.op !== "capabilities")
    return reject("unsupported-op", `Unsupported op: ${request.op}`);
  const { capabilities, supportedMajors } = capabilitiesResponse();
  return {
    ...base,
    outcome: "accepted" as const,
    code: null,
    supportedMajors,
    capabilities,
  };
}
