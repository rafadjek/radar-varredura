import { dormir } from "./chrome.mjs";

// Envia um resultado ao Worker. Sem WORKER_URL (teste local), só mostra o que enviaria.
export async function postar(caminho, corpo, { fetcher = fetch, env = process.env, esperar = dormir, tentativas = 3 } = {}) {
  const base = env.WORKER_URL;
  if (!base) {
    console.log("[teste sem Worker]", caminho, JSON.stringify(corpo).slice(0, 300));
    return { seco: true };
  }
  let ultimo;
  for (let t = 1; t <= tentativas; t++) {
    try {
      const resp = await fetcher(base.replace(/\/$/, "") + caminho, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": env.INGEST_SECRET || "" },
        body: JSON.stringify(corpo),
      });
      if (resp.ok) return { ok: true };
      ultimo = new Error(`Worker respondeu ${resp.status}`);
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) break;
    } catch (e) { ultimo = e; }
    await esperar(1000 * t);
  }
  throw ultimo;
}

// Lê do Worker (GET com o segredo), com as mesmas repetições do POST. Devolve o JSON.
export async function pegar(caminho, { fetcher = fetch, env = process.env, esperar = dormir, tentativas = 3 } = {}) {
  const base = env.WORKER_URL;
  if (!base) throw new Error("WORKER_URL não configurado");
  let ultimo;
  for (let t = 1; t <= tentativas; t++) {
    try {
      const resp = await fetcher(base.replace(/\/$/, "") + caminho, { headers: { "x-ingest-secret": env.INGEST_SECRET || "" } });
      if (resp.ok) return await resp.json();
      ultimo = new Error(`Worker respondeu ${resp.status}`);
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) break;
    } catch (e) { ultimo = e; }
    await esperar(1000 * t);
  }
  throw ultimo;
}

export const etapa = (job, nome, detalhe) => postar("/api/varredura/etapa", { job, etapa: nome, ...(detalhe ? { detalhe } : {}) });
