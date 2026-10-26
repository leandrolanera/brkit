import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cobrancaBarcodeToLine, mod11Cobranca } from "../lib/boleto.js";
import { buildAccessKey, parseAccessKey } from "../lib/nfe.js";
import { buildBrCode, parseBrCode } from "../lib/pix.js";

/**
 * Confere uma instalação de verdade.
 *
 * Existe porque toda a suíte roda contra duplos escritos aqui dentro — o que prova coerência
 * interna, não conformidade. Este script é o contrário: fala com o serviço no ar e compara o
 * que ele devolve com o que as mesmas funções da lib calculam localmente.
 *
 *   npm run verify -- --url https://SEU-DOMINIO
 *   npm run verify -- --url https://SEU-DOMINIO --key ak_live_... --checkout
 *
 * Por padrão só faz leitura. O que tem efeito colateral é opcional e explícito:
 * `--signup` dispara e-mail de verdade, `--checkout` cria assinatura no Asaas.
 *
 * Segredos saem de `.env.local` ou do ambiente, e nunca são impressos.
 */

// ---------------------------------------------------------------------------
// Argumentos e ambiente

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    key: { type: "string" },
    /** Dispara e-mail de verdade para este endereço. */
    signup: { type: "string" },
    /** Código recebido por e-mail, para concluir o cadastro. */
    code: { type: "string" },
    /** Cria assinatura no Asaas. Use só no sandbox. */
    checkout: { type: "boolean", default: false },
    /** CPF ou CNPJ do pagador, exigido pelo Asaas no checkout. */
    document: { type: "string" },
    /** Linha digitável de um boleto que você recebeu de verdade. */
    boleto: { type: "string" },
    /** Chave de acesso de uma NF-e de verdade. */
    nfe: { type: "string" },
    /** Sua chave Pix, para gerar um QR de R$ 0,01 para escanear. */
    pix: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Confere uma instalação no ar.

  --url <url>         Obrigatório. Ex.: https://apis.exemplo.com.br
  --key <chave>       Chave de API. Sem ela, só as rotas públicas são conferidas.
  --boleto <linha>    Linha digitável de um boleto real, para conferir o vencimento.
  --nfe <chave>       Chave de acesso real, para conferir os campos.
  --pix <chave-pix>   Gera um QR de R$ 0,01 com a sua chave, para escanear no banco.

  --signup <e-mail>   ENVIA e-mail de verdade. Depois rode de novo com --code.
  --code <código>     Conclui o cadastro e devolve a chave.
  --checkout          CRIA assinatura no Asaas. Use só no sandbox.
  --document <doc>    CPF/CNPJ do pagador, junto com --checkout.

