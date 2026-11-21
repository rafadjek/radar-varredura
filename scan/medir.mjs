// Medição da Fase 3 / etapa F3.0 (SÓ LOCAL, não entra em workflow).
// Responde: (1) qual chamada de rede traz o preço de agência e há sinal de fim da chegada?
//           (2) curva de chegada (1º preço x preço final) em 20 pares;
//           (3) um Edge com 1, 3 e 6 abas: mesmo preço? atraso? página "sorry"?
//           (4) custo de abrir Edge novo x aba nova.
// Só observa passivamente o que a própria página pede (nada de chamadas próprias ao RPC do Google).
// Orçamento: 20 (curva) + 6 + 6 + 6 (abas) = 38 consultas, espaçadas. Teto duro: 60.
//
// Uso:  node scan/medir.mjs tudo      (≈ 20 min; grava D:\Temp\medicao-f30\resultado.json)
//       node scan/medir.mjs analisar  (lê o JSON e imprime as tabelas)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dormir } from "./chrome.mjs";
import { urlBusca } from "./confirmar.mjs";
import { rotaConfere, datasConferem } from "./pagina.mjs";

const SAIDA = "D:\\Temp\\medicao-f30";
const ARQ = join(SAIDA, "resultado.json");
const BIN = process.env.CHROME_BIN || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TETO_CONSULTAS = 60;
let consultas = 0;

// Os 20 pares: rotas e datas variadas (fev–abr/2027). Os 3 primeiros têm preço conhecido no Google do Rafael.
export const PARES = [
  ["GRU", "JDO", "2027-02-19", "2027-02-25"], ["SAO", "SSA", "2027-02-20", "2027-03-02"], ["SAO", "POA", "2027-02-19", "2027-02-25"],
  ["SAO", "RIO", "2027-02-19", "2027-02-25"], ["BSB", "POA", "2027-03-05", "2027-03-10"], ["GRU", "CWB", "2027-03-12", "2027-03-16"],
  ["CGH", "REC", "2027-03-19", "2027-03-26"], ["GRU", "FOR", "2027-04-09", "2027-04-14"], ["GRU", "SSA", "2027-03-05", "2027-03-12"],
  ["CGH", "POA", "2027-04-16", "2027-04-20"], ["VCP", "REC", "2027-03-26", "2027-04-02"], ["GRU", "BSB", "2027-03-12", "2027-03-17"],
  ["SAO", "FLN", "2027-02-26", "2027-03-03"], ["SAO", "BEL", "2027-03-19", "2027-03-26"], ["RIO", "POA", "2027-03-12", "2027-03-17"],
  ["BHZ", "REC", "2027-04-02", "2027-04-07"], ["GRU", "MAO", "2027-04-16", "2027-04-23"], ["GRU", "NAT", "2027-02-26", "2027-03-05"],
  ["CGH", "CWB", "2027-03-26", "2027-03-30"], ["SAO", "VIX", "2027-04-09", "2027-04-13"],
].map(([origem, destino, ida, volta]) => ({ origem, destino, ida, volta }));

