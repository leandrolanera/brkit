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
| `POST /v1/payments/decode` `{ "code": "..." }` | Aceita Pix, linha digitável ou código de barras sem saber o formato antes; devolve envelope comum + decodificação nativa |
| `GET` ou `POST /v1/validate/cnpj` | Valida CNPJ numérico e alfanumérico (módulo 11, ASCII − 48) |
| `POST /v1/validate/cpf` `{ "value": "..." }` | Valida CPF (só por POST: é dado pessoal e query string vai para logs) |
| `GET /v1/holidays?year=2026` | Feriados nacionais e pontos facultativos federais |
| `GET /v1/holidays/business-days?from=2026-10-01&to=2026-10-31` | Dias úteis (sem fins de semana e feriados nacionais) |
| `POST /v1/billing/checkout` | Contrata um plano (assinatura mensal no Asaas) e devolve o link da fatura |
| `GET /v1/billing` | Plano em vigor, vencimento, assinatura, uso do mês e link pendente |
| `PUT /v1/billing` `{ "plan": "scale" }` | Troca o plano sem cancelar (upgrade vale na hora; downgrade, no próximo pagamento) |
| `DELETE /v1/billing` | Cancela a assinatura (o acesso pago segue até o fim do período já pago) |
| `POST /api/webhooks/asaas` | Webhook do Asaas (autenticado por token) |
| `POST /v1/signup` `{ "email": "..." }` | Pede uma chave free: envia código de verificação (pública) |
| `POST /v1/signup/verify` `{ "email", "code" }` | Confere o código e devolve a chave, uma única vez (pública) |
| `POST /v1/keys/rotate` | Troca o segredo da chave atual (autenticado); a anterior morre na hora |
| `POST /v1/keys/recover` `{ "email": "..." }` | Perdeu a chave: envia código para substituí-la (pública) |
| `POST /v1/keys/recover/verify` `{ "email", "code" }` | Confere o código e devolve a chave nova (pública) |
| `GET /v1/health` | Verificação de saúde (pública) |
| `GET /v1/openapi.json` | Especificação OpenAPI 3.1 desta instalação (pública) |

Autenticação: header `x-api-key: ak_live_...` ou `Authorization: Bearer ak_live_...`.
Toda resposta autenticada traz `x-ratelimit-*` e `x-usage-*`. Erros seguem o formato `{ "error": { "code", "message" } }`.

### Para que serve

Cada endpoint resolve um problema concreto. A especificação em `/v1/openapi.json` traz, em cada operação, um bloco **"Quando usar"** e exemplos de requisição e resposta prontos para copiar.

| Situação | Endpoint |
|---|---|
| Campo único de "código de pagamento" no app, ou leitor de câmera que tanto lê QR de Pix quanto código de barras — sem ramificar no cliente antes de saber o formato | `POST /v1/payments/decode` |
| Cobrar no checkout, por WhatsApp ou numa fatura, com o número do pedido voltando no extrato do PSP | `POST /v1/pix/qr` |
| Conferir o código que o cliente colou antes de dar baixa, ou casar um Pix recebido com o pedido pelo `txid` | `POST /v1/pix/decode` |
| Dar baixa em boleto enviado por e-mail sem digitar valor e vencimento à mão | `POST /v1/boleto/decode` |
| Validar o código no formulário antes de mandar ao banco — código errado volta rejeitado e vira chamado de suporte | `POST /v1/boleto/decode` |
| Converter o que o leitor de código de barras capturou em linha digitável | `POST /v1/boleto/decode` |
| Barrar erro de digitação no cadastro antes de gravar, inclusive **CNPJ alfanumérico** | `GET /v1/validate/cnpj`, `POST /v1/validate/cpf` |
| Cardápio, cartaz ou etiqueta cujo destino muda depois de impresso, com contagem de leituras | `POST /v1/qr/codes` |
| Prazo de entrega, SLA ou vencimento contado em dias úteis, com os feriados que entraram na conta | `GET /v1/holidays/business-days` |
| Bloquear agendamento em feriado, sem manter tabela que envelhece (Carnaval e Corpus Christi movem todo ano) | `GET /v1/holidays` |

