import { Channel, invoke } from "@tauri-apps/api/core";

/** Control events emitted by the Rust `ai_http_stream` command. Response
 * bytes arrive as raw ArrayBuffers on a separate channel; a zero-length
 * message there marks "all data delivered" so end/error can't outrun the
 * last chunk. */
type AiStreamEvent =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "end" }
  | { kind: "error"; message: string };

type RequestHeaders = Record<string, string>;

function headerInitToRecord(
  init: HeadersInit | undefined,
): RequestHeaders | undefined {
  if (!init) return undefined;
  const out: RequestHeaders = {};
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k] = String(v);
  }
  return out;
}

/** The AI SDK posts JSON text, so the body crosses IPC as a plain string.
 * Binary inputs are decoded when they're valid UTF-8; anything else is
 * rejected rather than silently corrupted. */
async function bodyToText(
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  let bytes: Uint8Array | undefined;
  if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  }
  if (!bytes) {
    // FormData / URLSearchParams / ReadableStream — uncommon for AI SDK calls.
    return new Response(body as BodyInit).text();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(
      "proxyFetch: binary (non-UTF-8) request bodies are not supported",
    );
  }
}

export function createProxyFetch(
  opts: { allowPrivateNetwork?: boolean } = {},
): typeof fetch {
  const allowPrivate = opts.allowPrivateNetwork === true;
  return async (input, init) => proxyFetchImpl(input, init, allowPrivate);
}

async function proxyFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  allowPrivateNetwork: boolean,
): Promise<Response> {
  const url = input instanceof URL ? input.toString() : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headerInitToRecord(init?.headers);
  const body = await bodyToText(init?.body);

  const signal = init?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }

  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let cancelled = false;
    // Close/error may only fire once the zero-length sentinel confirms every
    // data chunk arrived — the two channels have no cross-ordering guarantee.
    let dataDone = false;
    let finish: (() => void) | null = null;

    const onAbort = () => {
      cancelled = true;
      if (!resolved) {
        reject(makeAbortError());
      } else if (streamController) {
        try {
          streamController.error(makeAbortError());
        } catch {
          /* already closed */
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => {
      if (cancelled) return;
      if (buf.byteLength === 0) {
        dataDone = true;
        finish?.();
        return;
      }
      streamController?.enqueue(new Uint8Array(buf));
    };

    const onEvent = new Channel<AiStreamEvent>();
    onEvent.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "headers": {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              cancelled = true;
            },
          });
          resolved = true;
          resolve(
            new Response(stream, {
              status: event.status,
              headers: new Headers(event.headers),
            }),
          );
          break;
        }
        case "end": {
          finish = () => streamController?.close();
          if (dataDone) finish();
          break;
        }
        case "error": {
          if (!resolved) {
            reject(new Error(event.message));
            break;
          }
          finish = () => streamController?.error(new Error(event.message));
          if (dataDone) finish();
          break;
        }
      }
    };

    invoke("ai_http_stream", {
      url,
      method,
      headers,
      body,
      allowPrivateNetwork,
      onEvent,
      onData,
    }).catch((e) => {
      if (resolved) return; // headers already arrived; chunk-side error wins
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

function makeAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}
