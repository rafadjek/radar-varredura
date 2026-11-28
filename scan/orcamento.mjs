// Algoritmo puro do orçamento de leituras da busca rápida (sem rede, sem relógio): decide QUAIS datas de ida ler.
// Amostra uniforme -> refino em volta dos melhores -> variação de duração nos finalistas.

const FRACAO_AMOSTRA = 0.55;
const MAX_DURACAO = 35;
const DIA_MS = 86400000;

const tamanhoAmostra = (orcamento) => Math.max(1, Math.floor(FRACAO_AMOSTRA * orcamento));

// Passo entre as idas da amostra. Nunca múltiplo de 7: senão todas as leituras cairiam no mesmo dia da semana.
export function passoAmostra(nDias, orcamento) {
  let passo = Math.max(1, Math.ceil(nDias / tamanhoAmostra(orcamento)));
  while (passo % 7 === 0) passo++;
  return passo;
}

// Índices (0 = primeira ida) da amostra inicial; `deslocamento` gira a grade.
export function amostraInicial(nDias, orcamento, deslocamento = 0) {
  const passo = passoAmostra(nDias, orcamento);
  const max = tamanhoAmostra(orcamento);
  const saida = [];
  for (let i = deslocamento % passo; i < nDias && saida.length < max; i += passo) saida.push(i);
  return saida;
}

// Vizinhos ainda não lidos dos K menores preços (ignora leituras que falharam = null; índice que já tem chave em
// `lidos`, mesmo null, já foi tentado e não volta). Ordem: preço crescente, depois distância.
export function proximosRefino(lidos, nDias, passo, rodada, limite, K = 3) {
  const melhores = [...lidos.entries()]
    .filter(([, p]) => typeof p === "number")
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .slice(0, K);
  const raio = rodada === 0 ? Math.max(1, Math.min(passo - 1, 6)) : 1;
  const saida = [];
  const vistos = new Set();
  for (const [centro] of melhores) {
    for (let d = 1; d <= raio; d++) {
      for (const i of [centro - d, centro + d]) {
        if (i < 0 || i >= nDias || lidos.has(i) || vistos.has(i)) continue;
        vistos.add(i);
        saida.push(i);
        if (saida.length >= limite) return saida;
      }
    }
  }
  return saida;
}

// Durações (em dias) diferentes da nominal a ler na variação ± margem. Margem >= 3: só de 2 em 2 a partir de dias-margem.
export function duracoesParaLer(dias, margem) {
  const saida = [];
  const passo = margem >= 3 ? 2 : 1;
  for (let d = dias - margem; d <= dias + margem; d += passo) {
    if (d !== dias && d >= 1 && d <= MAX_DURACAO) saida.push(d);
  }
  return saida;
}

const diasEntre = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / DIA_MS;

// Os `quantos` menores preços, com idas separadas por >= 3 dias quando possível (senão completa pelos mais baratos).
export function escolherFinalistas(lidos, quantos, jaEscolhidos = []) {
  const ja = new Set(jaEscolhidos);
  const candidatos = lidos
    .filter((l) => !ja.has(`${l.ida}|${l.volta}`))
    .sort((a, b) => a.preco - b.preco || a.ida.localeCompare(b.ida) || a.volta.localeCompare(b.volta));
  const escolhidos = [];
  for (const c of candidatos) {
    if (escolhidos.length >= quantos) break;
    if (escolhidos.every((e) => diasEntre(e.ida, c.ida) >= 3)) escolhidos.push(c);
  }
  for (const c of candidatos) {
    if (escolhidos.length >= quantos) break;
    if (!escolhidos.includes(c)) escolhidos.push(c);
  }
  return escolhidos.sort((a, b) => a.preco - b.preco || a.ida.localeCompare(b.ida));
}
