import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dormir, encerrar } from "./chrome.mjs";

// Um navegador sem interface por job, com VÁRIAS ABAS (Fase 3 / F3.2). Fala CDP no nível do navegador
// (sessões "flatten" por aba). Medido na F3.0: abrir aba custa ~0,15 s e abrir navegador ~0,8 s, então o ganho
// não está em manter o navegador vivo, e sim em ler vários pares ao mesmo tempo (3 abas: ~8 s por par; 6: ~5 s).
//
// Só observa o que a própria página pede (passivo). Nunca chama o RPC do Google por conta própria.

// Quando o Google barra o robô (captcha / "sorry"), tudo para: continuar só piora o bloqueio do IP.
export class ErroBloqueio extends Error {
  constructor(detalhe = "") { super(`google_bloqueou${detalhe ? `: ${detalhe}` : ""}`); this.name = "ErroBloqueio"; }
}
export const paginaBloqueada = (href) => /\/sorry\/|consent\.google\.|recaptcha/i.test(String(href || ""));

// A resposta de preços do Google Voos é um fluxo (vários quadros ao longo de 4 a 30 s). O fim dela é o
// único sinal seguro de que nenhuma oferta de agência vai mais mudar o preço (F3.0: 19 de 19).
const RE_RESULTADOS = /GetShoppingResults/;

export async function abrirNavegador({ porta = 20000 + Math.floor(Math.random() * 20000), bin = process.env.CHROME_BIN || "google-chrome", bloquearMidia = true } = {}) {
  const perfil = mkdtempSync(join(tmpdir(), "perfil-"));
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--window-size=1400,1000", "--lang=pt-BR", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank",
  ], { stdio: "ignore" });

  let erroSpawn = null;
  proc.on("error", (e) => { erroSpawn = e; }); // binário inexistente: sem isso o processo inteiro cairia
  let wsUrl;
  for (let i = 0; i < 120 && !wsUrl && !erroSpawn; i++) {
    await dormir(250);
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* subindo */ }
  }
  if (!wsUrl) { await encerrar(proc, perfil); throw new Error(`navegador não subiu${erroSpawn ? `: ${erroSpawn.message}` : ""}`); }

  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((ok, falha) => { ws.addEventListener("open", ok); ws.addEventListener("error", () => falha(new Error("sem conexão com o navegador"))); setTimeout(() => falha(new Error("sem conexão com o navegador (prazo)")), 15000); });
  } catch (e) { await encerrar(proc, perfil); throw e; }
  let id = 0;
  const espera = new Map();
  const ouvintes = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && espera.has(d.id)) { espera.get(d.id)(d); espera.delete(d.id); }
    else if (d.sessionId && ouvintes.has(d.sessionId)) ouvintes.get(d.sessionId)(d);
  });
  // Cada comando tem prazo (30 s) e, se o navegador cair, todos os pendentes falham na hora: sem isso o job ficaria
  // pendurado até o timeout do workflow.
  const cmd = (method, params = {}, sessionId) => new Promise((resolver) => {
    const i = ++id;
    const timer = setTimeout(() => { if (espera.delete(i)) resolver({ error: { message: `${method}: sem resposta em 30 s` } }); }, 30000);
    espera.set(i, (d) => { clearTimeout(timer); resolver(d); });
    try { ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch { clearTimeout(timer); espera.delete(i); resolver({ error: { message: `${method}: navegador fechado` } }); }
  });
  ws.addEventListener("close", () => { for (const [i, r] of espera) { espera.delete(i); r({ error: { message: "navegador fechou" } }); } });

  async function novaAba() {
    const criada = await cmd("Target.createTarget", { url: "about:blank" });
    if (!criada.result) throw new Error(`não abri a aba: ${criada.error?.message || "?"}`);
    const { targetId } = criada.result;
    const ligada = await cmd("Target.attachToTarget", { targetId, flatten: true });
    if (!ligada.result) throw new Error(`não liguei à aba: ${ligada.error?.message || "?"}`);
    const sid = ligada.result.sessionId;
    const aba = { gsr: novoRastro() };
    ouvintes.set(sid, (m) => {
      const p = m.params || {};
      if (m.method === "Network.requestWillBeSent") {
        if (RE_RESULTADOS.test(p.request?.url || "")) { aba.gsr.iniciou = true; aba.gsr.ativas.add(p.requestId); }
      } else if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") {
        const falhou = m.method === "Network.loadingFailed";
        if (aba.gsr.ativas.delete(p.requestId)) {
          if (falhou) aba.gsr.falhou = true; // resposta abortada: o preço de agência pode nunca ter chegado
          if (aba.gsr.ativas.size === 0) aba.gsr.fimEm = Date.now();
        }
      } else if (m.method === "Fetch.requestPaused") {
        cmd("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sid); // só imagem, fonte e mídia
      }
    });
    await cmd("Page.enable", {}, sid);
    await cmd("Network.enable", {}, sid);
    // As leituras usam getBoundingClientRect: aba nova não herda o tamanho da janela, então fixa um.
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
    await cmd("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
    // Nunca bloquear CSS nem scripts: a página depende deles.
    if (bloquearMidia) await cmd("Fetch.enable", { patterns: [{ resourceType: "Image" }, { resourceType: "Font" }, { resourceType: "Media" }] }, sid);

    aba.navegar = async (url) => { aba.gsr = novoRastro(); aba.inicio = Date.now(); await cmd("Page.navigate", { url }, sid); };
    aba.avaliar = async (fn, ...args) => {
      const r = await cmd("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true }, sid);
      if (r.result?.exceptionDetails) throw new Error("erro na página: " + (r.result.exceptionDetails.exception?.description || "?").slice(0, 200));
      return r.result?.result?.value;
    };
    aba.vivo = () => ws.readyState === 1; // false = o navegador caiu
    aba.endereco = async () => { try { return await aba.avaliar(() => location.href); } catch { return ""; } };
    aba.fechar = async () => { ouvintes.delete(sid); await cmd("Target.closeTarget", { targetId }).catch(() => {}); };
    return aba;
  }

  const fechar = async () => { try { ws.close(); } catch { /* já fechado */ } await encerrar(proc, perfil); };
  return { novaAba, fechar, cmd };
}

function novoRastro() { return { iniciou: false, ativas: new Set(), fimEm: null, falhou: false }; }

// Estado do fluxo de resultados para a regra de fim (ver leitor.mjs).
export const estadoDoFluxo = (aba, agora = Date.now()) => ({
  iniciou: aba.gsr.iniciou,
  ativas: aba.gsr.ativas.size,
  // Fim por FALHA não conta como fim da chegada de preços: cai na regra de estabilidade (plano B).
  fimHaMs: aba.gsr.fimEm === null || aba.gsr.falhou ? null : agora - aba.gsr.fimEm,
});
