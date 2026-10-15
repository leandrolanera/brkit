# apis-portfolio

Plataforma comum (chave de API, limite por minuto, cota mensal, medição e cobrança pelo Asaas) com as primeiras APIs do portfólio, pronta para a Vercel.

## O que já existe

| Endpoint | O que faz |
|---|---|
| `GET /v1/qr?data=...&format=png\|svg&size=256&margin=2&ecc=M` | QR Code estático |
| `POST /v1/qr/codes` `{ "url": "https://..." }` | Cria QR Code dinâmico (link curto `/r/:id`, destino editável) |
| `GET /v1/qr/codes?id=...` | Destino e contagem de leituras |
| `PATCH /v1/qr/codes?id=...` `{ "url": "https://..." }` | Troca o destino sem mudar a imagem |
| `GET /r/:id` | Redirecionamento público (302) e contagem de leituras |
| `POST /v1/pix/qr` `{ "key", "name", "city", "amount?", "txid?" }` | BR Code do Pix ("copia e cola") estático + imagem PNG |
| `POST /v1/pix/decode` `{ "br_code": "000201..." }` | Abre um BR Code: confere o CRC e devolve chave, beneficiário, valor e txid |
| `POST /v1/boleto/decode` `{ "code": "00190.50095 ..." }` | Valida linha digitável (47/48) ou código de barras (44), converte entre as duas e extrai banco, valor e vencimento |
| `GET` ou `POST /v1/validate/cnpj` | Valida CNPJ numérico e alfanumérico (módulo 11, ASCII − 48) |
| `POST /v1/validate/cpf` `{ "value": "..." }` | Valida CPF (só por POST: é dado pessoal e query string vai para logs) |
| `GET /v1/holidays?year=2026` | Feriados nacionais e pontos facultativos federais |
| `GET /v1/holidays/business-days?from=2026-10-01&to=2026-10-31` | Dias úteis (sem fins de semana e feriados nacionais) |
| `POST /v1/billing/checkout` | Contrata um plano (assinatura mensal no Asaas) e devolve o link da fatura |
| `GET /v1/billing` | Plano em vigor, vencimento, assinatura, uso do mês e link pendente |
| `DELETE /v1/billing` | Cancela a assinatura (o acesso pago segue até o fim do período já pago) |
| `POST /api/webhooks/asaas` | Webhook do Asaas (autenticado por token) |
| `GET /v1/health` | Verificação de saúde (pública) |

Autenticação: header `x-api-key: ak_live_...` ou `Authorization: Bearer ak_live_...`.
Toda resposta autenticada traz `x-ratelimit-*` e `x-usage-*`. Erros seguem o formato `{ "error": { "code", "message" } }`.

### Regras da plataforma

- O limite por minuto conta toda requisição autenticada, inclusive as que falham.
- A rota pública `/r/:id` não tem chave, então é limitada por IP: 60 leituras por minuto. O IP vem de `x-vercel-forwarded-for`, `x-real-ip` ou da última entrada de `x-forwarded-for` — a Vercel sobrescreve esse header com um IP só, justamente para impedir spoofing. Fora da Vercel, sem nenhum desses headers, o limite passa a ser por código (um balde único global derrubaria todos os links de uma vez).
- A cota mensal (mês em UTC) só é debitada quando a resposta é bem-sucedida (< 400). O débito é por reserva: a unidade é separada antes de chamar o endpoint e devolvida se a cota estourou ou se a resposta falhou, para que chamadas simultâneas na borda da cota não furem o limite. Um processo derrubado entre a reserva e a devolução deixa até `cost` unidades consumidas à toa, zeradas na virada do mês.
- `withApi(handler, { cost: N })` cobra N unidades por chamada, o gancho para os endpoints com IA quando entrarem os créditos pré-pagos.
- `withApi(handler, { cost: 0 })` não consome nem exige cota. É o caso dos endpoints de cobrança, que precisam funcionar justamente quando a cota acabou.
- Os planos e preços em `lib/plans.ts` são provisórios (free 1.000 chamadas, pro R$ 49 com 50.000, scale R$ 249 com 500.000 por mês).

## Cobrança com Asaas

Fluxo: o cliente já tem uma chave free, chama `POST /v1/billing/checkout` com o plano e os dados de quem paga, recebe o link da fatura do Asaas (onde escolhe Pix, boleto ou cartão) e paga. O Asaas avisa pelo webhook e a chave sobe de plano.