// ---------- Navegador (nível do navegador, várias abas por sessão CDP "flatten") ----------
async function abrirEdge() {
  const t0 = Date.now();
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const perfil = mkdtempSync(join(tmpdir(), "perfil-medir-"));
  const proc = spawn(BIN, [
    "--headless=new", `--remote-debugging-port=${porta}`, `--user-data-dir=${perfil}`, "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--window-size=1400,1000", "--lang=pt-BR", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank",
  ], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 120 && !wsUrl; i++) {
    await dormir(250);
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${porta}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* subindo */ }
  }
  if (!wsUrl) { proc.kill(); throw new Error("Edge não subiu"); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const espera = new Map();
  const ouvintes = new Map(); // sessionId -> função
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && espera.has(d.id)) { espera.get(d.id)(d); espera.delete(d.id); }
    else if (d.sessionId && ouvintes.has(d.sessionId)) ouvintes.get(d.sessionId)(d);
  });
  const cmd = (method, params = {}, sessionId) => new Promise((r) => {
    const i = ++id; espera.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const fechar = async () => {
    try { ws.close(); } catch { /* já fechado */ }
    proc.kill();
    await dormir(2000);
    try { rmSync(perfil, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* o resto some depois */ }
  };
  return { cmd, ouvir: (sid, fn) => ouvintes.set(sid, fn), fechar, subiuMs: Date.now() - t0 };
}

async function novaAba(br, { bloquear = false } = {}) {
  const t0 = Date.now();
  const { result: { targetId } } = await br.cmd("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId: sid } } = await br.cmd("Target.attachToTarget", { targetId, flatten: true });
  const aba = { sid, targetId, reqs: new Map(), pend: new Set(), nav: 0, corpos: false, ordem: 0 };
  br.ouvir(sid, (m) => {
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
      const tipo = p.type || "?";
      aba.reqs.set(p.requestId, { id: p.requestId, url: p.request.url, tipo, ini: Date.now() - aba.nav });
      if (tipo === "XHR" || tipo === "Fetch") aba.pend.add(p.requestId);
    } else if (m.method === "Network.responseReceived") {
      const r = aba.reqs.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
    } else if (m.method === "Network.loadingFinished") {
      const r = aba.reqs.get(p.requestId);
      if (r) {
        r.fim = Date.now() - aba.nav; r.bytes = p.encodedDataLength;
        if (aba.corpos && (r.tipo === "XHR" || r.tipo === "Fetch") && /google\.com/.test(r.url)) {
          r.corpoP = br.cmd("Network.getResponseBody", { requestId: p.requestId }, sid).then((x) => x.result?.body || "").catch(() => "");
        }
      }
      aba.pend.delete(p.requestId);
    } else if (m.method === "Network.loadingFailed") {
      const r = aba.reqs.get(p.requestId); if (r) { r.falhou = p.errorText; r.fim = Date.now() - aba.nav; }
      aba.pend.delete(p.requestId);
    } else if (m.method === "Fetch.requestPaused") {
      br.cmd("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sid);
    }
  });
  await br.cmd("Page.enable", {}, sid);
  await br.cmd("Network.enable", { maxTotalBufferSize: 60e6, maxResourceBufferSize: 15e6 }, sid);
  await br.cmd("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await br.cmd("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
  if (bloquear) await br.cmd("Fetch.enable", { patterns: [{ resourceType: "Image" }, { resourceType: "Font" }, { resourceType: "Media" }] }, sid);
  aba.prontaMs = Date.now() - t0;
  aba.fechar = () => br.cmd("Target.closeTarget", { targetId });
  aba.navegar = (url) => br.cmd("Page.navigate", { url }, sid);
  aba.avaliar = async (fn, ...args) => {
    const r = await br.cmd("Runtime.evaluate", { expression: `(${fn})(...${JSON.stringify(args)})`, returnByValue: true, awaitPromise: true }, sid);
    if (r.result?.exceptionDetails) throw new Error("erro na página");
    return r.result?.result?.value;
  };
  return aba;
}

// Mesma leitura do confirmar.mjs (aba "Menores preços").
function menorPrecoAba() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aba = [...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
  const preco = aba && aba.querySelector('[aria-label$="Reais brasileiros"]');
  const m = preco && preco.getAttribute("aria-label").match(/^([0-9][0-9.]*) Reais brasileiros$/);
  return m ? Number(m[1].split(".").join("")) : null;
}
const infoPagina = () => `${location.href}|${document.title}`;

function caminho(u) {
  try {
    const x = new URL(u);
    const rpc = x.searchParams.get("rpcids");
    return x.hostname.replace(/^www\./, "") + x.pathname + (rpc ? `?rpcids=${rpc}` : "");
  } catch { return u.slice(0, 80); }
}

// Abre a busca na aba e observa por janelaMs: preço (a cada 250 ms) e chamadas XHR/Fetch pendentes.
async function medirPar(aba, busca, { janelaMs = 30000, corpos = false, nome = "" } = {}) {
  if (++consultas > TETO_CONSULTAS) throw new Error("teto de consultas ao Google atingido");
  aba.reqs.clear(); aba.pend.clear(); aba.corpos = corpos;
  aba.nav = Date.now();
  const nav = aba.nav;
  await aba.navegar(urlBusca(busca));
  const amostras = []; // [ms, preço|null, pendentes]
  while (Date.now() - nav < janelaMs) {
    await dormir(250);
    let v = null;
    try { v = await aba.avaliar(menorPrecoAba); } catch { /* navegando */ }
    amostras.push([Date.now() - nav, v, aba.pend.size]);
  }
  let href = "", certa = null;
  try {
    href = await aba.avaliar(infoPagina);
    certa = (await aba.avaliar(rotaConfere, busca.origem, busca.destino)) && (await aba.avaliar(datasConferem, busca.ida, busca.volta || ""));
  } catch { /* página trocou */ }
  const bloqueio = /\/sorry\/|consent\.google|captcha/i.test(href);
  const precos = amostras.map((a) => a[1]).filter((v) => v !== null);
  const final = precos.length ? precos[precos.length - 1] : null;
  const primeiro = precos.length ? precos[0] : null;

  const requisicoes = [];
  for (const r of aba.reqs.values()) {
    if (r.tipo !== "XHR" && r.tipo !== "Fetch" && r.tipo !== "Document") continue;
    const item = { url: caminho(r.url), tipo: r.tipo, ini: r.ini, fim: r.fim ?? null, bytes: r.bytes ?? null, status: r.status ?? null, falhou: r.falhou ?? null };
    if (r.corpoP) {
      const corpo = await r.corpoP;
      item.tamanho = corpo.length;
      const tem = (n) => n !== null && new RegExp(`(^|[^0-9.,])${n}([^0-9]|$)`).test(corpo);
      item.temFinal = tem(final); item.temPrimeiro = tem(primeiro);
      if (corpo.length) { mkdirSync(join(SAIDA, "corpos"), { recursive: true }); item.arquivo = join(SAIDA, "corpos", `${nome}-${caminho(r.url).replace(/[^a-z0-9]/gi, "_").slice(-50)}-${r.ini}.txt`); writeFileSync(item.arquivo, corpo); }
    }
    requisicoes.push(item);
  }
  return { busca, amostras, requisicoes, href, certa, bloqueio, primeiro, final, consulta: consultas };
}

function salvar(res) { mkdirSync(SAIDA, { recursive: true }); writeFileSync(ARQ, JSON.stringify(res)); }
const logar = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function lote(br, pares, n, { bloquear, janelaMs, nome }) {
  const tAbas = Date.now();
  const abas = [];
  for (let i = 0; i < n; i++) abas.push(await novaAba(br, { bloquear }));
  const abrirMs = Date.now() - tAbas;
  const rs = await Promise.all(pares.map((p, i) => medirPar(abas[i], p, { janelaMs, nome: `${nome}-${i}` })));
  await Promise.all(abas.map((a) => a.fechar()));
  return { abrirMs, abasProntaMs: abas.map((a) => a.prontaMs), rs };
}

async function tudo() {
  mkdirSync(SAIDA, { recursive: true });
  const res = { quando: new Date().toISOString(), curva: [], abas: [], custo: { edgeSubiuMs: [], abaProntaMs: [] } };
  const bloqueado = (r) => { if (r.bloqueio) { salvar(res); throw new Error("Google bloqueou (sorry/captcha): parando"); } };

  // 1) Curva de chegada + log de rede (corpos nos 5 primeiros): uma aba, um par por vez, 5 s entre eles.
  let br = await abrirEdge();
  res.custo.edgeSubiuMs.push(br.subiuMs);
  let aba = await novaAba(br);
  res.custo.abaProntaMs.push(aba.prontaMs);
  for (let i = 0; i < PARES.length; i++) {
    const r = await medirPar(aba, PARES[i], { janelaMs: 30000, corpos: i < 5, nome: `curva-${i}` });
    res.curva.push(r); salvar(res); bloqueado(r);
    logar(`curva ${i + 1}/20 ${PARES[i].origem}>${PARES[i].destino}: 1º=${r.primeiro} final=${r.final} certa=${r.certa} (consulta ${r.consulta})`);
    await dormir(5000);
  }
  await aba.fechar(); await br.fechar();

  // 2) Concorrência num só Edge (pares 0..5): 3 abas, 6 abas e 3 abas bloqueando imagem/fonte/mídia.
  const seis = PARES.slice(0, 6);
  const modos = [
    { nome: "3abas", n: 3, bloquear: false }, { nome: "6abas", n: 6, bloquear: false }, { nome: "3abas-bloq", n: 3, bloquear: true },
  ];
  for (const m of modos) {
    br = await abrirEdge();
    res.custo.edgeSubiuMs.push(br.subiuMs);
    for (let i = 0; i < seis.length; i += m.n) {
      const grupo = seis.slice(i, i + m.n);
      const t0 = Date.now();
      const l = await lote(br, grupo, grupo.length, { bloquear: m.bloquear, janelaMs: 35000, nome: m.nome });
      res.abas.push({ modo: m.nome, n: grupo.length, bloquear: m.bloquear, abrirMs: l.abrirMs, abasProntaMs: l.abasProntaMs, totalMs: Date.now() - t0, rs: l.rs });
      res.custo.abaProntaMs.push(...l.abasProntaMs);
      salvar(res);
      l.rs.forEach((r) => { logar(`${m.nome} ${r.busca.origem}>${r.busca.destino}: 1º=${r.primeiro} final=${r.final} certa=${r.certa}`); });
      l.rs.forEach(bloqueado);
      await dormir(8000);
    }
    await br.fechar();
    await dormir(15000);
  }

  // 3) Custo de abrir Edge novo (sem consulta ao Google): 3 vezes.
  for (let i = 0; i < 3; i++) { const b = await abrirEdge(); res.custo.edgeSubiuMs.push(b.subiuMs); await b.fechar(); }
  salvar(res);
  logar(`FIM. Consultas ao Google: ${consultas}. Resultado em ${ARQ}`);
}

// ---------- Análise ----------
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");

function curvaDe(r) {
  const s = r.amostras;
  const comPreco = s.filter((a) => a[1] !== null);
  if (!comPreco.length) return null;
  const final = comPreco[comPreco.length - 1][1];
  let tFinal = comPreco[0][0];
  for (let i = s.length - 1; i >= 0; i--) { if (s[i][1] !== final) { tFinal = s[Math.min(i + 1, s.length - 1)][0]; break; } if (i === 0) tFinal = s[0][0]; }
  const primeiro = comPreco[0];
  const fimXhr = Math.max(0, ...relevantes(r).filter((q) => q.fim).map((q) => q.fim));
  return { final, tPrimeiro: primeiro[0] / 1000, vPrimeiro: primeiro[1], tFinal: tFinal / 1000, fimXhr: fimXhr / 1000 };
}

// Regra "ocioso X s": a primeira hora t com preço visível e nenhuma chamada pendente nos X s anteriores.
// Ruído que a página dispara o tempo todo e não traz preço: telemetria e dados da conta.
const RUIDO = /\/log$|gen_204|AsyncData|jserror|\/csp|clients6\.google\.com\/\$rpc|bscframe|\/ogb\//;
const relevantes = (r) => r.requisicoes.filter((q) => (q.tipo === "XHR" || q.tipo === "Fetch") && !RUIDO.test(q.url));
function regraOciosa(r, X) {
  const s = r.amostras, rel = relevantes(r);
  for (let i = 0; i < s.length; i++) {
    if (s[i][1] === null) continue;
    const t = s[i][0], ini = t - X * 1000;
    if (t < X * 1000) continue;
    // alguma chamada relevante esteve ativa em (t-X, t]?
    const ativa = rel.some((q) => q.ini <= t && (q.fim === null || q.fim > ini));
    if (!ativa) return { t: t / 1000, v: s[i][1] };
  }
  return null;
}
// Regra "estável Y s" (e mínimo M s): preço igual há Y s e já passou M s da abertura.
function regraEstavel(r, Y, M) {
  const s = r.amostras; let ult = null, desde = 0;
  for (const a of s) {
    if (a[1] !== ult) { ult = a[1]; desde = a[0]; }
    if (ult !== null && a[0] - desde >= Y * 1000 && a[0] >= M * 1000) return { t: a[0] / 1000, v: ult };
  }
  return null;
}

function analisar() {
  const res = JSON.parse(readFileSync(ARQ, "utf8"));
  const out = [];
  const P = (s = "") => out.push(s);
  const rs = res.curva;
  P(`## Curva de chegada (1 aba, ${rs.length} pares)`);
  P("| par | 1º preço (s) | valor 1º | final | final em (s) | último XHR/Fetch (s) | rota ok |");
  P("|---|---|---|---|---|---|---|");
  const cs = [];
  rs.forEach((r) => { const c = curvaDe(r); if (c) cs.push({ r, c }); P(`| ${r.busca.origem}>${r.busca.destino} ${r.busca.ida.slice(5)} | ${c ? f1(c.tPrimeiro) : "-"} | ${c?.vPrimeiro ?? "-"} | ${c?.final ?? "-"} | ${c ? f1(c.tFinal) : "-"} | ${c ? f1(c.fimXhr) : "-"} | ${r.certa} |`); });
  const mudou = cs.filter((x) => x.c.vPrimeiro !== x.c.final);
  P("");
  P(`Pares com leitura: ${cs.length}/${rs.length}. Preço do 1º aparecer ≠ final (agência chegou depois): ${mudou.length}.`);
  P(`1º preço: média ${f1(media(cs.map((x) => x.c.tPrimeiro)))} s, máx ${f1(Math.max(...cs.map((x) => x.c.tPrimeiro)))} s. Preço final alcançado: média ${f1(media(cs.map((x) => x.c.tFinal)))} s, máx ${f1(Math.max(...cs.map((x) => x.c.tFinal)))} s. Atraso 1º→final nos que mudaram: média ${f1(media(mudou.map((x) => x.c.tFinal - x.c.tPrimeiro)))} s, máx ${f1(Math.max(0, ...mudou.map((x) => x.c.tFinal - x.c.tPrimeiro)))} s.`);

  P(""); P("## Regras de fim (acerto = valor aceito igual ao final dos 30 s)");
  P("| regra | acertos | tempo médio (s) | pior tempo (s) | sem decisão |");
  P("|---|---|---|---|---|");
  const regras = [
    ["atual: mín 20 s + estável 12 s", (r) => regraEstavel(r, 12, 20)],
    ["estável 6 s (mín 0)", (r) => regraEstavel(r, 6, 0)], ["estável 4 s (mín 0)", (r) => regraEstavel(r, 4, 0)],
    ["estável 3 s (mín 0)", (r) => regraEstavel(r, 3, 0)], ["estável 2 s (mín 0)", (r) => regraEstavel(r, 2, 0)],
    ...[1, 2, 3, 4, 6].map((X) => [`rede ociosa ${X} s`, (r) => regraOciosa(r, X)]),
    ...[[1, 1], [2, 2], [3, 2], [3, 3]].map(([X, Y]) => [`rede ociosa ${X} s + estável ${Y} s`, (r) => { const a = regraOciosa(r, X); if (!a) return null; const b = regraEstavel(r, Y, a.t); return b && b.t >= a.t ? b : null; }]),
  ];
  for (const [nome, f] of regras) {
    const dec = cs.map((x) => ({ x, d: f(x.r) }));
    const ok = dec.filter((o) => o.d && o.d.v === o.x.c.final);
    const ts = dec.filter((o) => o.d).map((o) => o.d.t);
    P(`| ${nome} | ${ok.length}/${cs.length} | ${f1(media(ts))} | ${f1(Math.max(0, ...ts))} | ${dec.filter((o) => !o.d).length} |`);
  }

  P(""); P("## Chamadas de rede dos 5 primeiros pares (corpos guardados)");
  const porUrl = new Map();
  rs.slice(0, 5).forEach((r) => r.requisicoes.forEach((q) => {
    if (q.tipo === "Document") return;
    const a = porUrl.get(q.url) || { n: 0, ini: [], fim: [], bytes: [], tf: 0, tp: 0, medidos: 0 };
    a.n++; a.ini.push((q.ini || 0) / 1000); if (q.fim) a.fim.push(q.fim / 1000); a.bytes.push(q.bytes || 0);
    if (q.temFinal !== undefined) { a.medidos++; if (q.temFinal) a.tf++; if (q.temPrimeiro) a.tp++; }
    porUrl.set(q.url, a);
  }));
  P("| chamada | vezes | início médio (s) | fim médio (s) | KB médio | traz o preço final | traz o 1º preço |");
  P("|---|---|---|---|---|---|---|");
  [...porUrl.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15).forEach(([u, a]) => P(`| ${u} | ${a.n} | ${f1(media(a.ini))} | ${f1(media(a.fim))} | ${f1(media(a.bytes) / 1024)} | ${a.tf}/${a.medidos} | ${a.tp}/${a.medidos} |`));

  P(""); P("## Concorrência num só Edge (mesmos pares 0–5; base = a curva de 1 aba)");
  P("| modo | par | 1º (s) | final | final em (s) | igual ao de 1 aba | rota ok | bloqueio |");
  P("|---|---|---|---|---|---|---|---|");
  const base = new Map(rs.map((r, i) => [i, r]));
  const resumo = {};
  res.abas.forEach((g) => g.rs.forEach((r) => {
    const i = PARES.findIndex((p) => p.origem === r.busca.origem && p.destino === r.busca.destino && p.ida === r.busca.ida);
    const c = curvaDe(r), b = base.get(i), cb = b && curvaDe(b);
    const igual = c && cb ? c.final === cb.final : null;
    const s = (resumo[g.modo] ||= { n: 0, ok: 0, comPreco: 0, tf: [], t1: [], sorry: 0, abrir: [] });
    s.n++; if (c) { s.comPreco++; s.tf.push(c.tFinal); s.t1.push(c.tPrimeiro); } if (igual) s.ok++; if (r.bloqueio) s.sorry++;
    P(`| ${g.modo} | ${r.busca.origem}>${r.busca.destino} | ${c ? f1(c.tPrimeiro) : "-"} | ${c?.final ?? "-"} | ${c ? f1(c.tFinal) : "-"} | ${igual === null ? "-" : igual} | ${r.certa} | ${r.bloqueio} |`);
  }));
  const base6 = rs.slice(0, 6).map(curvaDe).filter(Boolean);
  P("");
  P(`Base (1 aba, pares 0–5): 1º médio ${f1(media(base6.map((c) => c.tPrimeiro)))} s; final médio ${f1(media(base6.map((c) => c.tFinal)))} s.`);
  for (const [m, s] of Object.entries(resumo)) P(`${m}: ${s.comPreco}/${s.n} leram preço; iguais à base ${s.ok}/${s.n}; 1º médio ${f1(media(s.t1))} s; final médio ${f1(media(s.tf))} s; sorry/captcha ${s.sorry}.`);

  P(""); P("## Custo de abrir");
  P(`Edge novo até aceitar comandos: ${res.custo.edgeSubiuMs.map((x) => (x / 1000).toFixed(2)).join(", ")} s (média ${f1(media(res.custo.edgeSubiuMs) / 1000)} s).`);
  P(`Aba nova pronta (createTarget + ligar): ${res.custo.abaProntaMs.length} medidas, média ${f1(media(res.custo.abaProntaMs))} ms, máx ${Math.max(...res.custo.abaProntaMs)} ms.`);
  const texto = out.join("\n");
  writeFileSync(join(SAIDA, "tabelas.md"), texto);
  console.log(texto);
}

async function teste() { // 1 consulta, 15 s: só confere a mecânica
  mkdirSync(SAIDA, { recursive: true });
  const br = await abrirEdge();
  const aba = await novaAba(br, { bloquear: true });
  const r = await medirPar(aba, PARES[0], { janelaMs: 15000, corpos: true, nome: "teste" });
  console.log(JSON.stringify({ subiuMs: br.subiuMs, prontaMs: aba.prontaMs, primeiro: r.primeiro, final: r.final, certa: r.certa, href: r.href.slice(0, 120), amostras: r.amostras.filter((_, i) => i % 8 === 0), requisicoes: r.requisicoes.slice(0, 12) }, null, 1));
  await aba.fechar(); await br.fechar();
}

const modo = process.argv[2];
if (modo === "teste") await teste();
else if (modo === "tudo") await tudo();
else if (modo === "analisar") analisar();
else if (modo) console.log("uso: node scan/medir.mjs tudo | analisar");
