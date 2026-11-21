// Diagnóstico: o preço "Menores preços" muda conforme a região que o Google enxerga? Roda variações e imprime.
import { abrirChrome, dormir } from "./chrome.mjs";

function leitura() {
  const n = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const aba = [...document.querySelectorAll("[role=tab]")].find((e) => n(e.textContent).startsWith("menores pre"));
  const preco = aba && aba.querySelector('[aria-label$="Reais brasileiros"]');
  const loc = [...document.querySelectorAll("button,[role=button]")].map((b) => (b.innerText || "").replace(/\s+/g, " ")).find((t) => /Localiza/.test(t));
  return { preco: preco ? preco.getAttribute("aria-label") : null, localizacao: loc || null, idioma: document.documentElement.lang };
}

const [origem, destino, ida, volta] = process.argv.slice(2);
const q = `Flights from ${origem} to ${destino} on ${ida} through ${volta}`;
const variantes = [
  { nome: "padrao (google.com)", host: "www.google.com", emular: false },
  { nome: "google.com.br", host: "www.google.com.br", emular: false },
  { nome: "google.com + emulacao BR", host: "www.google.com", emular: true },
  { nome: "google.com.br + emulacao BR", host: "www.google.com.br", emular: true },
];
const chrome = await abrirChrome();
for (const v of variantes) {
  if (v.emular) {
    await chrome.cmd("Emulation.setTimezoneOverride", { timezoneId: "America/Sao_Paulo" });
    await chrome.cmd("Emulation.setLocaleOverride", { locale: "pt-BR" });
    await chrome.cmd("Emulation.setGeolocationOverride", { latitude: -23.55, longitude: -46.63, accuracy: 100 });
  }
  await chrome.navegar(`https://${v.host}/travel/flights?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&curr=BRL`);
  await dormir(22000);
  console.log(`[variante] ${v.nome}:`, JSON.stringify(await chrome.avaliar(leitura)));
}
await chrome.fechar();
process.exit(0);
