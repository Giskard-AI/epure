import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { ProviderKind } from "../llm/types.js";
import { extractLLMTokenUsage } from "../llm/usage.js";
import type { LLMRequestUsage } from "../usage/token-usage.js";

export function decodeBody(body: Buffer, contentEncoding: string | string[] | undefined): Buffer {
  switch (String(contentEncoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(body);
    case "deflate":
      return inflateSync(body);
    case "br":
      return brotliDecompressSync(body);
    default:
      return body;
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const OPENAI_COMPATIBLE: ReadonlySet<ProviderKind> = new Set(["openai", "openrouter", "azure", "azure_ai"]);

export interface MeteredRequest {
  readonly body: Buffer;
  // As the sandbox called it: aliases and SDK defaults can differ from the configured model.
  readonly model: string;
}

// The sandbox writes this label into the plan state.
const MODEL_LABEL = /^[\w.@:/-]{1,128}$/;
export const UNKNOWN_MODEL = "unknown";

/**
 * OpenAI-compatible streams report usage only when the request asks for it. Throws when the body
 * cannot be re-serialised (too deeply nested).
 */
export function meterRequest(
  provider: ProviderKind,
  path: string,
  body: Buffer,
  contentEncoding: string | string[] | undefined
): MeteredRequest {
  const json = contentEncoding ? undefined : asObject(parseJson(body.toString("utf8")));
  // Azure deployments, Gemini and Vertex route by path: the body's model is not what runs.
  const label = /\/(?:models|deployments)\/([^/:]+)/.exec(path)?.[1] ?? json?.model;
  const model = typeof label === "string" && MODEL_LABEL.test(label) ? label : UNKNOWN_MODEL;
  if (!json || !OPENAI_COMPATIBLE.has(provider) || !path.endsWith("/chat/completions") || json.stream !== true) {
    return { body, model };
  }
  const streamOptions = asObject(json.stream_options) ?? {};
  if (streamOptions.include_usage === true) {
    return { body, model };
  }
  return {
    body: Buffer.from(JSON.stringify({ ...json, stream_options: { ...streamOptions, include_usage: true } })),
    model
  };
}

// A later event's null or missing field must not erase an earlier count (Anthropic's message_delta).
function mergeCounts(into: JsonObject | undefined, from: JsonObject): JsonObject {
  const merged: JsonObject = { ...into };
  for (const [key, value] of Object.entries(from)) {
    const details = asObject(value);
    if (typeof value === "number") {
      merged[key] = value;
    } else if (details) {
      merged[key] = {
        ...asObject(merged[key]),
        ...Object.fromEntries(Object.entries(details).filter(([, v]) => typeof v === "number"))
      };
    }
  }
  return merged;
}

export interface ResponseUsageMeter {
  onChunk(chunk: Uint8Array): void;
  onEnd(): LLMRequestUsage;
}

/**
 * Reads the usage of one relayed response: Anthropic `message_start` then `message_delta`, OpenAI's
 * last chat chunk or `response.completed`, Gemini's last `usageMetadata`, or a plain JSON body.
 */
export function meterResponse(
  provider: ProviderKind,
  model: string,
  contentType: string,
  contentEncoding: string | string[] | undefined
): ResponseUsageMeter {
  const sse = contentType.includes("text/event-stream");
  const json = contentType.includes("json");
  // Compressed streams and JSON bodies are read whole at the end; plain streams line by line.
  const buffered = json || (sse && Boolean(contentEncoding));
  const raw: Buffer[] = [];
  const decoder = new TextDecoder();
  let partialLine = "";
  const found: { usage?: JsonObject; usageMetadata?: JsonObject } = {};

  const absorbEvent = (value: unknown): void => {
    const event = asObject(value);
    const usage =
      asObject(event?.usage) ??
      asObject(asObject(event?.message)?.usage) ??
      asObject(asObject(event?.response)?.usage);
    if (usage) {
      found.usage = mergeCounts(found.usage, usage);
    }
    const metadata = asObject(event?.usageMetadata);
    if (metadata) {
      found.usageMetadata = metadata;
    }
  };
  const absorb = (value: unknown): void => {
    // Gemini streamGenerateContent without alt=sse answers a JSON array of chunks.
    (Array.isArray(value) ? value : [value]).forEach(absorbEvent);
  };

  const readLines = (text: string): void => {
    const lines = (partialLine + text).split(/\r?\n/);
    partialLine = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        absorb(parseJson(line.slice("data:".length).trim()));
      }
    }
  };

  return {
    onChunk(chunk) {
      if (buffered) {
        raw.push(Buffer.from(chunk));
      } else if (sse) {
        readLines(decoder.decode(chunk, { stream: true }));
      }
    },
    onEnd() {
      if (buffered) {
        try {
          const text = decodeBody(Buffer.concat(raw), contentEncoding).toString("utf8");
          if (sse) {
            readLines(`${text}\n`);
          } else {
            absorb(parseJson(text));
          }
        } catch {
          // An undecodable body has no readable usage.
        }
      } else if (sse) {
        readLines(`${decoder.decode()}\n`);
      }
      return extractLLMTokenUsage(provider, model, found) ?? { provider, model, unavailable: true };
    }
  };
}
