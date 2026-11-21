// Funções que rodam DENTRO da página do Google Voos (são enviadas como texto: não usam nada deste arquivo).

// A página mostra mesmo a rota pedida? Compara os códigos nos campos "De onde?" e "Para onde?".
// Códigos de cidade (SAO, RIO...) não aparecem no rótulo do aeroporto: nesses casos não há como conferir.
export function rotaConfere(origem, destino) {
  const cidades = ["SAO", "RIO", "BHZ", "NYC", "LON", "PAR", "ROM", "TYO", "WAS", "MIL", "BUE", "MOW"];
  const rotulo = (inicio) => {
    const el = [...document.querySelectorAll("input")].find((e) => e.getBoundingClientRect().width > 0 && (e.getAttribute("aria-label") || "").startsWith(inicio));
    return el ? el.getAttribute("aria-label") : "";
  };
  // Rótulo de aeroporto traz o código ("São Paulo GRU"); o de cidade traz só o nome. Só rejeita quando há um código e ele é outro.
  const confere = (texto, codigo) => {
    const codigos = texto.match(/(^|[^A-Za-z])[A-Z]{3}(?![A-Za-z])/g) || [];
    return cidades.includes(codigo) || !codigos.length || new RegExp(`(^|[^A-Z])${codigo}([^A-Z]|$)`).test(texto);
  };
  return confere(rotulo("De onde"), origem) && confere(rotulo("Para onde"), destino);
}

// As datas mostradas nos campos "Partida" e "Volta" são as pedidas? (dia do mês e mês abreviado em pt-BR)
export function datasConferem(ida, volta) {
  const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const campo = (nome) => {
    const el = [...document.querySelectorAll("input")].find((e) => e.getBoundingClientRect().width > 0 && new RegExp(nome, "i").test(e.getAttribute("aria-label") || ""));
    return el ? el.value : "";
  };
  const bate = (texto, iso) => {
    const [, m, d] = iso.split("-").map(Number);
    return new RegExp(`(^|[^0-9])${d}([^0-9]|$)`).test(texto) && texto.toLowerCase().includes(meses[m - 1]);
  };
  return bate(campo("partida"), ida) && (!volta || bate(campo("volta"), volta));
}
