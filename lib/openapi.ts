import { cobrancaBarcodeToLine, decodeBoleto, mod11Cobranca } from "./boleto.js";
import { decodePayment } from "./payments.js";
import { holidaysForYear } from "./holidays.js";
import { buildBrCode, LIMITS as PIX_LIMITS, parseBrCode } from "./pix.js";
import { PLANS, type PlanId } from "./plans.js";
import { cnpjKind, formatCnpj, formatCpf, normalizeCnpj, normalizeCpf } from "./validators.js";

/**
 * Especificação OpenAPI 3.1 do portfólio.
 *
 * Construída em TypeScript, e não escrita como JSON estático, por um motivo: os limites
 * documentados saem das **mesmas constantes que o código aplica** (`PLANS`, `LIMITS` do Pix).
 * Documentação de API erra por desatualizar, e um arquivo solto não tem como avisar quando a
 * cota muda. Os testes fecham o resto do cerco, conferindo que toda rota exportada aparece aqui
 * e que nenhum caminho daqui deixou de existir.
 */

type Json = Record<string, unknown>;

const PLAN_IDS: PlanId[] = ["free", "pro", "scale"];

// ---------------------------------------------------------------------------
// Exemplos da especificação, produzidos pelas MESMAS funções que os endpoints
// usam. Exemplo errado na documentação custa caro: quem lê copia, não funciona,
// e passa a desconfiar do resto. Assim não existe exemplo que não feche — e há
// teste conferindo que cada um continua válido.

const PIX_EXAMPLE = (() => {
  const brCode = buildBrCode({
    key: "contato@livrariasaojorge.com.br",
    name: "Livraria Sao Jorge",
    city: "Sao Paulo",
    amount: 89.9,
    txid: "PEDIDO4471",
  });
  return { brCode, decoded: parseBrCode(brCode) };
})();

const BOLETO_EXAMPLE = (() => {
  // Vencimento a ~30 dias da virada do fator, para o exemplo não nascer vencido.
  const dueDays = 1636;
  const semDv = `0019X${dueDays}0000124790` + "0000000012345678901234567".slice(0, 25);
  const dv = mod11Cobranca(semDv.slice(0, 4) + semDv.slice(5));
  const barcode = `0019${dv}${dueDays}0000124790` + "0000000012345678901234567".slice(0, 25);
  const line = cobrancaBarcodeToLine(barcode);
  return { barcode, line, decoded: decodeBoleto(line) };
})();

const CPF_EXAMPLE = "529.982.247-25";
const CNPJ_EXAMPLE = "12.ABC.345/01DE-35";
const HOLIDAYS_EXAMPLE_YEAR = 2026;

/** Tabela de planos para a descrição, derivada de lib/plans.ts. */
const planTable = PLAN_IDS.map((id) => {
  const plan = PLANS[id];
  const price = plan.priceBRL === 0 ? "gratuito" : `R$ ${plan.priceBRL}/mês`;
  return `| \`${id}\` | ${plan.monthlyQuota.toLocaleString("pt-BR")} | ${plan.perMinute} | ${price} |`;
}).join("\n");

const DESCRIPTION = `APIs utilitárias para o mercado brasileiro: QR Code, Pix, boleto, validação de CPF/CNPJ e feriados.

## Autenticação

Envie a chave em \`x-api-key: ak_live_...\` ou \`Authorization: Bearer ak_live_...\`. Obtenha uma
chave gratuita em \`POST /v1/signup\`, sem cartão.

## Planos

| Plano | Chamadas/mês | Req/min | Preço |
|---|---|---|---|
${planTable}

A cota mensal (mês em UTC) só é debitada em respostas bem-sucedidas (< 400). O limite por minuto
conta toda requisição autenticada, inclusive as que falham. Toda resposta autenticada traz
\`x-ratelimit-*\` e \`x-usage-*\`.

Os endpoints de cobrança e de rotação de chave não consomem cota: precisam funcionar justamente
quando ela acaba.

## Erros

Todos seguem o formato \`{ "error": { "code", "message" } }\`. O \`code\` é estável e serve para
tratamento programático; a \`message\` é texto para humanos e pode mudar.`;