```bash
curl -X POST https://SEU-DOMINIO/v1/billing/checkout \
  -H "x-api-key: ak_live_..." -H "content-type: application/json" \
  -d '{ "plan": "pro", "customer": { "name": "Maria Souza", "document": "529.982.247-25", "email": "maria@exemplo.com.br" } }'
```

**Como o acesso é liberado.** Cada pagamento confirmado (`PAYMENT_CONFIRMED` ou `PAYMENT_RECEIVED`) estende o fim do período pago da chave em 31 dias + 3 de tolerância, a partir do que for mais tarde entre o vencimento e o momento do evento. Passada essa data a chave volta ao plano free sozinha, sem depender de evento de inadimplência nem da ordem em que os webhooks chegam (o Asaas entrega cada evento pelo menos uma vez e não garante ordem; aqui eventos repetidos não causam efeito duplicado).

| Evento do Asaas | O que acontece |
|---|---|
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | Libera o plano e estende o período pago (Pix emite só `RECEIVED`; boleto e cartão emitem `CONFIRMED` e depois `RECEIVED`) |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED` | Revoga o acesso na hora |
| `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED` | Marca a assinatura como cancelada; o acesso pago continua até o fim do período |
| demais | Ignorados (respondem 200) |

### Configuração

1. No Asaas, gere a chave de API do ambiente que for usar (a do sandbox e a de produção são diferentes e só aparecem uma vez).
2. Defina na Vercel:
   - `ASAAS_API_KEY`: a chave.
   - `ASAAS_ENV`: `sandbox` (padrão) ou `production`. Produção só é usada se você pedir explicitamente.
   - `ASAAS_WEBHOOK_TOKEN`: um token seu, de 32 a 255 caracteres, sem espaços, sem sequências simples e diferente da chave de API.
   - `BILLING_SUCCESS_URL` (opcional): para onde o cliente volta depois de pagar.
3. No Asaas, cadastre um webhook apontando para `https://SEU-DOMINIO/api/webhooks/asaas`, com o mesmo token em `ASAAS_WEBHOOK_TOKEN` (o Asaas o envia no header `asaas-access-token`), e marque os eventos da tabela acima.
4. Teste tudo no sandbox antes de trocar para produção.

Atenção: o Asaas pode pausar a fila do webhook depois de 15 falhas seguidas. O endpoint responde 200 para eventos ignorados e repetidos justamente para isso; se o seu deploy cair, confira o webhook no painel.

### Limites conhecidos

- Trocar de plano exige cancelar e contratar de novo; não há proração.
- Quem cancela mantém o acesso até o fim do período pago e não recebe reembolso automático.
- O documento do cliente (CPF/CNPJ) vai direto ao Asaas e não é guardado aqui; só o id do cliente e da assinatura ficam no Redis.
- Criar a chave free ainda é manual (`npm run create-key`). Falta um cadastro público com verificação de e-mail.
- Não verificado ainda contra o Asaas real: se o link da fatura da primeira cobrança já está disponível logo após criar a assinatura (se não estiver, `payment_url` vem nulo e `GET /v1/billing` devolve o link em `pending_payment_url`), se o cadastro de cliente aceita CNPJ alfanumérico e se há restrições para o domínio de `BILLING_SUCCESS_URL`.

## Outros limites conhecidos

