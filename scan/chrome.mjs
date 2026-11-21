import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Encerra o navegador e APAGA o perfil temporário (antes o perfil-* ficava para sempre em D:\Temp: 333 pastas).
// O navegador ainda segura arquivos por instantes depois de morrer; por isso espera a saída e tenta apagar de novo.
export async function encerrar(proc, perfil) {
  if (proc.exitCode === null && proc.signalCode === null) {
    const saiu = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await Promise.race([saiu, dormir(3000)]);
  }
  for (let i = 0; i < 8; i++) {
    try { rmSync(perfil, { recursive: true, force: true }); return true; } catch { await dormir(400); }
  }
  return false;
}

// Sobe um Chrome sem interface e fala com ele pelo protocolo de depuração (CDP), sem dependências.
// A porta é sorteada: no PC vários jobs rodam ao mesmo tempo, cada um com o seu Chrome.
export async function abrirChrome({ porta = 20000 + Math.floor(Math.random() * 20000), bin = process.env.CHROME_BIN || "google-chrome" } = {}) {
  const perfil = mkdtempSync(join(tmpdir(), "perfil-"));
  const proc = spawn(bin, [
    "--headless=new", `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, "--no-sandbox",
    "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1400,1000", "--lang=pt-BR", "about:blank",
  ], { stdio: "ignore" });

  let alvo;
  for (let i = 0; i < 120 && !alvo; i++) {
    await dormir(500);
    try { alvo = (await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* ainda subindo */ }
  }
  if (!alvo) { await encerrar(proc, perfil); throw new Error("Chrome não subiu"); }

  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const espera = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && espera.has(d.id)) { espera.get(d.id)(d); espera.delete(d.id); }
  });
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; espera.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cmd("Page.enable");

  // Roda uma função de verdade (não texto) dentro da página; os argumentos precisam ser JSON.
  async function avaliar(fn, ...args) {
    const r = await cmd("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("erro na página: " + (r.result.exceptionDetails.exception?.description || "?").slice(0, 200));
    return r.result?.result?.value;
  }
  const navegar = (url) => cmd("Page.navigate", { url });
  const recarregar = () => cmd("Page.reload");
  const fechar = async () => { try { ws.close(); } catch { /* já fechado */ } await encerrar(proc, perfil); };
  return { avaliar, navegar, recarregar, fechar, cmd };
}
