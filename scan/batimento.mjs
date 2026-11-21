// Roda no PC do Rafael junto com os runners: avisa o Worker, de tempos em tempos, que o PC está ligado e com
// runner ativo, para as buscas irem ao PC (IP brasileiro) em vez do GitHub. Lê WORKER_URL e INGEST_SECRET do
// ambiente do usuário (nunca de arquivo do projeto).
import { execSync } from "node:child_process";
import { postar } from "./enviar.mjs";
import { dormir } from "./chrome.mjs";

const INTERVALO_MS = 8 * 60 * 1000;

function runnerAtivo() {
  try { return /Runner\.Listener\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq Runner.Listener.exe" /NH', { encoding: "utf8" })); }
  catch { return false; }
}

if (!process.env.WORKER_URL || !process.env.INGEST_SECRET) { console.error("falta WORKER_URL/INGEST_SECRET no ambiente do usuário"); process.exit(2); }
for (;;) {
  if (runnerAtivo()) {
    try { await postar("/api/varredura/pc", { pc: "pc-brasil" }); console.log(new Date().toISOString(), "batimento enviado"); }
    catch (e) { console.log(new Date().toISOString(), "falha no batimento:", e.message); }
  } else console.log(new Date().toISOString(), "runner parado, sem batimento");
  await dormir(INTERVALO_MS);
}
