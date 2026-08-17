export class RequestBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413) {
    super(message);
  }
}

export async function readJsonBody<T>(request: Request, maxBytes = 16 * 1024): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new RequestBodyError("Solicitud inválida.", 400);
    if (length > maxBytes) throw new RequestBodyError("La solicitud excede el tamaño permitido.", 413);
  }
  if (!request.body) throw new RequestBodyError("Solicitud inválida.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError("La solicitud excede el tamaño permitido.", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("Solicitud inválida.", 400);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as T;
  } catch {
    throw new RequestBodyError("Solicitud inválida.", 400);
  }
}
