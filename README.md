# radar-varredura

Leitor do Google Voos usado pelo RadarPassagens (https://radarpassagens.pages.dev). Roda no GitHub Actions: um Chrome sem interface abre o Google Voos com `gl=BR`, lê o calendário de preços (só ida, ~330 dias) e a aba "Menores preços" do par de datas, e envia o resultado ao Worker do site.

Não há chave de API paga. **O repositório é privado** (desde 2026-11-21) porque ele usa executores self-hosted no PC do Rafael (`D:\actions-runner`, etiquetas `pc-brasil` e `pc-salvas`): o IP brasileiro residencial do PC enxerga as ofertas de agência que o IP do GitHub não vê. Quando o PC está desligado, o Worker manda os jobs para o GitHub hospedado (`ubuntu-latest`, plano B). Nenhum segredo fica no código (`WORKER_URL` e `INGEST_SECRET` são secrets do repositório; o batimento do PC lê os mesmos valores das variáveis de ambiente do usuário).

- `.github/workflows/buscar.yml`: uma busca sob demanda (ida e volta em paralelo, depois confirma os 3 melhores pares).
- `.github/workflows/confirmar.yml`: só confirma até 3 pares.
- `.github/workflows/salvas.yml`: varre as rotas de `rotas.json` (disparado uma vez ao dia pelo Worker).
- `scan/`: Chrome via CDP (`chrome.mjs`), calendário (`calendario.mjs`), preço confirmado (`confirmar.mjs`), envio ao Worker (`enviar.mjs`), escolha dos pares (`pares.mjs`), linha de comando (`cli.mjs`).

Teste local (Edge/Chrome instalado): `CHROME_BIN="caminho do msedge.exe" node scan/cli.mjs calendario teste GRU JDO ida saida.json` (sem `WORKER_URL`, só mostra o que enviaria). Testes: `node --test test/`.

Ler o Google Voos por navegador automatizado é de uso pessoal e volume baixo; se o Google mudar a página, as leituras falham de forma explícita (cobertura baixa), nunca com preço inventado.
