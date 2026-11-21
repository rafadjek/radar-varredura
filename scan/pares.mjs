// O Worker só aceita confirmação com a volta até 35 dias depois da ida.
export const MAX_DIAS = 35;

export function adicionarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Para cada data de ida, a volta mais barata entre dias-margem e dias+margem; devolve os `quantos` melhores pares.
export function melhoresPares(ida, volta, dias, margem = 0, quantos = 3) {
  const pares = [];
  for (const [d, pIda] of Object.entries(ida)) {
    let melhor = null;
    for (let n = Math.max(1, dias - margem); n <= Math.min(MAX_DIAS, dias + margem); n++) {
      const v = adicionarDias(d, n);
      if (volta[v] == null) continue;
      const total = pIda + volta[v];
      if (!melhor || total < melhor.total) melhor = { ida: d, volta: v, total };
    }
    if (melhor) pares.push(melhor);
  }
  pares.sort((a, b) => a.total - b.total || a.ida.localeCompare(b.ida));
  return pares.slice(0, quantos);
}

// Quais pares confirmar. O calendário só traz o preço da companhia; a oferta de agência não aparece nele e varia de
// data para data. Quando os melhores do calendário estão todos empatados (calendário "chapado", comum em rota
// internacional), a ordem dele não diz nada: confirma até `maximo` pares espalhados em datas diferentes.
// Caso normal (preços diferenciados): os 5 melhores. `ordenados` vem de melhoresPares, do mais barato ao mais caro.
// `sinal` = posição que, se ainda estiver na faixa de empate, indica calendário chapado (padrão: a última do caso normal).
export function paresParaConfirmar(ordenados, { normal = 5, maximo = 9, folga = 0.03, espaco = 3, sinal = normal - 1 } = {}) {
  if (ordenados.length <= normal) return ordenados;
  const limite = ordenados[0].total * (1 + folga);
  if (ordenados.length <= sinal || ordenados[sinal].total > limite) return ordenados.slice(0, normal);
  const dist = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
  const escolhidos = [];
  for (const p of ordenados) {
    if (p.total > limite) break;
    if (escolhidos.every((e) => dist(e.ida, p.ida) >= espaco)) escolhidos.push(p);
    if (escolhidos.length >= maximo) break;
  }
  return escolhidos.length >= normal ? escolhidos : ordenados.slice(0, normal);
}

// Candidatos FORA da janela pedida (um por data de ida), do mais barato; mesmo desempate de melhorParForaDaJanela.
// Ordem idêntica à da página (resumo.js, paresForaDaJanela): runner e página precisam escolher os mesmos pares.
export function paresForaDaJanela(ida, volta, dias, margem = 0, extra = 4) {
  const minP = Math.max(1, dias - margem);
  const maxP = dias + margem;
  const minA = Math.max(1, dias - margem - extra);
  const maxA = Math.min(MAX_DIAS, dias + margem + extra);
  const lista = [];
  for (const [d, pIda] of Object.entries(ida)) {
    let melhor = null;
    for (let n = minA; n <= maxA; n++) {
      if (n >= minP && n <= maxP) continue;
      const v = adicionarDias(d, n);
      if (volta[v] == null) continue;
      const c = { ida: d, volta: v, total: pIda + volta[v], dias: n };
      if (!melhor || c.total < melhor.total || (c.total === melhor.total && Math.abs(n - dias) < Math.abs(melhor.dias - dias))) melhor = c;
    }
    if (melhor) lista.push(melhor);
  }
  lista.sort((a, b) => a.total - b.total || Math.abs(a.dias - dias) - Math.abs(b.dias - dias) || a.ida.localeCompare(b.ida) || a.dias - b.dias);
  return lista;
}

// Sugestão: o melhor par fora da janela; se o calendário está chapado, até 4 espalhados em datas diferentes.
export function paresDeSugestao(ida, volta, dias, margem = 0, extra = 4, maximo = 4) {
  return paresParaConfirmar(paresForaDaJanela(ida, volta, dias, margem, extra), { normal: 1, maximo, sinal: 3 });
}

// Vizinhos (ida ou volta ±1 e ±2 dias) do par `par` que existem no calendário, ainda não lidos e com duração permitida.
export function vizinhos(ida, volta, par, ja, dias, margem = 0, extra = 4, quantos = 3) {
  const minA = Math.max(1, dias - margem - extra);
  const maxA = Math.min(MAX_DIAS, dias + margem + extra);
  const visto = new Set(ja.map((p) => `${p.ida}|${p.volta}`));
  const r = [];
  for (const delta of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const i = adicionarDias(par.ida, delta[0]);
    const v = adicionarDias(par.volta, delta[1]);
    const n = Math.round((new Date(v) - new Date(i)) / 86400000);
    if (ida[i] == null || volta[v] == null || n < minA || n > maxA || visto.has(`${i}|${v}`)) continue;
    r.push({ ida: i, volta: v, total: ida[i] + volta[v] });
    if (r.length >= quantos) break;
  }
  return r;
}

// Melhor par FORA da janela pedida (duração ± margem) mas dentro da ampliada (± margem + extra): é a "sugestão".
// Menor soma; empate: menor |n - dias|, depois ida mais cedo, depois menor n. Mesma regra da página (resumo.js).
export function melhorParForaDaJanela(ida, volta, dias, margem = 0, extra = 4) {
  const minP = Math.max(1, dias - margem);
  const maxP = dias + margem;
  const minA = Math.max(1, dias - margem - extra);
  const maxA = Math.min(MAX_DIAS, dias + margem + extra);
  let melhor = null;
  const melhorQue = (c, m) => {
    if (c.total !== m.total) return c.total < m.total;
    const dc = Math.abs(c.dias - dias);
    const dm = Math.abs(m.dias - dias);
    if (dc !== dm) return dc < dm;
    if (c.ida !== m.ida) return c.ida < m.ida;
    return c.dias < m.dias;
  };
  for (const [d, pIda] of Object.entries(ida)) {
    for (let n = minA; n <= maxA; n++) {
      if (n >= minP && n <= maxP) continue;
      const v = adicionarDias(d, n);
      if (volta[v] == null) continue;
      const c = { ida: d, volta: v, total: pIda + volta[v], dias: n };
      if (!melhor || melhorQue(c, melhor)) melhor = c;
    }
  }
  return melhor;
}
