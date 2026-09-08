import {
  FestoClient,
  FestoError,
  collectRepairs,
  errorMessage,
} from '@/lib/festo/client';
import { validateFilters } from '@/lib/festo/shared';
import { NO_STORE, readBody, tokenFrom, errorResponse } from '@/lib/festo/http';
import type { ExportEvent } from '@/lib/festo/types';
export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    let filters;
    try {
      filters = validateFilters(body);
    } catch (e) {
      throw new FestoError((e as Error).message, 400);
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal]);
    const client = new FestoClient(tokenFrom(request), { signal });
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: ExportEvent) => {
          if (!closed)
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        void (async () => {
          try {
            const result = await collectRepairs(client, filters, emit, signal);
            emit({ type: 'complete', ...result });
          } catch (error) {
            if (!signal.aborted)
              emit({
                type: 'error',
                message: errorMessage(error),
                status: error instanceof FestoError ? error.status : 502,
              });
          } finally {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        })();
      },
      cancel() {
        closed = true;
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/x-ndjson; charset=utf-8',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