- Validação de CPF/CNPJ é só de formato e dígito verificador, não consulta situação cadastral na Receita.
- Pix: só gera BR Code **estático**. O dinâmico (com a cobrança atrás de uma URL) exige integração com um PSP; o decodificador reconhece e lê os dois.
- Pix: a chave é validada no formato e no tipo (CPF/CNPJ pelo dígito verificador, UUID, e-mail, telefone), mas **não se ela existe de verdade** — isso exigiria consultar o DICT. Chave bem formada e não registrada gera um QR que só falha na hora do pagamento.
- Pix: geração totalmente offline, sem falar com banco nem PSP. Não há conciliação nem confirmação de pagamento: o BR Code é só a instrução de cobrança.
- Pix: o CRC e o formato foram conferidos contra o payload de exemplo do BACEN e contra o valor canônico do CRC-16/CCITT-FALSE, mas **nenhum QR gerado aqui foi lido por um app de banco real ainda**. Vale testar com um valor baixo antes de usar em produção.
- Boleto: só **lê, valida e converte**. Não gera boleto: o campo livre (25 dígitos) segue regras próprias de cada banco, com nosso número, agência e conta — isso exige integração com o banco emissor.
- Boleto: **o fator de vencimento é ambíguo.** Ele tem 4 dígitos, chegou a 9999 em 21/02/2025 e a FEBRABAN o reiniciou em 1000 em 22/02/2025, então todo fator mapeia duas datas possíveis a ~24,6 anos de distância, e nada no código de barras diferencia. A resposta traz `due_date_current_cycle` e `due_date_legacy_cycle`, e `due_date` elege a mais próxima de hoje. Se o seu caso envolve boletos antigos, use o campo explícito em vez do `due_date`.
- Boleto: não consulta banco nenhum. Valida a estrutura e os dígitos verificadores, **não** diz se o boleto existe, está registrado, pago ou vencido.
- Boleto: a tabela de nomes de banco é parcial e cobre os emissores mais comuns; código fora dela devolve `bank_name: null` em vez de um nome errado. O `bank_code` vem sempre.
- Boleto: na arrecadação, o vencimento só aparece quando a empresa usa as 8 primeiras posições do campo livre como AAAAMMDD, o que a FEBRABAN prevê mas não obriga. Fora disso vem `null`.
- Feriados: só federais. Estaduais e municipais ficam para uma próxima versão.
- QR dinâmico é um redirecionador: um serviço assim pode ser usado para phishing. Antes de abrir ao público, adicione termos de uso, denúncia de links e (idealmente) verificação do destino contra listas de URLs maliciosas.
- A rota pública `/r/:id` é limitada a 60 leituras por minuto por IP (ver abaixo). O limite é por janela fixa de um minuto, então dois picos na virada podem somar até 2× — contém abuso, não é cota precisa.

## Rodando

```bash
npm install
npm run typecheck
npm test
```

Sem credenciais do Redis o armazenamento cai para a memória local, o que serve para testes mas **não persiste na Vercel**.

## Deploy na Vercel

1. Importe o projeto na Vercel (framework: Other).
2. Em Marketplace, adicione **Upstash Redis** ao projeto. Isso cria `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` (os nomes `KV_REST_API_*` também funcionam).
3. Defina `PUBLIC_BASE_URL` com o domínio público, sem barra no final (usado nos links curtos dos QR Codes) e as variáveis do Asaas descritas acima.
4. Faça o deploy e crie uma chave:

```bash
vercel env pull .env.local
npm run create-key -- --owner cliente@exemplo.com --plan free
```

A chave aparece uma única vez; só o hash fica guardado. Chaves criadas com `--plan pro` ou `--plan scale` valem sem vencimento (úteis para parceiros e testes).

5. Teste:

```bash
curl -H "x-api-key: ak_live_..." "https://SEU-DOMINIO/v1/holidays?year=2026"
curl -H "x-api-key: ak_live_..." "https://SEU-DOMINIO/v1/validate/cnpj?value=12.ABC.345/01DE-35"
curl -H "x-api-key: ak_live_..." "https://SEU-DOMINIO/v1/qr?data=https://exemplo.com.br" -o qr.png
curl -H "x-api-key: ak_live_..." "https://SEU-DOMINIO/v1/billing"
```

## Estrutura

```
api/            endpoints (um arquivo por rota, handlers no padrão Web Request/Response)
  v1/
  webhooks/asaas.ts   webhook do Asaas
  redirect.ts         rota pública do QR dinâmico
lib/
  withApi.ts    autenticação, limite, cota e medição
  rateLimit.ts  contador de janela por minuto (usado pelo withApi e pelo /r/:id)
  auth.ts       chaves (somente hash armazenado) e plano em vigor
  billing.ts    checkout, cancelamento e processamento dos eventos do Asaas
  asaas.ts      cliente HTTP do Asaas (sem dependências)
  store.ts      Redis (Upstash) com fallback em memória
  plans.ts      planos, preços e limites
  validators.ts CPF e CNPJ (numérico e alfanumérico)
  pix.ts        BR Code do Pix (EMV/BACEN): monta, decodifica e CRC-16
  boleto.ts     linha digitável e código de barras (cobrança e arrecadação)
  holidays.ts   feriados nacionais e dias úteis
  qr.ts         QR dinâmico
scripts/create-key.ts
test/
```

## Próximos passos sugeridos

1. Rodar `npm install`, `npm run typecheck` e `npm test`.
2. Deploy no sandbox do Asaas e um pagamento de teste de ponta a ponta.
3. Cadastro público de chaves com verificação de e-mail.
4. Documentação OpenAPI e landing page.
5. HTML → PDF e Screenshot (navegador headless: avaliar a Vercel com Chromium compacto, ou uma VPS pequena).
6. Créditos pré-pagos, necessários antes dos endpoints com IA.