Segredos saem de .env.local ou do ambiente e nunca são impressos.
`);
  process.exit(0);
}

/** Lê .env.local sem dependência, só o suficiente para o que este script usa. */
function loadEnvLocal(): void {
  let content: string;
  try {
    content = readFileSync(".env.local", "utf8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    const [, name, raw] = match;
    if (process.env[name!] !== undefined) continue;
    process.env[name!] = raw!.trim().replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

const BASE = (values.url ?? process.env.VERIFY_URL ?? "").replace(/\/$/, "");
const KEY = values.key ?? process.env.VERIFY_KEY ?? process.env.API_KEY;

if (!BASE) {
  console.error("Informe a instalação: --url https://SEU-DOMINIO (ou VERIFY_URL no ambiente).");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Relatório

type Status = "ok" | "falha" | "pulado";
interface Result {
  group: string;
  name: string;
  status: Status;
  detail: string;
  /** O que fazer quando falha. Erro sem direção não ajuda ninguém. */
  fix?: string;
}

const results: Result[] = [];
let currentGroup = "";

const group = (name: string) => {
  currentGroup = name;
  console.log(`\n${name}`);
};

function record(name: string, status: Status, detail: string, fix?: string) {
  results.push({ group: currentGroup, name, status, detail, fix });
  const mark = status === "ok" ? "[32m✓[0m" : status === "falha" ? "[31m✗[0m" : "[90m–[0m";
  console.log(`  ${mark} ${name}${detail ? `  [90m${detail}[0m` : ""}`);
  if (status === "falha" && fix) console.log(`      [33m→ ${fix}[0m`);
}

/**
 * Executa uma conferência. A função devolve o detalhe a exibir, ou lança para falhar —
 * assim cada checagem fica legível como uma frase.
 */
async function check(name: string, run: () => Promise<string>, fix?: string): Promise<boolean> {
  try {
    record(name, "ok", await run());
    return true;
  } catch (err) {
    record(name, "falha", err instanceof Error ? err.message : String(err), fix);
    return false;
  }
}

const skip = (name: string, why: string) => record(name, "pulado", why);

// ---------------------------------------------------------------------------
// HTTP

interface Res {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

async function call(path: string, init: RequestInit = {}, withKey = true): Promise<Res> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (withKey && KEY) headers.set("x-api-key", KEY);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // resposta não-JSON (HTML da landing, texto do redirect)
  }
  return { status: res.status, headers: res.headers, body, text };
}

const post = (path: string, payload: unknown, withKey = true) =>
  call(path, { method: "POST", body: JSON.stringify(payload) }, withKey);

/** Lê um caminho aninhado do corpo da resposta, para as asserções ficarem curtas. */
const at = (body: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], body);

function expect(res: Res, status: number, what: string): void {
  if (res.status !== status) {
    const code = at(res.body, "error.code");
    throw new Error(`${what}: esperava ${status}, veio ${res.status}${code ? ` (${code})` : ""}`);
  }
}

const errorCode = (res: Res) => String(at(res.body, "error.code") ?? "");

// ---------------------------------------------------------------------------
// Dados conhecidos, calculados pelas mesmas funções que a API usa.
// Se a API no ar divergir disto, a divergência é dela.

const PIX_LOCAL = buildBrCode({
  key: "contato@exemplo.com.br",
  name: "Livraria Sao Jorge",
  city: "Sao Paulo",
  amount: 89.9,
  txid: "PEDIDO4471",
});

const BOLETO_LOCAL = (() => {
  const livre = "0000000012345678901234567".slice(0, 25);
  const semDv = `0019X16360000124790${livre}`;
  const dv = mod11Cobranca(semDv.slice(0, 4) + semDv.slice(5));
  const barcode = `0019${dv}16360000124790${livre}`;
  return { barcode, line: cobrancaBarcodeToLine(barcode) };
})();

const NFE_LOCAL = buildAccessKey({
  uf: "SP",
  issued: "2026-06",
  cnpj: "11222333000181",
  model: "55",
  series: 1,
  number: 1,
  emissionType: 1,
  randomCode: "00000001",
});

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nConferindo ${BASE}`);
  console.log(KEY ? "Com chave de API." : "[33mSem chave: só as rotas públicas.[0m");

  // --- infraestrutura ------------------------------------------------------
  group("Infraestrutura");

  await check(
    "a landing é servida em /",
    async () => {
      const res = await call("/", {}, false);
      expect(res, 200, "GET /");
      if (!/text\/html/.test(res.headers.get("content-type") ?? "")) {
        throw new Error(`content-type inesperado: ${res.headers.get("content-type")}`);
      }
      if (!res.text.includes("<h1")) throw new Error("respondeu HTML, mas sem o conteúdo da página");
      return `${res.text.length} bytes de HTML`;
    },
    "O index.html da raiz não está sendo servido. Mova-o para public/ ou use outputDirectory no vercel.json.",
  );

  await check("o serviço responde", async () => {
    const res = await call("/v1/health", {}, false);
    expect(res, 200, "GET /v1/health");
    if (at(res.body, "status") !== "ok") throw new Error("status diferente de ok");
    return String(at(res.body, "time") ?? "");
  });

  await check("a especificação OpenAPI está publicada", async () => {
    const res = await call("/v1/openapi.json", {}, false);
    expect(res, 200, "GET /v1/openapi.json");
    const paths = Object.keys((at(res.body, "paths") as object) ?? {});
    if (paths.length < 15) throw new Error(`só ${paths.length} caminhos documentados`);
    return `${at(res.body, "openapi")} com ${paths.length} caminhos`;
  }, "Confira a reescrita de /v1/openapi.json no vercel.json — ela precisa vir antes da regra genérica.");

  // --- cadastro ------------------------------------------------------------
  group("Cadastro de chaves");

  let signupAvailable = false;
  await check("o cadastro recusa e-mail inválido", async () => {
    const res = await post("/v1/signup", { email: "sem-arroba" }, false);
    if (res.status === 503) throw new Error("cadastro indisponível (503)");
    expect(res, 400, "POST /v1/signup");
    return errorCode(res);
  }, "RESEND_API_KEY e EMAIL_FROM não estão configuradas na Vercel, ou falta redeploy.");

  {
    const res = await post("/v1/signup", { email: "sem-arroba" }, false);
    signupAvailable = res.status !== 503;
  }

  if (values.signup && values.code) {
    await check("o código confirma e a chave é emitida", async () => {
      const res = await post("/v1/signup/verify", { email: values.signup, code: values.code }, false);
      expect(res, 201, "POST /v1/signup/verify");
      const key = String(at(res.body, "api_key") ?? "");
      if (!key.startsWith("ak_live_")) throw new Error("resposta sem api_key");
      console.log(`\n      [1mSUA CHAVE: ${key}[0m`);
      console.log("      [90mGuarde agora: ela não é exibida de novo.[0m");
      return `plano ${at(res.body, "plan")}`;
    });
  } else if (values.signup) {
    await check("o pedido de código é aceito", async () => {
      const res = await post("/v1/signup", { email: values.signup }, false);
      expect(res, 202, "POST /v1/signup");
      return "e-mail enviado";
    }, "Confira o domínio verificado no Resend.");
    console.log(`\n      [33mVeja a caixa de ${values.signup} e rode de novo com:[0m`);
    console.log(`      npm run verify -- --url ${BASE} --signup ${values.signup} --code OCODIGO`);
  } else if (signupAvailable) {
    skip("envio de e-mail de verdade", "use --signup SEU-EMAIL (envia mesmo)");
  }

  // --- rotas que exigem chave ---------------------------------------------
  if (!KEY) {
    group("APIs de produto");
    skip("todas", "informe --key ak_live_...");
    return report();
  }

  group("Plataforma");

  await check("a chave autentica e a medição aparece", async () => {
    const res = await call("/v1/holidays?year=2026");
    expect(res, 200, "GET /v1/holidays");
    const limit = res.headers.get("x-usage-limit");
    const left = res.headers.get("x-usage-remaining");
    if (!limit || !left) throw new Error("faltam os cabeçalhos x-usage-*");
    return `cota ${left}/${limit}, limite ${res.headers.get("x-ratelimit-limit")}/min`;
  }, "Chave inválida ou expirada. Gere outra com --signup.");

  await check("chave inválida é recusada", async () => {
    const res = await call("/v1/holidays", { headers: { "x-api-key": "ak_live_naoexiste" } }, false);
    expect(res, 401, "chave inválida");
    return errorCode(res);
  });

  // --- Pix -----------------------------------------------------------------
  group("Pix");

  await check("o BR Code gerado no ar bate com o calculado aqui", async () => {
    const res = await post("/v1/pix/qr", {
      key: "contato@exemplo.com.br",
      name: "Livraria Sao Jorge",
      city: "Sao Paulo",
      amount: 89.9,
      txid: "PEDIDO4471",
    });
    expect(res, 201, "POST /v1/pix/qr");
    const remoto = String(at(res.body, "br_code") ?? "");
    if (remoto !== PIX_LOCAL) throw new Error("o BR Code do servidor diverge do local");
    if (!String(at(res.body, "image_data_url") ?? "").startsWith("data:image/png;base64,")) {
      throw new Error("a imagem não veio em PNG");
    }
    return `${remoto.length} caracteres, CRC ${remoto.slice(-4)}`;
  });

  await check("o decodificador confere o CRC", async () => {
    const res = await post("/v1/pix/decode", { br_code: PIX_LOCAL });
    expect(res, 200, "POST /v1/pix/decode");
    if (at(res.body, "valid") !== true) throw new Error("código válido foi recusado");
    const local = parseBrCode(PIX_LOCAL);
    if (at(res.body, "amount") !== local?.amount) throw new Error("valor divergente");
    return `R$ ${at(res.body, "amount")}, txid ${at(res.body, "txid")}`;
  });

  await check("CRC adulterado é detectado", async () => {
    const res = await post("/v1/pix/decode", { br_code: `${PIX_LOCAL.slice(0, -4)}0000` });
    expect(res, 200, "POST /v1/pix/decode");
    if (at(res.body, "valid") !== false) throw new Error("aceitou um CRC errado");
    return "valid: false, como esperado";
  });

  if (values.pix) {
    await check("QR de R$ 0,01 com a sua chave", async () => {
      const res = await post("/v1/pix/qr", {
        key: values.pix,
        name: "Teste",
        city: "Sao Paulo",
        amount: 0.01,
        txid: "TESTE001",
      });
      expect(res, 201, "POST /v1/pix/qr");
      console.log(`\n      [1mCopia e cola:[0m ${at(res.body, "br_code")}`);
      console.log("      [90mCole o image_data_url abaixo na barra do navegador e escaneie:[0m");
      console.log(`      ${String(at(res.body, "image_data_url")).slice(0, 80)}…`);
      return "gerado — falta escanear no app do banco";
    });
  } else {
    skip("QR com a sua chave Pix", "use --pix SUA-CHAVE para gerar um de R$ 0,01");
  }

  // --- Boleto --------------------------------------------------------------
  group("Boleto");

  await check("a linha digitável conhecida é aceita", async () => {
    const res = await post("/v1/boleto/decode", { code: BOLETO_LOCAL.line });
    expect(res, 200, "POST /v1/boleto/decode");
    if (at(res.body, "valid") !== true) throw new Error(`recusou: ${JSON.stringify(at(res.body, "errors"))}`);
    if (at(res.body, "barcode") !== BOLETO_LOCAL.barcode) throw new Error("conversão para código de barras divergente");
    return `${at(res.body, "bank_name")}, R$ ${at(res.body, "amount")}, vence ${at(res.body, "due_date")}`;
  });

  if (values.boleto) {
    await check("o seu boleto de verdade", async () => {
      const res = await post("/v1/boleto/decode", { code: values.boleto });
      expect(res, 200, "POST /v1/boleto/decode");
      const kind = at(res.body, "kind");
      const valid = at(res.body, "valid");
      console.log(`\n      [1mCONFIRA CONTRA O PAPEL:[0m`);
      console.log(`      tipo: ${kind} | valor: R$ ${at(res.body, "amount")} | vencimento: ${at(res.body, "due_date")}`);
      if (kind === "cobranca") {
        console.log(`      banco: ${at(res.body, "bank_name") ?? at(res.body, "bank_code")}`);
        console.log(`      [90mfator ${at(res.body, "due_factor")} — ciclo atual ${at(res.body, "due_date_current_cycle")}, antigo ${at(res.body, "due_date_legacy_cycle")}[0m`);
      }
      if (!valid) throw new Error(`dígitos não conferem: ${JSON.stringify(at(res.body, "errors"))}`);
      return "estrutura íntegra — confira os valores acima";
    }, "Se os dígitos não conferem, confira se copiou a linha inteira. Se conferiu e ainda falha, me mande a linha.");
  } else {
    skip("um boleto de verdade", "use --boleto 'LINHA DIGITÁVEL'");
  }

  // --- NF-e ----------------------------------------------------------------
  group("Documento fiscal");

  await check("a chave conhecida é lida corretamente", async () => {
    const res = await post("/v1/nfe/decode", { key: NFE_LOCAL });
    expect(res, 200, "POST /v1/nfe/decode");
    const local = parseAccessKey(NFE_LOCAL);
    if (at(res.body, "valid") !== true) throw new Error(`recusou: ${JSON.stringify(at(res.body, "errors"))}`);
    if (at(res.body, "uf") !== local?.uf) throw new Error("UF divergente");
    return `${at(res.body, "model_name")} de ${at(res.body, "uf")}, emissão ${at(res.body, "issued")}`;
  });

  await check("a chave é montada a partir dos campos", async () => {
    const res = await post("/v1/nfe/key", {
      uf: "SP",
      issued: "2026-06",
      cnpj: "11.222.333/0001-81",
      model: "55",
      series: 1,
      number: 1,
      randomCode: "00000001",
    });
    expect(res, 201, "POST /v1/nfe/key");
    if (at(res.body, "key") !== NFE_LOCAL) throw new Error("a chave montada diverge da local");
    return String(at(res.body, "key"));
  });

  if (values.nfe) {
    await check("a sua chave de verdade", async () => {
      const res = await post("/v1/nfe/decode", { key: values.nfe });
      expect(res, 200, "POST /v1/nfe/decode");
      console.log(`\n      [1mCONFIRA CONTRA A NOTA:[0m`);
      console.log(`      UF: ${at(res.body, "uf")} | emissão: ${at(res.body, "issued")} | modelo: ${at(res.body, "model_name")}`);
      console.log(`      CNPJ: ${at(res.body, "cnpj")} (${at(res.body, "cnpj_kind")}) | nº ${at(res.body, "number")} série ${at(res.body, "series")}`);
      if (at(res.body, "valid") !== true) throw new Error(`dígitos não conferem: ${JSON.stringify(at(res.body, "errors"))}`);
      return "estrutura íntegra — confira os campos acima";
    }, "Se falhar, me mande a chave e o que a nota diz.");
  } else {
    skip("uma chave de NF-e de verdade", "use --nfe 'OS 44 DÍGITOS'");
  }

  // --- decodificador universal --------------------------------------------
  group("Decodificador universal");

  for (const [rotulo, code, esperado] of [
    ["Pix", PIX_LOCAL, "pix"],
    ["boleto", BOLETO_LOCAL.line, "boleto_cobranca"],
  ] as const) {
    await check(`reconhece ${rotulo} sem saber o formato antes`, async () => {
      const res = await post("/v1/payments/decode", { code });
      expect(res, 200, "POST /v1/payments/decode");
      if (at(res.body, "kind") !== esperado) throw new Error(`identificou como ${at(res.body, "kind")}`);
      if (at(res.body, "valid") !== true) throw new Error("recusou código válido");
      return String(at(res.body, "kind"));
    });
  }

  // --- validadores ---------------------------------------------------------
  group("Documentos e datas");

  await check("CPF válido é aceito", async () => {
    const res = await post("/v1/validate/cpf", { value: "529.982.247-25" });
    expect(res, 200, "POST /v1/validate/cpf");
    if (at(res.body, "valid") !== true) throw new Error("recusou CPF válido");
    return String(at(res.body, "formatted"));
  });

  await check("CNPJ alfanumérico é aceito", async () => {
    const res = await call(`/v1/validate/cnpj?value=${encodeURIComponent("12.ABC.345/01DE-35")}`);
    expect(res, 200, "GET /v1/validate/cnpj");
    if (at(res.body, "valid") !== true) throw new Error("recusou o exemplo oficial da Receita");
    return `${at(res.body, "kind")}, ${at(res.body, "formatted")}`;
  });

  await check("dias úteis são contados", async () => {
    const res = await call("/v1/holidays/business-days?from=2026-11-01&to=2026-11-30");
    expect(res, 200, "GET /v1/holidays/business-days");
    return `${at(res.body, "business_days")} dias úteis em novembro`;
  });

  // --- cobrança ------------------------------------------------------------
  group("Cobrança");

  await check("a situação da cobrança é consultável", async () => {
    const res = await call("/v1/billing");
    expect(res, 200, "GET /v1/billing");
    const plano = at(res.body, "plan");
    const assinatura = at(res.body, "subscription");
    return `plano ${plano}, assinatura ${assinatura ? "ativa" : "nenhuma"}`;
  });

  if (values.checkout) {
    if (!values.document) {
      record("checkout", "falha", "falta --document", "Informe o CPF/CNPJ do pagador: --document 529.982.247-25");
    } else {
      await check("o checkout cria a assinatura", async () => {
        const res = await post("/v1/billing/checkout", {
          plan: "pro",
          customer: { name: "Teste Verificacao", document: values.document, email: "teste@exemplo.com.br" },
        });
        if (res.status === 503) throw new Error("cobrança indisponível (503)");
        if (res.status === 409) return `já existe assinatura (${errorCode(res)})`;
        expect(res, 201, "POST /v1/billing/checkout");

        const url = at(res.body, "payment_url");
        console.log(`\n      [1mPENDÊNCIA A — o link da fatura veio ${url ? "PREENCHIDO" : "NULO"}[0m`);
        if (url) {
          console.log(`      ${url}`);
        } else {
          const status = await call("/v1/billing");
          console.log(`      pending_payment_url: ${at(status.body, "pending_payment_url") ?? "também nulo"}`);
        }
        console.log("      [33mPague no link e rode de novo para ver se o plano subiu.[0m");
        return `assinatura ${at(res.body, "subscription_id")}, R$ ${at(res.body, "price_brl")}`;
      }, "ASAAS_API_KEY não configurada, ou falta redeploy.");
    }
  } else {
    skip("criar assinatura no Asaas", "use --checkout --document SEU-CPF (cria de verdade, no sandbox)");
  }

  report();
}

function report() {
  const ok = results.filter((r) => r.status === "ok").length;
  const falhas = results.filter((r) => r.status === "falha");
  const pulados = results.filter((r) => r.status === "pulado").length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${ok} conferidos, ${falhas.length} falharam, ${pulados} pulados`);

  if (falhas.length > 0) {
    console.log("\nFalhas:");
    for (const f of falhas) console.log(`  [31m✗[0m ${f.group} › ${f.name}: ${f.detail}`);
    console.log("\nMande esta saída para eu corrigir e cobrir com teste.");
  }

  process.exit(falhas.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n[31mNão foi possível conferir ${BASE}[0m`);
  console.error(err instanceof Error ? err.message : err);
  console.error("\nConfira se a URL está certa e se o deploy terminou.");
  process.exit(2);
});
