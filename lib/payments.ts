import { decodeBoleto, type DecodedBoleto } from "./boleto.js";
import { parseBrCode, type DecodedBrCode } from "./pix.js";

/**
 * Decodificador único de código de pagamento.
 *
 * Existe para tirar uma decisão do integrador: o usuário cola o que recebeu — Pix copia e cola,
 * linha digitável ou código de barras — e quem integra manda como veio, sem precisar descobrir
 * antes qual rota chamar.
 *
 * Não reimplementa nada: compõe `lib/pix.ts` e `lib/boleto.ts`. Qualquer regra nova de formato
 * entra lá e aparece aqui de graça.
 */

/** Linha digitável com pontuação não passa muito de 60; o teto recusa lixo de entrada. */
const MAX_INPUT = 1024;

export type PaymentKind = "pix" | "boleto_cobranca" | "boleto_arrecadacao";

export interface DecodedPayment {
  kind: PaymentKind;
  /** Estrutura íntegra: CRC do Pix ou dígitos verificadores do boleto conferem. */
  valid: boolean;
  /** Valor em reais, ou null quando o código não fixa valor (o pagador escolhe). */
  amount: number | null;
  /** AAAA-MM-DD, ou null. Pix estático não carrega vencimento. */
  due_date: string | null;
  /**
   * Nome de quem recebe, quando o próprio código informa.
   *
   * Só o Pix traz. No boleto, o beneficiário vive no campo livre, que segue regras de cada
   * banco — o que dá para saber ali é o banco cobrador, e ele está em `details`.
   */
  merchant_name: string | null;
  /** Motivos de `valid: false`. Vazio quando o código confere. */
  errors: string[];
  /** A decodificação completa do formato detectado, como as rotas específicas devolvem. */
  details: DecodedBrCode | DecodedBoleto;
}

function fromPix(pix: DecodedBrCode): DecodedPayment {
  return {
    kind: "pix",
    valid: pix.valid,
    amount: pix.amount,
    // Pix estático não tem vencimento; o dinâmico tem, mas atrás da URL do PSP.
    due_date: null,
    merchant_name: pix.merchant_name,
    errors: pix.crc_valid ? [] : ["invalid_crc"],
    details: pix,
  };
}

function fromBoleto(boleto: DecodedBoleto): DecodedPayment {
  return {
    kind: boleto.kind === "cobranca" ? "boleto_cobranca" : "boleto_arrecadacao",
    valid: boleto.valid,
    amount: boleto.amount,
    due_date: boleto.due_date,
    merchant_name: null,
    errors: boleto.errors,
    details: boleto,
  };
}

/**
 * Identifica o formato e decodifica.
 *
 * A separação é determinística pelas letras: o GUI `br.gov.bcb.pix` é obrigatório no BR Code,
 * então todo Pix tem letras; linha digitável e código de barras são só dígitos e pontuação.
 *
 * Um Pix **inteiro** nunca seria confundido — tem no mínimo 75 dígitos, acima dos 44/47/48 do
 * boleto. O corte existe pelo Pix **pela metade**: colado até certo ponto, ele cai justamente
 * em 44 dígitos e o decodificador de boleto o aceitaria como cobrança malformada, mandando o
 * usuário conferir dígito verificador num código que nem é boleto.
 *
 * Devolve null só quando o conteúdo não é reconhecível por nenhum dos dois. Formato
 * reconhecido mas com verificação falhando volta com `valid: false` e os campos que deram para
 * ler — quem está conferindo um código digitado errado precisa ver onde está o problema.
 */
export function decodePayment(input: string, now = new Date()): DecodedPayment | null {
  // Não normaliza espaço em volta de propósito: `parseBrCode` já apara e `decodeBoleto`
  // descarta tudo que não é dígito. O teto de tamanho fica porque esta função é pública e
  // uma entrada enorme custaria varredura à toa — não por comportamento, já que código
  // válido nunca chega perto disso.
  if (!input || input.length > MAX_INPUT) return null;

  if (/[A-Za-z]/.test(input)) {
    const pix = parseBrCode(input);
    return pix ? fromPix(pix) : null;
  }

  // Só dígitos e pontuação: boleto é o candidato natural. O Pix fica como segunda tentativa
  // para um payload que, de tão truncado, perdeu até as letras.
  const boleto = decodeBoleto(input, now);
  if (boleto) return fromBoleto(boleto);

  const pix = parseBrCode(input);
  return pix ? fromPix(pix) : null;
}