const errorResponse = (description: string, ...codes: string[]): Json => ({
  description: codes.length > 0 ? `${description} (\`code\`: ${codes.map((c) => `\`${c}\``).join(", ")})` : description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** Respostas que todo endpoint autenticado pode devolver. */
const authErrors = (): Json => ({
  "401": { $ref: "#/components/responses/Unauthorized" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalError" },
});

/** Idem, mais o 402 de cota esgotada: só para quem consome cota. */
const meteredErrors = (): Json => ({
  "402": { $ref: "#/components/responses/QuotaExceeded" },
  ...authErrors(),
});

const jsonBody = (schema: Json, examples?: Json, required = true): Json => ({
  required,
  content: { "application/json": { schema, ...(examples ? { examples } : {}) } },
});

const jsonResponse = (description: string, schema: Json, examples?: Json): Json => ({
  description,
  content: { "application/json": { schema, ...(examples ? { examples } : {}) } },
});

/** Um exemplo nomeado, do jeito que o OpenAPI espera. */
const ex = (summary: string, value: unknown): Json => ({ summary, value });

/** Rotas públicas sobrescrevem o `security` global com uma lista vazia. */
const PUBLIC = { security: [] as unknown[] };

export function buildOpenApiDocument(serverUrl?: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "APIs do portfólio",
      version: "0.1.0",
      description: DESCRIPTION,
    },
    servers: [{ url: serverUrl ?? "/", description: "Esta instalação" }],
    security: [{ apiKeyHeader: [] }, { bearerAuth: [] }],
    tags: [
      { name: "QR Code", description: "QR Code estático e dinâmico" },
      { name: "Pix", description: "BR Code do Pix (copia e cola)" },
      { name: "Boleto", description: "Linha digitável e código de barras" },
      { name: "Pagamentos", description: "Qualquer código de pagamento, sem saber o formato antes" },
      { name: "Validação", description: "CPF e CNPJ" },
      { name: "Feriados", description: "Feriados nacionais e dias úteis" },
      { name: "Chaves", description: "Cadastro, rotação e recuperação" },
      { name: "Cobrança", description: "Planos e assinatura" },
      { name: "Serviço", description: "Saúde e especificação" },
    ],

    paths: {
      // --- QR Code -------------------------------------------------------
      "/v1/qr": {
        get: {
          tags: ["QR Code"],
          operationId: "getStaticQr",
          summary: "QR Code estático",
          description:
            "Gera a imagem de um QR Code com o conteúdo informado. Nada é armazenado.\n\n" +
            "**Quando usar:** imprimir um QR num cartaz, etiqueta, crachá ou cardápio com conteúdo " +
            "que não muda. Se o destino puder mudar depois de impresso, use o QR dinâmico.",
          parameters: [
            { name: "data", in: "query", required: true, schema: { type: "string", maxLength: 1000 }, description: "Conteúdo do QR Code." },
            { name: "format", in: "query", schema: { type: "string", enum: ["png", "svg"], default: "png" } },
            { name: "size", in: "query", schema: { type: "integer", minimum: 64, maximum: 1024, default: 256 }, description: "Lado da imagem em pixels (só para PNG)." },
            { name: "margin", in: "query", schema: { type: "integer", minimum: 0, maximum: 10, default: 2 } },
            { name: "ecc", in: "query", schema: { type: "string", enum: ["L", "M", "Q", "H"], default: "M" }, description: "Nível de correção de erro." },
          ],
          responses: {
            "200": {
              description: "A imagem do QR Code.",
              content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/svg+xml": { schema: { type: "string" } } },
            },
            "400": errorResponse("Parâmetro inválido", "missing_data", "data_too_long", "invalid_format", "invalid_size", "invalid_margin", "invalid_ecc", "data_too_large"),
            ...meteredErrors(),
          },
        },
      },

      "/v1/qr/codes": {
        post: {
          tags: ["QR Code"],
          operationId: "createDynamicQr",
          summary: "Cria QR Code dinâmico",
          description:
            "Cria um QR Code cujo destino pode ser trocado depois, sem reimprimir a imagem. " +
            "A imagem aponta para um link curto `/r/{id}`, que também conta as leituras.\n\n" +
            "**Quando usar:** material impresso cujo destino pode mudar — cardápio de restaurante, " +
            "cartaz de campanha, etiqueta de produto, placa de vitrine. Troque o destino quando o " +
            "cardápio mudar de link ou a promoção acabar, sem reimprimir nada, e acompanhe quantas " +
            "leituras cada peça teve.",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["url"],
              properties: { url: { type: "string", format: "uri", maxLength: 2048, description: "Destino http(s) público." } },
            },
            { cardapio: ex("Cardápio de restaurante", { url: "https://livrariasaojorge.com.br/cardapio" }) },
          ),
          responses: {
            "201": jsonResponse("QR Code criado.", { $ref: "#/components/schemas/DynamicQrCreated" }, {
              cardapio: ex("Resposta da criação acima", {
                id: "k3Dm9Qz",
                short_url: "https://SEU-DOMINIO/r/k3Dm9Qz",
                target_url: "https://livrariasaojorge.com.br/cardapio",
                image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg… (PNG completo, encurtado aqui)",
              }),
            }),
            "400": errorResponse("URL inválida", "invalid_url"),
            ...meteredErrors(),
          },
        },
        get: {
          tags: ["QR Code"],
          operationId: "getDynamicQr",
          summary: "Consulta um QR Code dinâmico",
          parameters: [{ $ref: "#/components/parameters/QrCodeId" }],
          responses: {
            "200": jsonResponse("Destino atual e contagem de leituras.", { $ref: "#/components/schemas/DynamicQr" }),
            "400": errorResponse("Id ausente ou malformado", "invalid_id"),
            "404": errorResponse("Não existe ou não pertence a esta chave", "not_found"),
            ...meteredErrors(),
          },
        },
        patch: {
          tags: ["QR Code"],
          operationId: "updateDynamicQr",
          summary: "Troca o destino",
          description: "A imagem já impressa continua valendo: só o destino do link curto muda.",
          parameters: [{ $ref: "#/components/parameters/QrCodeId" }],
          requestBody: jsonBody({
            type: "object",
            required: ["url"],
            properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
          }),
          responses: {
            "200": jsonResponse("Destino trocado.", {
              type: "object",
              properties: { id: { type: "string" }, target_url: { type: "string", format: "uri" } },
            }),
            "400": errorResponse("Id ou URL inválidos", "invalid_id", "invalid_url"),
            "404": errorResponse("Não existe ou não pertence a esta chave", "not_found"),
            ...meteredErrors(),
          },
        },
      },

      "/r/{id}": {
        get: {
          tags: ["QR Code"],
          operationId: "followDynamicQr",
          summary: "Redirecionamento público",
          description:
            "Destino de um QR Code dinâmico. Responde 302 (nunca 301) para que a troca de destino " +
            "valha na hora e cada leitura seja contada. Rota pública, limitada por IP.",
          ...PUBLIC,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9A-Za-z]{7}$" } }],
          responses: {
            "302": { description: "Redireciona para o destino atual.", headers: { Location: { schema: { type: "string", format: "uri" } } } },
            "404": { description: "Link inexistente.", content: { "text/plain": { schema: { type: "string" } } } },
            "429": { description: "Limite de leituras por minuto excedido.", content: { "text/plain": { schema: { type: "string" } } } },
          },
        },
      },

      // --- Pix -----------------------------------------------------------
      "/v1/pix/qr": {
        post: {
          tags: ["Pix"],
          operationId: "createPixBrCode",
          summary: "Gera BR Code do Pix",
          description:
            "Monta o payload do Pix copia e cola (padrão EMV do BACEN) e a imagem em PNG. " +
            "Totalmente offline: não fala com banco nem PSP. Só gera código **estático**.\n\n" +
            "**Quando usar:** cobrar no checkout do seu site, mandar cobrança por WhatsApp ou e-mail, " +
            "ou imprimir numa fatura. O `txid` que você enviar aparece no extrato do seu PSP, então " +
            "use o número do pedido ali para casar o pagamento com a venda sem conferência manual.",
          requestBody: jsonBody({
            type: "object",
            required: ["key", "name", "city"],
            properties: {
              key: { type: "string", description: "Chave Pix: CPF, CNPJ, telefone (+55DDNNNNNNNNN), e-mail ou chave aleatória (UUID)." },
              name: { type: "string", maxLength: PIX_LIMITS.name, description: "Nome do beneficiário. Acentos são removidos." },
              city: { type: "string", maxLength: PIX_LIMITS.city, description: "Cidade do beneficiário. Acentos são removidos." },
              amount: { type: "number", exclusiveMinimum: 0, description: "Valor em reais. Ausente deixa o pagador digitar." },
              txid: { type: "string", maxLength: PIX_LIMITS.txid, pattern: "^[A-Za-z0-9]+$", description: "Identificador da transação." },
              description: { type: "string", description: "Informação adicional. O campo 26 inteiro não passa de 99 caracteres, então o espaço depende do tamanho da chave." },
              reusable: { type: "boolean", default: true, description: "false marca o código como de uso único." },
            },
          }, {
            pedido: ex("Cobrança de um pedido", {
              key: "contato@livrariasaojorge.com.br",
              name: "Livraria Sao Jorge",
              city: "Sao Paulo",
              amount: 89.9,
              txid: "PEDIDO4471",
            }),
            semValor: ex("Doação, com o pagador escolhendo o valor", {
              key: "12.345.678/0001-95",
              name: "Instituto Semear",
              city: "Recife",
            }),
          }),
          responses: {
            "201": jsonResponse("BR Code e imagem.", { $ref: "#/components/schemas/PixBrCode" }, {
              pedido: ex("Resposta da cobrança acima", {
                br_code: PIX_EXAMPLE.brCode,
                key_type: "email",
                image_data_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg… (PNG completo, encurtado aqui)",
              }),
            }),
            "400": errorResponse("Entrada fora da especificação", "invalid_body", "missing_fields", "invalid_key", "invalid_name", "invalid_city", "invalid_amount", "invalid_txid", "invalid_reusable", "fields_too_long"),
            ...meteredErrors(),
          },
        },
      },

      "/v1/pix/decode": {
        post: {
          tags: ["Pix"],
          operationId: "decodePixBrCode",
          summary: "Decodifica um BR Code",
          description:
            "Confere o CRC e devolve os campos. Payload bem formado com CRC errado responde 200 " +
            "com `valid: false` e o que deu para ler — quem depura precisa ver os campos.\n\n" +
            "**Quando usar:** conferir um código que o cliente colou antes de dar baixa, extrair o " +
            "`txid` de um Pix recebido para casar com o pedido, ou validar no seu app que o código " +
            "escaneado é íntegro antes de mandar o usuário pagar.",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["br_code"],
              properties: { br_code: { type: "string", maxLength: 1024 } },
            },
            { recebido: ex("Código colado pelo cliente", { br_code: PIX_EXAMPLE.brCode }) },
          ),
          responses: {
            "200": jsonResponse("Campos lidos do BR Code.", { $ref: "#/components/schemas/PixDecoded" }, {
              recebido: ex("Código íntegro", PIX_EXAMPLE.decoded),
            }),
            "400": errorResponse("Não é um BR Code", "invalid_body", "malformed_br_code"),
            ...meteredErrors(),
          },
        },
      },

      // --- Boleto --------------------------------------------------------
      "/v1/boleto/decode": {
        post: {
          tags: ["Boleto"],
          operationId: "decodeBoleto",
          summary: "Valida e converte boleto",
          description:
            "Aceita linha digitável (47 dígitos na cobrança, 48 na arrecadação) ou código de barras (44), " +
            "com ou sem pontuação, e identifica o formato sozinho. Devolve as duas representações, então " +
            "serve de conversor. Valida estrutura e dígitos verificadores; **não** diz se o boleto está pago.\n\n" +
            "**Quando usar:** dar baixa em boleto que o cliente mandou por e-mail, extraindo valor e " +
            "vencimento sem digitação; validar o código num formulário antes de enviar ao banco, porque " +
            "código errado volta rejeitado e vira chamado de suporte; ou converter o que o leitor de " +
            "código de barras capturou em linha digitável para conferência humana.\n\n" +
            "Atenção ao `due_date_ambiguous`: o fator de vencimento reiniciou em fevereiro de 2025 e " +
            "todo fator passou a mapear duas datas possíveis.",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["code"],
              properties: { code: { type: "string", maxLength: 128 } },
            },
            {
              linha: ex("Linha digitável, como o cliente envia", { code: BOLETO_EXAMPLE.line }),
              barras: ex("Código de barras, como o leitor captura", { code: BOLETO_EXAMPLE.barcode }),
            },
          ),
          responses: {
            "200": jsonResponse("Campos do boleto.", {
              oneOf: [{ $ref: "#/components/schemas/BoletoCobranca" }, { $ref: "#/components/schemas/BoletoArrecadacao" }],
              discriminator: { propertyName: "kind" },
            }, {
              cobranca: ex("Boleto de cobrança bancária", BOLETO_EXAMPLE.decoded),
            }),
            "400": errorResponse("Comprimento incompatível", "invalid_body", "invalid_length"),
            ...meteredErrors(),
          },
        },
      },

      // --- Pagamentos ----------------------------------------------------
      "/v1/payments/decode": {
        post: {
          tags: ["Pagamentos"],
          operationId: "decodePayment",
          summary: "Decodifica qualquer código de pagamento",
          description:
            "Aceita Pix copia e cola, linha digitável ou código de barras, identifica o formato " +
            "sozinho e devolve um envelope comum — valor, vencimento, beneficiário — mais a " +
            "decodificação completa do formato em `details`.\n\n" +
            "**Quando usar:** quando o usuário cola algo e você ainda não sabe o que é. Um campo " +
            "único de \"código de pagamento\" no seu app, conciliação de comprovantes que chegam " +
            "misturados, ou leitor de câmera que tanto lê QR de Pix quanto código de barras de " +
            "boleto. Evita ramificar no cliente antes de saber o formato.\n\n" +
            "Se já souber o formato, as rotas específicas (`/v1/pix/decode`, `/v1/boleto/decode`) " +
            "devolvem o mesmo conteúdo sem o envelope.",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["code"],
              properties: { code: { type: "string", maxLength: 1024, description: "O que o usuário colou, como veio." } },
            },
            {
              pix: ex("Pix copia e cola", { code: PIX_EXAMPLE.brCode }),
              boleto: ex("Linha digitável de boleto", { code: BOLETO_EXAMPLE.line }),
            },
          ),
          responses: {
            "200": jsonResponse("Formato identificado e campos lidos.", { $ref: "#/components/schemas/PaymentDecoded" }, {
              pix: ex("Reconhecido como Pix", decodePayment(PIX_EXAMPLE.brCode)),
              boleto: ex("Reconhecido como boleto de cobrança", decodePayment(BOLETO_EXAMPLE.line)),
            }),
            "400": errorResponse("Conteúdo irreconhecível", "invalid_body", "unrecognized_code"),
            ...meteredErrors(),
          },
        },
      },

      // --- Validação -----------------------------------------------------
      "/v1/validate/cnpj": {
        get: {
          tags: ["Validação"],
          operationId: "validateCnpjByQuery",
          summary: "Valida CNPJ",
          description:
            "Aceita numérico e alfanumérico. Valida formato e dígitos verificadores; não consulta a Receita.\n\n" +
            "**Quando usar:** barrar erro de digitação no cadastro antes de gravar, e conferir base " +
            "importada em lote.\n\n" +
            "**Atenção ao CNPJ alfanumérico**, em vigor desde julho de 2026: expressões regulares " +
            "antigas que só aceitam dígitos passam a recusar empresa válida, e o cálculo do dígito " +
            "mudou (cada caractere vale o código ASCII menos 48).",
          parameters: [{ name: "value", in: "query", required: true, schema: { type: "string", maxLength: 32 } }],
          responses: {
            "200": jsonResponse("Resultado da validação.", { $ref: "#/components/schemas/CnpjResult" }, {
              alfanumerico: ex("CNPJ alfanumérico", {
                valid: true,
                kind: cnpjKind(CNPJ_EXAMPLE),
                normalized: normalizeCnpj(CNPJ_EXAMPLE),
                formatted: formatCnpj(CNPJ_EXAMPLE),
              }),
              recusado: ex("Dígito verificador errado", { valid: false, kind: null, normalized: null, formatted: null }),
            }),
            "400": errorResponse("Valor ausente ou longo demais", "missing_value"),
            ...meteredErrors(),
          },
        },
        post: {
          tags: ["Validação"],
          operationId: "validateCnpj",
          summary: "Valida CNPJ (corpo JSON)",
          requestBody: jsonBody({ type: "object", required: ["value"], properties: { value: { type: "string", maxLength: 32 } } }),
          responses: {
            "200": jsonResponse("Resultado da validação.", { $ref: "#/components/schemas/CnpjResult" }),
            "400": errorResponse("Valor ausente ou longo demais", "missing_value"),
            ...meteredErrors(),
          },
        },
      },

      "/v1/validate/cpf": {
        post: {
          tags: ["Validação"],
          operationId: "validateCpf",
          summary: "Valida CPF",
          description:
            "Só por POST: CPF é dado pessoal e query string vai para log de acesso. Nada é armazenado. " +
            "Valida formato e dígitos verificadores; não consulta a Receita.\n\n" +
            "**Quando usar:** conferir o CPF no cadastro antes de gravar, evitando base suja e cobrança " +
            "que não casa com o pagador.",
          requestBody: jsonBody(
            { type: "object", required: ["value"], properties: { value: { type: "string", maxLength: 32 } } },
            { cadastro: ex("CPF digitado no cadastro", { value: CPF_EXAMPLE }) },
          ),
          responses: {
            "200": jsonResponse("Resultado da validação.", { $ref: "#/components/schemas/CpfResult" }, {
              aceito: ex("CPF válido", {
                valid: true,
                normalized: normalizeCpf(CPF_EXAMPLE),
                formatted: formatCpf(CPF_EXAMPLE),
              }),
            }),
            "400": errorResponse("Valor ausente ou longo demais", "invalid_body"),
            ...meteredErrors(),
          },
        },
      },

      // --- Feriados ------------------------------------------------------
      "/v1/holidays": {
        get: {
          tags: ["Feriados"],
          operationId: "listHolidays",
          summary: "Feriados do ano",
          description:
            "Feriados nacionais e pontos facultativos federais. Estaduais e municipais não estão incluídos.\n\n" +
            "**Quando usar:** montar o calendário de atendimento, bloquear agendamento em feriado, e " +
            "decidir o que fazer com vencimento que cai em dia não útil. A Páscoa move Carnaval e " +
            "Corpus Christi todo ano, então tabela fixa envelhece sozinha.",
          parameters: [{ name: "year", in: "query", schema: { type: "integer", minimum: 1970, maximum: 2100 }, description: "Padrão: ano atual em UTC." }],
          responses: {
            "200": jsonResponse("Lista de feriados.", { $ref: "#/components/schemas/HolidaysResult" }, {
              ano: ex(`Feriados de ${HOLIDAYS_EXAMPLE_YEAR}`, {
                year: HOLIDAYS_EXAMPLE_YEAR,
                scope: "national",
                holidays: holidaysForYear(HOLIDAYS_EXAMPLE_YEAR),
              }),
            }),
            "400": errorResponse("Ano fora do intervalo", "invalid_year"),
            ...meteredErrors(),
          },
        },
      },

      "/v1/holidays/business-days": {
        get: {
          tags: ["Feriados"],
          operationId: "countBusinessDays",
          summary: "Conta dias úteis",
          description:
            "Exclui sábados, domingos e feriados nacionais. Intervalo máximo de 10 anos.\n\n" +
            "**Quando usar:** calcular prazo de entrega, SLA de atendimento, prazo processual ou " +
            "vencimento contratual contado em dias úteis. A resposta traz quais feriados entraram na " +
            "conta, o que serve para justificar o prazo ao cliente.",
          parameters: [
            { name: "from", in: "query", required: true, schema: { type: "string", format: "date" } },
            { name: "to", in: "query", required: true, schema: { type: "string", format: "date" } },
          ],
          responses: {
            "200": jsonResponse("Contagem e feriados excluídos.", { $ref: "#/components/schemas/BusinessDaysResult" }, {
              prazo: ex("Prazo de entrega em novembro", {
                from: "2026-11-01",
                to: "2026-11-30",
                total_days: 30,
                business_days: 19,
                holidays_excluded: holidaysForYear(2026).filter(
                  (h) => h.type === "national" && h.date >= "2026-11-01" && h.date <= "2026-11-30",
                ),
              }),
            }),
            "400": errorResponse("Datas inválidas ou intervalo longo demais", "invalid_date", "invalid_range", "range_too_long"),
            ...meteredErrors(),
          },
        },
      },

      // --- Chaves --------------------------------------------------------
      "/v1/signup": {
        post: {
          tags: ["Chaves"],
          operationId: "startSignup",
          summary: "Pede uma chave gratuita",
          description:
            "Envia um código de verificação por e-mail. Responde 202 para todo e-mail válido, exista " +
            "chave para ele ou não: a resposta não pode servir para descobrir quem está cadastrado.",
          ...PUBLIC,
          requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }),
          responses: {
            "202": jsonResponse("Pedido aceito.", { $ref: "#/components/schemas/Accepted" }),
            "400": errorResponse("E-mail inválido", "invalid_email"),
            "429": { $ref: "#/components/responses/RateLimited" },
            "502": errorResponse("Falha ao enviar o e-mail", "email_send_failed"),
            "503": errorResponse("Cadastro indisponível", "signup_unavailable"),
          },
        },
      },

      "/v1/signup/verify": {
        post: {
          tags: ["Chaves"],
          operationId: "verifySignup",
          summary: "Confirma o código e recebe a chave",
          description: "**A chave aparece só nesta resposta.** O que fica guardado é o hash dela.",
          ...PUBLIC,
          requestBody: jsonBody({ $ref: "#/components/schemas/EmailAndCode" }),
          responses: {
            "201": jsonResponse("Chave emitida.", { $ref: "#/components/schemas/IssuedKey" }),
            "400": errorResponse("Entrada inválida ou código errado", "invalid_body", "invalid_email", "no_pending_code", "invalid_code"),
            "409": errorResponse("Já existe chave para este e-mail", "key_already_issued"),
            "429": errorResponse("Tentativas esgotadas ou limite por IP", "too_many_attempts", "rate_limited"),
            "503": errorResponse("Cadastro indisponível", "signup_unavailable"),
          },
        },
      },

      "/v1/keys/rotate": {
        post: {
          tags: ["Chaves"],
          operationId: "rotateKey",
          summary: "Troca o segredo da chave atual",
          description:
            "Emite um segredo novo e **revoga o atual na hora**. O identificador da chave é preservado, " +
            "então plano, cota do mês, QR Codes e assinatura continuam valendo. Não consome cota.\n\n" +
            "Se a resposta se perder no caminho, a chave antiga já estará revogada e a nova desconhecida: " +
            "a saída é `POST /v1/keys/recover`.",
          responses: {
            "200": jsonResponse("Chave nova.", { $ref: "#/components/schemas/RotatedKey" }),
            "409": errorResponse("Rotação simultânea", "rotation_conflict"),
            ...authErrors(),
          },
        },
      },

      "/v1/keys/recover": {
        post: {
          tags: ["Chaves"],
          operationId: "startRecovery",
          summary: "Perdeu a chave: pede a substituição",
          description:
            "Envia um código que, confirmado, substitui a chave do e-mail. Responde 202 para todo e-mail " +
            "válido, exista chave ou não. Quem controla a caixa de e-mail consegue substituir a chave.",
          ...PUBLIC,
          requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }),
          responses: {
            "202": jsonResponse("Pedido aceito.", { $ref: "#/components/schemas/Accepted" }),
            "400": errorResponse("E-mail inválido", "invalid_email"),
            "429": { $ref: "#/components/responses/RateLimited" },
            "502": errorResponse("Falha ao enviar o e-mail", "email_send_failed"),
            "503": errorResponse("Recuperação indisponível", "recovery_unavailable"),
          },
        },
      },

      "/v1/keys/recover/verify": {
        post: {
          tags: ["Chaves"],
          operationId: "verifyRecovery",
          summary: "Confirma o código e recebe a chave nova",
          description: "A anterior deixa de funcionar na hora. Plano, cota do mês, QR Codes e assinatura são preservados.",
          ...PUBLIC,
          requestBody: jsonBody({ $ref: "#/components/schemas/EmailAndCode" }),
          responses: {
            "200": jsonResponse("Chave nova.", { $ref: "#/components/schemas/IssuedKey" }),
            "400": errorResponse("Entrada inválida ou código errado", "invalid_body", "invalid_email", "no_pending_code", "invalid_code"),
            "404": errorResponse("Não há chave para este e-mail", "no_key_for_email"),
            "429": errorResponse("Tentativas esgotadas ou limite por IP", "too_many_attempts", "rate_limited"),
            "503": errorResponse("Recuperação indisponível", "recovery_unavailable"),
          },
        },
      },

      // --- Cobrança ------------------------------------------------------
      "/v1/billing/checkout": {
        post: {
          tags: ["Cobrança"],
          operationId: "startCheckout",
          summary: "Contrata um plano",
          description:
            "Cria uma assinatura mensal no Asaas e devolve o link da fatura, onde o cliente escolhe Pix, " +
            "boleto ou cartão. O documento do pagador vai direto ao provedor e não é armazenado aqui. " +
            "Não consome cota.\n\nSe uma assinatura ativa já existir no provedor sem estar registrada aqui, " +
            "ela é adotada em vez de criar outra — é o que impede cobrança em dobro quando uma resposta se perde.",
          requestBody: jsonBody({ $ref: "#/components/schemas/CheckoutRequest" }, {
            pro: ex("Contratar o plano pro", {
              plan: "pro",
              customer: { name: "Maria Souza", document: "529.982.247-25", email: "maria@exemplo.com.br" },
            }),
          }),
          responses: {
            "201": jsonResponse("Assinatura criada.", { $ref: "#/components/schemas/CheckoutResult" }),
            "400": errorResponse("Entrada inválida", "invalid_plan", "invalid_name", "invalid_email", "invalid_document"),
            "409": errorResponse("Já existe assinatura ativa", "subscription_exists", "subscription_conflict"),
            "422": errorResponse("Dados recusados pelo provedor", "payment_provider_rejected"),
            "502": errorResponse("Falha ao falar com o provedor", "payment_provider_error"),
            "503": errorResponse("Cobrança indisponível", "billing_unavailable"),
            ...authErrors(),
          },
        },
      },

      "/v1/billing": {
        get: {
          tags: ["Cobrança"],
          operationId: "getBilling",
          summary: "Plano, assinatura e uso do mês",
          description:
            "Não consome cota. Quando há assinatura ativa sem acesso pago vigente — o sintoma de um evento " +
            "de webhook perdido — o acesso é reconstruído a partir das cobranças que o provedor tem.",
          responses: {
            "200": jsonResponse("Situação da cobrança.", { $ref: "#/components/schemas/BillingStatus" }),
            ...authErrors(),
          },
        },
        put: {
          tags: ["Cobrança"],
          operationId: "changePlan",
          summary: "Troca de plano",
          description:
            "Sem cancelar e contratar de novo. O provedor não faz cobrança proporcional, então: **upgrade " +
            "vale na hora** (quem sobe normalmente acabou de bater na cota) e **downgrade vale no próximo " +
            "pagamento confirmado** (o período em curso foi pago no plano maior). Pedir o plano em que a " +
            "chave já está responde 200 com `changed: false`. Não consome cota.",
          requestBody: jsonBody({
            type: "object",
            required: ["plan"],
            properties: { plan: { type: "string", enum: ["pro", "scale"] } },
          }),
          responses: {
            "200": jsonResponse("Plano alterado.", { $ref: "#/components/schemas/ChangePlanResult" }),
            "400": errorResponse("Plano inválido", "invalid_plan"),
            "404": errorResponse("Não há assinatura ativa", "no_active_subscription"),
            "502": errorResponse("Falha ao falar com o provedor", "payment_provider_error"),
            "503": errorResponse("Cobrança indisponível", "billing_unavailable"),
            ...authErrors(),
          },
        },
        delete: {
          tags: ["Cobrança"],
          operationId: "cancelSubscription",
          summary: "Cancela a assinatura",
          description: "O acesso pago continua até o fim do período já pago. Não há reembolso automático. Não consome cota.",
          responses: {
            "200": jsonResponse("Assinatura cancelada.", {
              type: "object",
              properties: {
                status: { type: "string", enum: ["cancelled"] },
                access_until: { type: ["string", "null"], format: "date-time" },
              },
            }),
            "404": errorResponse("Não há assinatura ativa", "no_active_subscription"),
            "502": errorResponse("Falha ao falar com o provedor", "payment_provider_error"),
            "503": errorResponse("Cobrança indisponível", "billing_unavailable"),
            ...authErrors(),
          },
        },
      },

      // --- Serviço -------------------------------------------------------
      "/v1/health": {
        get: {
          tags: ["Serviço"],
          operationId: "getHealth",
          summary: "Verificação de saúde",
          ...PUBLIC,
          responses: {
            "200": jsonResponse("Serviço de pé.", {
              type: "object",
              properties: { status: { type: "string", enum: ["ok"] }, time: { type: "string", format: "date-time" } },
            }),
          },
        },
      },

      "/v1/openapi": {
        get: {
          tags: ["Serviço"],
          operationId: "getOpenApiDocument",
          summary: "Esta especificação",
          description: "Também disponível em `/v1/openapi.json`.",
          ...PUBLIC,
          responses: { "200": jsonResponse("Documento OpenAPI 3.1.", { type: "object" }) },
        },
      },
    },

    components: {
      securitySchemes: {
        apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key" },
        bearerAuth: { type: "http", scheme: "bearer", description: "A mesma chave, em `Authorization: Bearer ak_live_...`." },
      },

      parameters: {
        QrCodeId: {
          name: "id",
          in: "query",
          required: true,
          schema: { type: "string", pattern: "^[0-9A-Za-z]{7}$" },
          description: "Id devolvido na criação.",
        },
      },

      responses: {
        Unauthorized: errorResponse("Chave ausente ou inválida", "missing_api_key", "invalid_api_key"),
        QuotaExceeded: errorResponse("Cota mensal esgotada", "quota_exceeded"),
        RateLimited: errorResponse("Limite por minuto excedido", "rate_limited"),
        InternalError: errorResponse("Erro interno", "internal_error"),
      },

      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", description: "Identificador estável do erro." },
                message: { type: "string", description: "Texto para humanos. Pode mudar." },
              },
            },
          },
        },

        Accepted: {
          type: "object",
          properties: { status: { type: "string", enum: ["accepted"] }, message: { type: "string" } },
        },

        EmailAndCode: {
          type: "object",
          required: ["email", "code"],
          properties: {
            email: { type: "string", format: "email" },
            code: { type: "string", maxLength: 32, description: "Os 8 caracteres recebidos por e-mail. Maiúsculas e minúsculas são equivalentes." },
          },
        },

        IssuedKey: {
          type: "object",
          properties: {
            api_key: { type: "string", description: "**Só aparece aqui.** Guarde antes de fechar a resposta." },
            key_id: { type: "string", description: "Identificador público e estável, preservado na rotação." },
            owner: { type: "string", format: "email" },
            plan: { type: "string", enum: PLAN_IDS },
            rotated_at: { type: ["string", "null"], format: "date-time" },
            limits: {
              type: "object",
              properties: { monthly_quota: { type: "integer" }, per_minute: { type: "integer" } },
            },
            warning: { type: "string" },
          },
        },

        RotatedKey: {
          type: "object",
          properties: {
            api_key: { type: "string", description: "**Só aparece aqui.**" },
            key_id: { type: "string" },
            owner: { type: "string" },
            plan: { type: "string", enum: PLAN_IDS },
            rotated_at: { type: ["string", "null"], format: "date-time" },
            warning: { type: "string" },
          },
        },

        DynamicQrCreated: {
          type: "object",
          properties: {
            id: { type: "string" },
            short_url: { type: "string", format: "uri" },
            target_url: { type: "string", format: "uri" },
            image_data_url: { type: "string", description: "PNG em data URL." },
          },
        },

        DynamicQr: {
          type: "object",
          properties: {
            id: { type: "string" },
            short_url: { type: "string", format: "uri" },
            target_url: { type: "string", format: "uri" },
            scans: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: ["string", "null"], format: "date-time" },
          },
        },

        PixBrCode: {
          type: "object",
          properties: {
            br_code: { type: "string", description: "O copia e cola." },
            key_type: { type: ["string", "null"], enum: ["cpf", "cnpj", "phone", "email", "random", null] },
            image_data_url: { type: "string", description: "PNG em data URL." },
          },
        },

        PixDecoded: {
          type: "object",
          properties: {
            valid: { type: "boolean", description: "CRC confere e os campos obrigatórios estão presentes." },
            crc_valid: { type: "boolean" },
            kind: { type: "string", enum: ["static", "dynamic"] },
            reusable: { type: "boolean" },
            key: { type: ["string", "null"] },
            key_type: { type: ["string", "null"] },
            merchant_name: { type: ["string", "null"] },
            merchant_city: { type: ["string", "null"] },
            amount: { type: ["number", "null"] },
            txid: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            payload_url: { type: ["string", "null"], description: "Presente nos códigos dinâmicos." },
            currency: { type: ["string", "null"] },
            country: { type: ["string", "null"] },
          },
        },

        BoletoCobranca: {
          type: "object",
          description: "Boleto de cobrança bancária.",
          properties: {
            valid: { type: "boolean" },
            kind: { type: "string", enum: ["cobranca"] },
            barcode: { type: "string" },
            digitable_line: { type: "string" },
            amount: { type: ["number", "null"] },
            errors: { type: "array", items: { type: "string" } },
            bank_code: { type: "string" },
            bank_name: { type: ["string", "null"], description: "Tabela parcial: null quando o código não está nela." },
            currency_code: { type: "string" },
            due_factor: { type: "integer" },
            due_date: { type: ["string", "null"], format: "date" },
            due_date_current_cycle: { type: ["string", "null"], format: "date" },
            due_date_legacy_cycle: { type: ["string", "null"], format: "date" },
            due_date_ambiguous: {
              type: "boolean",
              description:
                "O fator de vencimento tem 4 dígitos, chegou a 9999 em 21/02/2025 e foi reiniciado em 1000. " +
                "Todo fator mapeia duas datas possíveis; `due_date` elege a mais próxima de hoje.",
            },
            free_field: { type: "string" },
          },
        },

        BoletoArrecadacao: {
          type: "object",
          description: "Boleto de arrecadação (água, luz, tributos).",
          properties: {
            valid: { type: "boolean" },
            kind: { type: "string", enum: ["arrecadacao"] },
            barcode: { type: "string" },
            digitable_line: { type: "string" },
            amount: { type: ["number", "null"] },
            errors: { type: "array", items: { type: "string" } },
            segment: { type: "string" },
            segment_name: { type: ["string", "null"] },
            value_kind: { type: "string", enum: ["efetivo", "referencia"] },
            checksum: { type: "string", enum: ["mod10", "mod11"] },
            company_id: { type: "string" },
            free_field: { type: "string" },
            due_date: { type: ["string", "null"], format: "date", description: "Só quando a empresa usa as 8 primeiras posições do campo livre como AAAAMMDD." },
          },
        },

        PaymentDecoded: {
          type: "object",
          description:
            "Envelope comum a todos os formatos. Os campos que só existem em um deles ficam em " +
            "`details`, com o formato nativo da rota específica.",
          properties: {
            kind: { type: "string", enum: ["pix", "boleto_cobranca", "boleto_arrecadacao"] },
            valid: { type: "boolean", description: "CRC do Pix ou dígitos verificadores do boleto conferem." },
            amount: { type: ["number", "null"], description: "Reais, ou null quando o código não fixa valor." },
            due_date: { type: ["string", "null"], format: "date", description: "Pix estático não carrega vencimento." },
            merchant_name: {
              type: ["string", "null"],
              description:
                "Só o Pix traz o nome de quem recebe. No boleto o beneficiário vive no campo livre, " +
                "que segue regras de cada banco — ali dá para saber o banco cobrador, em `details`.",
            },
            errors: { type: "array", items: { type: "string" } },
            details: {
              description: "A decodificação completa, no formato da rota específica.",
              oneOf: [
                { $ref: "#/components/schemas/PixDecoded" },
                { $ref: "#/components/schemas/BoletoCobranca" },
                { $ref: "#/components/schemas/BoletoArrecadacao" },
              ],
            },
          },
        },

        CpfResult: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            normalized: { type: ["string", "null"] },
            formatted: { type: ["string", "null"] },
          },
        },

        CnpjResult: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            kind: { type: ["string", "null"], enum: ["numeric", "alphanumeric", null] },
            normalized: { type: ["string", "null"] },
            formatted: { type: ["string", "null"] },
          },
        },

        Holiday: {
          type: "object",
          properties: {
            date: { type: "string", format: "date" },
            name: { type: "string" },
            type: { type: "string", enum: ["national", "optional"], description: "national = feriado federal; optional = ponto facultativo." },
          },
        },

        HolidaysResult: {
          type: "object",
          properties: {
            year: { type: "integer" },
            scope: { type: "string", enum: ["national"] },
            holidays: { type: "array", items: { $ref: "#/components/schemas/Holiday" } },
          },
        },

        BusinessDaysResult: {
          type: "object",
          properties: {
            from: { type: "string", format: "date" },
            to: { type: "string", format: "date" },
            total_days: { type: "integer" },
            business_days: { type: "integer" },
            holidays_excluded: { type: "array", items: { $ref: "#/components/schemas/Holiday" } },
          },
        },

        CheckoutRequest: {
          type: "object",
          required: ["plan", "customer"],
          properties: {
            plan: { type: "string", enum: ["pro", "scale"] },
            customer: {
              type: "object",
              required: ["name", "document", "email"],
              properties: {
                name: { type: "string", minLength: 3, maxLength: 100 },
                document: { type: "string", description: "CPF ou CNPJ do pagador, com ou sem pontuação." },
                email: { type: "string", format: "email", maxLength: 254 },
              },
            },
          },
        },

        CheckoutResult: {
          type: "object",
          properties: {
            subscription_id: { type: "string" },
            plan: { type: "string", enum: ["pro", "scale"] },
            price_brl: { type: "number" },
            payment_url: { type: ["string", "null"], format: "uri", description: "Link da fatura. Pode vir nulo se o provedor ainda não gerou a cobrança; nesse caso consulte `pending_payment_url` em GET /v1/billing." },
          },
        },

        BillingStatus: {
          type: "object",
          properties: {
            plan: { type: "string", enum: PLAN_IDS, description: "Plano em vigor agora." },
            contracted_plan: { type: "string", enum: PLAN_IDS, description: "Plano contratado. Difere de `plan` quando o período pago venceu." },
            plan_until: { type: ["string", "null"], format: "date-time" },
            subscription: {
              type: ["object", "null"],
              properties: {
                id: { type: "string" },
                plan: { type: "string", enum: ["pro", "scale"] },
                status: { type: "string", enum: ["active", "cancelled"] },
              },
            },
            pending_payment_url: { type: ["string", "null"], format: "uri" },
            usage: {
              type: "object",
              properties: {
                month: { type: "string", description: "AAAA-MM em UTC." },
                used: { type: "integer" },
                limit: { type: "integer" },
              },
            },
          },
        },

        ChangePlanResult: {
          type: "object",
          properties: {
            changed: { type: "boolean", description: "false quando a chave já estava no plano pedido." },
            plan: { type: "string", enum: ["pro", "scale"] },
            effective_plan: { type: "string", enum: PLAN_IDS, description: "Plano em vigor agora. Difere de `plan` no downgrade." },
            price_brl: { type: "number" },
            effective_from: { type: ["string", "null"], format: "date-time", description: "null significa que vale no próximo pagamento confirmado." },
          },
        },
      },
    },
  };
}