Dois argumentos que costumam decidir a compra, e que a documentação explica em detalhe:

- **O CNPJ alfanumérico** está em vigor desde julho de 2026. Expressões regulares antigas que só aceitam dígitos passam a recusar empresa válida, e o cálculo do dígito mudou.
- **O fator de vencimento do boleto** reiniciou em fevereiro de 2025, então todo fator mapeia duas datas possíveis. A resposta traz as duas leituras e sinaliza a ambiguidade, em vez de chutar.

### Regras da plataforma

- O limite por minuto conta toda requisição autenticada, inclusive as que falham.
- A rota pública `/r/:id` não tem chave, então é limitada por IP: 60 leituras por minuto. O IP vem de `x-vercel-forwarded-for`, `x-real-ip` ou da última entrada de `x-forwarded-for` — a Vercel sobrescreve esse header com um IP só, justamente para impedir spoofing. Fora da Vercel, sem nenhum desses headers, o limite passa a ser por código (um balde único global derrubaria todos os links de uma vez).
- A cota mensal (mês em UTC) só é debitada quando a resposta é bem-sucedida (< 400). O débito é por reserva: a unidade é separada antes de chamar o endpoint e devolvida se a cota estourou ou se a resposta falhou, para que chamadas simultâneas na borda da cota não furem o limite. Um processo derrubado entre a reserva e a devolução deixa até `cost` unidades consumidas à toa, zeradas na virada do mês.
- `withApi(handler, { cost: N })` cobra N unidades por chamada, o gancho para os endpoints com IA quando entrarem os créditos pré-pagos.
- `withApi(handler, { cost: 0 })` não consome nem exige cota. É o caso dos endpoints de cobrança, que precisam funcionar justamente quando a cota acabou.
- Os planos e preços em `lib/plans.ts` são provisórios (free 1.000 chamadas, pro R$ 49 com 50.000, scale R$ 249 com 500.000 por mês).

## Cadastro público de chaves

Qualquer pessoa obtém uma chave free verificando um e-mail. A verificação existe para dar algum custo à obtenção da chave: sem ela, criar chaves em massa seria trivial.

```bash
curl -X POST https://SEU-DOMINIO/v1/signup \
  -H "content-type: application/json" -d '{ "email": "voce@exemplo.com.br" }'
# chega um código de 8 caracteres por e-mail

curl -X POST https://SEU-DOMINIO/v1/signup/verify \
  -H "content-type: application/json" -d '{ "email": "voce@exemplo.com.br", "code": "ABCD2345" }'
# { "api_key": "ak_live_...", ... }  <- aparece só aqui
```

Decisões que valem saber:

- **Código por e-mail, confirmado via POST** — e não link clicável. Um token em query string iria para log de acesso, o que contraria a mesma regra que faz o CPF só ser aceito por POST neste projeto. Também dispensa qualquer página HTML.
- **A resposta de `/v1/signup` é 202 em todo e-mail válido**, exista chave para ele ou não. Dizer a diferença daria um jeito de descobrir quem está cadastrado; quem já tem chave recebe um e-mail explicando, em vez de um código.
- Na verificação, **o código é conferido antes da existência da chave**. Na ordem inversa, um código qualquer separaria "este e-mail tem chave" (409) de "não tem" (400), anulando o 202 acima. Exigindo o código primeiro, só descobre quem já controla a caixa de entrada.
- **O e-mail não é gravado em claro.** As chaves do Redis usam o hash dele, e do código guardamos só o hash — como já era feito com as chaves de API.
- **Uma chave por e-mail.** O código vale 30 minutos e aceita 5 tentativas; esgotadas, ele é invalidado e é preciso pedir outro. O contador usa `incr`, atômico, então chamadas simultâneas não furam o limite.
- **Limites da rota pública:** 5 pedidos por minuto por IP e 2 por minuto por e-mail (para o cadastro não servir de ferramenta para inundar a caixa de alguém); 10 verificações por minuto por IP.
- Envio pelo **Resend** (`POST /emails`, sem SDK). Sem `RESEND_API_KEY` e `EMAIL_FROM`, as duas rotas respondem 503 — inclusive a de verificação, porque devolver "código inválido" a quem nunca pôde receber um código seria enganoso.

