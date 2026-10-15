export type Handler = (req: Request) => Promise<Response> | Response;

/** Chama um handler com a URL e a chave de API informadas. */
export function call(handler: Handler, url: string, key?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set("x-api-key", key);
  return handler(new Request(`https://api.test${url}`, { ...init, headers }));
}

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value), headers: { "content-type": "application/json" } };
}

/** Define variáveis de ambiente e devolve a função que restaura os valores anteriores. */
export function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