## Landing page

`index.html` na raiz é a página pública, servida pela Vercel como estático (as funções ficam sob `api/`). Sem framework, sem build: um arquivo com CSS e um punhado de JS embutidos.

Duas decisões que vale conhecer antes de mexer:

- **Os dados da página foram gerados pelo código do projeto.** A linha digitável do exemplo é um boleto válido de verdade (DV geral por módulo 11, DVs de campo por módulo 10), o BR Code tem CRC conferido, o CNPJ alfanumérico é o exemplo oficial da Receita. Se for trocar algum, gere com `lib/boleto.ts` / `lib/pix.ts` em vez de inventar — a página não deve conseguir mentir.
- **As fontes vêm do Google Fonts** (Chivo e Azeret Mono), que é a única dependência externa da página. Se isso incomodar, dá para hospedar os `woff2` no próprio domínio; o desenho degrada para as fontes do sistema sem quebrar.

A página faz o cadastro em duas etapas, chamando `/v1/signup` e `/v1/signup/verify` do mesmo domínio. O `curl` continua ali, embaixo: é o caminho de quem prefere a linha de comando **e** o que funciona se o JavaScript falhar. Ele troca o placeholder pelo domínio de onde a página foi servida, para funcionar colado; em `localhost` o placeholder é mantido.

O JavaScript da página **não está na suíte automatizada** — testá-lo exigiria um navegador headless, dependência que o projeto não tem. Os doze estados de erro, o reenvio, a correção de endereço, a tecla Enter e a exibição da chave foram exercitados no navegador, com as respostas da API simuladas. Mexendo ali, refaça essa conferência.

## Documentação OpenAPI

`GET /v1/openapi.json` devolve a especificação OpenAPI 3.1 de todos os endpoints. Pública de propósito: a documentação precisa ser legível por quem ainda não tem chave.

Para ler num navegador, aponte um renderizador para essa URL — [Scalar](https://github.com/scalar/scalar), [Redoc](https://github.com/Redocly/redoc) ou o Swagger Editor servem. O documento vai com `access-control-allow-origin: *` justamente para isso. Nenhuma página HTML foi adicionada aqui: isso traria um script de CDN para dentro do projeto, e a decisão de fazer ou não isso fica para a landing page.

O spec é **construído em TypeScript** (`lib/openapi.ts`), não escrito como JSON estático, porque documentação de API erra por desatualizar e um arquivo solto não tem como avisar. Daí:

- Os limites documentados saem das mesmas constantes que o código aplica (`PLANS`, `LIMITS` do Pix). Mudar a cota muda a documentação.
- **Os exemplos são gerados pelas mesmas funções que os endpoints usam.** O BR Code do exemplo é um Pix válido, a linha digitável tem todos os dígitos verificadores corretos, a lista de feriados é a que a API devolve. Exemplo errado na documentação custa caro: quem lê copia, não funciona, e passa a desconfiar do resto — então há teste decodificando cada um.
- Cada endpoint de produto declara **"Quando usar"**, e há teste conferindo que nenhum entra sem isso.
- Os testes conferem cobertura **nos dois sentidos**: toda rota exportada em `api/` precisa estar no spec, e todo caminho do spec precisa existir como rota. Endpoint novo sem documentação quebra a suíte, e documentação de rota removida também.
- O webhook do Asaas é excluído de propósito (quem chama é o provedor, não clientes). A exclusão é uma lista explícita e testada: se a rota deixar de existir, o teste avisa que o motivo registrado ficou obsoleto.
- Outras conferências: todo `$ref` resolve, nenhum schema fica órfão, `operationId` é único, rota pública declara `security: []` (sem isso a doc pediria chave de quem está tentando obtê-la), e endpoint que consome cota documenta o 402 — e quem não consome, não documenta.

## Rotação e recuperação de chave

Dois caminhos, para situações diferentes:

```bash
# Ainda tenho a chave e quero trocá-la (suspeita de vazamento, higiene periódica)
curl -X POST https://SEU-DOMINIO/v1/keys/rotate -H "x-api-key: ak_live_..."

# Perdi a chave: o e-mail é a identidade
curl -X POST https://SEU-DOMINIO/v1/keys/recover \
  -H "content-type: application/json" -d '{ "email": "voce@exemplo.com.br" }'
curl -X POST https://SEU-DOMINIO/v1/keys/recover/verify \
  -H "content-type: application/json" -d '{ "email": "voce@exemplo.com.br", "code": "ABCD2345" }'
```

**O id da chave é estável, o segredo é que roda.** Isso exigiu desacoplar as duas coisas: antes o id era o prefixo do hash do segredo, então trocar o segredo trocaria o id — e o id é a âncora da cota mensal, do limite por minuto, do registro de cobrança, do dono dos QR Codes e do `externalReference` da assinatura no Asaas. Uma rotação ingênua zeraria a cota, deixaria a cobrança órfã, tornaria os QR Codes inacessíveis e faria o próximo checkout criar uma **segunda assinatura**, reintroduzindo a cobrança em dobro. Agora o id é sorteado na criação e preservado na rotação; chaves criadas antes seguem válidas, porque nada recalcula o id a partir do segredo.

O que mais vale saber:

- **A chave anterior é revogada na hora.** Se a resposta da rotação se perder no caminho, a antiga já morreu e a nova é desconhecida: a saída é a recuperação por e-mail.
- A ordem de gravação é nova chave → índice → remoção da antiga. Apagar primeiro deixaria, numa falha no meio, o `keyidx` apontando para um hash removido: a chave ficaria inalcançável até pelo id, e nem a recuperação consertaria. Em troca, uma falha pode deixar o segredo antigo valendo — repetir a rotação resolve.
- **Recuperar é rotacionar**, não emitir chave nova: o plano, a cota do mês, os QR Codes e a assinatura são preservados.
- `POST /v1/keys/recover` responde 202 em todo e-mail válido, exista chave ou não, pela mesma razão do cadastro. E-mail sem chave recebe um e-mail orientando o cadastro.
- Cadastro e recuperação têm **baldes de limite separados** e **códigos separados por propósito**: um código pedido para criar chave não rotaciona a de ninguém. Hoje os dois nunca coexistem para o mesmo e-mail, então isso é defesa para um fluxo futuro.
- Quem controla a caixa de e-mail consegue substituir a chave. É a propriedade inerente a qualquer recuperação por e-mail.

## Cobrança com Asaas

Fluxo: o cliente já tem uma chave free, chama `POST /v1/billing/checkout` com o plano e os dados de quem paga, recebe o link da fatura do Asaas (onde escolhe Pix, boleto ou cartão) e paga. O Asaas avisa pelo webhook e a chave sobe de plano.

```bash
curl -X POST https://SEU-DOMINIO/v1/billing/checkout \
  -H "x-api-key: ak_live_..." -H "content-type: application/json" \
  -d '{ "plan": "pro", "customer": { "name": "Maria Souza", "document": "529.982.247-25", "email": "maria@exemplo.com.br" } }'
```

**Como o acesso é liberado.** Cada pagamento confirmado (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` ou `PAYMENT_DUNNING_RECEIVED`) estende o fim do período pago da chave em 31 dias + 3 de tolerância, a partir do que for mais tarde entre o vencimento e o momento do evento. Passada essa data a chave volta ao plano free sozinha, sem depender de evento de inadimplência nem da ordem em que os webhooks chegam (o Asaas entrega cada evento pelo menos uma vez e não garante ordem; aqui eventos repetidos não causam efeito duplicado).

| Evento do Asaas | O que acontece |
|---|---|
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_DUNNING_RECEIVED` | Libera o plano e estende o período pago (Pix emite só `RECEIVED`; boleto e cartão emitem `CONFIRMED` e depois `RECEIVED`; `DUNNING_RECEIVED` é a cobrança recuperada por negativação) |
| `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED` | Revoga o acesso na hora |
| `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED` | Marca a assinatura como cancelada; o acesso pago continua até o fim do período |
| demais | Ignorados (respondem 200) |

**Contra cobrança em dobro.** `POST /subscriptions` não é idempotente e o Asaas não oferece `Idempotency-Key`. Se a resposta se perdesse depois de o Asaas já ter criado a assinatura, repetir o checkout criaria a segunda: o cliente seria cobrado duas vezes e o cancelamento só conheceria a última, deixando a primeira cobrando indefinidamente.

Por isso o checkout **procura antes de criar**, filtrando as assinaturas pelo `externalReference` (o id da chave), que é o caminho de reconciliação indicado pelo Asaas:

- Achou assinatura ativa e nosso Redis não a conhecia: ela é adotada (passa a aparecer em `GET /v1/billing` e a ser cancelável por `DELETE /v1/billing`) em vez de criar outra. O plano vem do valor que está sendo cobrado de verdade, não do que foi pedido.
- Achou e o plano pedido é outro: adota e devolve 409. A recusa não pode esconder uma cobrança real.
- Achou com valor fora dos planos atuais: 409 `subscription_conflict` com o id da assinatura, sem adivinhar plano.
- **A consulta falhou: o checkout falha também**, sem criar nada. Para dinheiro, falhar fechando é o lado certo de errar.

O mesmo vale para o cliente, com consequência menor: cliente duplicado não cobra ninguém, então ali a falha na consulta não interrompe o checkout.

**Troca de plano.** `PUT /v1/billing` altera o plano da assinatura ativa, sem cancelar e contratar de novo. O Asaas **não faz cobrança proporcional**, então não há como acertar a diferença no meio do ciclo. A política escolhida dispensa proporcional e sempre favorece o cliente:

- **Upgrade vale na hora.** Quem sobe de plano normalmente acabou de bater na cota; esperar o ciclo virar anularia o motivo da troca. O custo é a diferença de cota pelo resto do período já pago. Se ainda não há período pago em vigor, não há o que antecipar: o plano passa a valer quando o pagamento for confirmado.
- **Downgrade vale no próximo pagamento confirmado.** O período em curso foi pago no plano maior e o Asaas não devolve a diferença, então tirar o acesso agora seria retomar algo já pago.
- O valor novo é aplicado também às cobranças já geradas e não pagas (`updatePendingPayments: true`): quem troca antes de pagar paga o preço novo já neste ciclo.
- Pedir o plano em que a chave já está responde 200 com `changed: false`, para que uma repetição por timeout não pareça falha.
- Depois de um downgrade em vigor, a cota pode ficar abaixo do que já foi consumido no mês. Nesse caso as chamadas respondem 402 até a virada do mês.

**Reconciliação (quando o webhook falha).** O webhook é o único caminho que libera acesso, e ele falha de formas que ninguém percebe: o Asaas pausa a fila depois de 15 falhas seguidas, um deploy com erro perde eventos. O resultado seria o cliente sem o acesso que pagou.

`GET /v1/billing` reconstrói o direito a partir das cobranças que o Asaas realmente tem, sem depender de evento nenhum. Isso roda **só quando o estado é suspeito** — assinatura ativa e sem acesso pago vigente, que é exatamente o sintoma de um evento perdido (e também o estado normal de quem ainda não pagou). No caminho saudável não há chamada extra.

- Aplica a mesma regra do webhook (`paidUntil`): uma definição só, porque duas divergiriam e a divergência apareceria como cliente sem acesso.
- É idempotente: parte do estado das cobranças, não de eventos.
- **Só estende, nunca encurta.** Cobrança estornada não entra na conta, mas as pagas e mantidas continuam valendo, então um estorno pontual não apaga o período que outras já cobriram.
- Também sincroniza a assinatura: removida no painel do Asaas sem o evento chegar, ela ficaria presa em `active` e impediria contratar de novo. Se a consulta falhar, nada é marcado — cancelar por engano liberaria um segundo checkout.
- O evento traz `dateCreated` com hora, mas o objeto da cobrança só tem datas sem hora (`paymentDate`, e `clientPaymentDate` como alternativa). Essa data é lida como o **fim** do dia, para que um evento perdido nunca custe acesso: a falha foi nossa.
- Dinheiro recebido por negativação conta: `PAYMENT_DUNNING_RECEIVED` libera o acesso, e o status `DUNNING_RECEIVED` entra na reconciliação. Chega atrasado, mas é pagamento.

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

- Não há cobrança proporcional na troca de plano, porque o Asaas não oferece. Ver a política de troca acima.
- Quem cancela mantém o acesso até o fim do período pago e não recebe reembolso automático.
- O documento do cliente (CPF/CNPJ) vai direto ao Asaas e não é guardado aqui; só o id do cliente e da assinatura ficam no Redis.
- Não verificado ainda contra o Asaas real: se o link da fatura da primeira cobrança já está disponível logo após criar a assinatura (se não estiver, `payment_url` vem nulo e `GET /v1/billing` devolve o link em `pending_payment_url`), se o cadastro de cliente aceita CNPJ alfanumérico e se há restrições para o domínio de `BILLING_SUCCESS_URL`.
- O que **já foi conferido na documentação** (não no sandbox): o header `asaas-access-token` e a pausa da fila após 15 falhas; o formato de `dateCreated` (`AAAA-MM-DD HH:MM:SS`) e de `dueDate`; `payment.subscription` vindo só quando a cobrança pertence a uma assinatura; os filtros `externalReference` em `/subscriptions` e `/customers`; `limit` máximo de 100; os status de assinatura (`ACTIVE`, `EXPIRED`, `INACTIVE`) e de cobrança; e que `GET /subscriptions` **exclui as removidas por padrão** (`includeDeleted`/`deletedOnly` para o contrário). Como `EXPIRED` e `INACTIVE` não são removidas e voltam na listagem, é o filtro por `status === "ACTIVE"` que impede adotar uma assinatura que já não cobra nada.

## Outros limites conhecidos

- Cadastro: não há bloqueio de e-mail descartável. A lista de domínios é interminável e envelhece rápido; se virar problema, o caminho é um provedor de reputação, não uma lista no repositório.
- Rotação: não há período de carência. A chave antiga morre no mesmo instante, o que exige trocar a configuração do cliente de uma vez. Carência seria mais confortável em produção, mas deixaria um segredo vazado valendo por mais tempo.
- Cadastro: não verificado contra o Resend real — o cliente foi conferido na documentação deles, mas nenhum e-mail foi enviado de verdade ainda.

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
   Para o cadastro público, defina também `RESEND_API_KEY` e `EMAIL_FROM` (ex.: `API <nao-responda@seu-dominio.com.br>`); o domínio precisa estar verificado no Resend.
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
  openapi.ts    especificação OpenAPI 3.1, derivada das constantes do código
  rateLimit.ts  contador de janela por minuto (usado pelo withApi e pelo /r/:id)
  auth.ts       chaves (somente hash armazenado), plano em vigor e rotação do segredo
  billing.ts    checkout, cancelamento e processamento dos eventos do Asaas
  asaas.ts      cliente HTTP do Asaas (sem dependências)
  store.ts      Redis (Upstash) com fallback em memória
  plans.ts      planos, preços e limites
  validators.ts CPF e CNPJ (numérico e alfanumérico)
  pix.ts        BR Code do Pix (EMV/BACEN): monta, decodifica e CRC-16
  boleto.ts     linha digitável e código de barras (cobrança e arrecadação)
  payments.ts   identifica o formato e decodifica (compõe pix.ts e boleto.ts)
  signup.ts     cadastro público: código de verificação e emissão da chave
  email.ts      envio transacional pelo Resend (sem dependências)
  holidays.ts   feriados nacionais e dias úteis
  qr.ts         QR dinâmico
scripts/create-key.ts
test/
```

## Pendências

Lista mantida em ordem de prioridade. O que está em "verificação externa" não é resolvível escrevendo código: depende de credencial, deploy ou de um aparelho real.

### Verificação externa (bloqueia confiança no que já está feito)

1. **Pagamento de teste de ponta a ponta no sandbox do Asaas.** É a maior dívida do projeto. Toda a cobrança está verificada contra um Asaas simulado neste repositório, com os campos conferidos na documentação — nunca contra o serviço real. Nessa rodada, confirmar também:
   - se o link da fatura da primeira cobrança já existe logo após criar a assinatura (se não, `payment_url` vem nulo e o link aparece em `pending_payment_url`);
   - se o cadastro de cliente aceita CNPJ alfanumérico;
   - se há restrição de domínio para `BILLING_SUCCESS_URL`;
   - se `DUNNING_RECEIVED` significa de fato dinheiro creditado (foi inferido da descrição "payment received");
   - se `PUT /subscriptions` com `updatePendingPayments: true` realmente altera o valor da cobrança pendente.
2. **Ler um QR Pix gerado aqui num app de banco de verdade.** O formato está conferido contra a especificação do BACEN e o CRC contra dois vetores independentes, mas nenhum QR foi escaneado. Usar valor baixo.
3. **Confirmar que o `index.html` da raiz é servido em `/` no deploy.** A documentação da Vercel não é explícita para projetos sem framework que também têm `api/`; se não for, basta um `outputDirectory` ou mover o arquivo.
4. **Enviar um e-mail de verdade pelo Resend.** O cliente está conferido na documentação, mas nenhum e-mail saiu. Exige domínio verificado na conta.
5. **Conferir um boleto real.** Os algoritmos batem com os exemplos resolvidos da FEBRABAN e com um par código de barras/linha digitável de terceiro; falta passar uma linha digitável de boleto recebido de verdade.

### Produto

4. **Renderizador do OpenAPI na própria página**, se valer trazer um script de CDN (Scalar, Redoc) para o projeto. Hoje a landing só aponta para o `/v1/openapi.json` cru.
5. **Revisar planos e preços** em `lib/plans.ts`, hoje provisórios, depois de medir custo real.

### Técnico

6. **Carência na rotação**, se a troca sem janela se mostrar incômoda na prática: aceitar o segredo anterior por alguns minutos.
7. **Reconciliação ativa**, por rotina agendada, em vez de só no `GET /v1/billing`. Hoje a autocura depende de o cliente consultar o status.
8. **Teste automatizado do JavaScript da landing**, se ela crescer. Hoje a conferência é manual no navegador; um runner headless é dependência nova e só se paga com mais interface.
9. **Paginação nas consultas ao Asaas.** O limite de 100 por página cobre mais de 8 anos de assinatura mensal, mas não é infinito.
10. **HTML → PDF e screenshot.** Precisa de Chromium headless: avaliar a Vercel com build compacto ou uma VPS pequena. É projeto, não tarefa.
11. **Créditos pré-pagos**, necessários antes de qualquer endpoint com IA. O gancho já existe em `withApi(handler, { cost: N })`.
