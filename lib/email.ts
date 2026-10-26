/**
 * Envio de e-mail transacional pelo Resend, sem dependências.
 * Referência: https://resend.com/docs/api-reference/emails/send-email — `POST /emails` com
 * `Authorization: Bearer`, campos `from`, `to` e `subject` obrigatórios.
 */

const RESEND_URL = "https://api.resend.com/emails";

export interface EmailConfig {
  apiKey: string;
  /** Remetente, no formato "Nome <conta@dominio>" ou só o endereço. O domínio precisa estar verificado no Resend. */
  from: string;
  fetchImpl?: typeof fetch;
}

export class EmailError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`email_http_${status}`);
    this.name = "EmailError";
  }
}

/** Sem RESEND_API_KEY ou EMAIL_FROM o envio fica desligado, e o cadastro público responde 503. */
export function emailConfigFromEnv(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  return apiKey && from ? { apiKey, from } : null;
}

export interface Message {
  to: string;
  subject: string;
  text: string;
}

export function createEmailSender(config: EmailConfig) {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async send(message: Message): Promise<{ id: string | null }> {
      const res = await doFetch(RESEND_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          from: config.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      });

      const body = await res.text();
      if (!res.ok) {
        // O Resend responde { name, message, statusCode }. A mensagem vai para o log, nunca
        // para o cliente: pode conter detalhe de configuração da conta.
        let detail = body.slice(0, 200);
        try {
          const parsed = JSON.parse(body) as { message?: unknown };
          if (typeof parsed.message === "string") detail = parsed.message;
        } catch {
          // mantém o corpo cru
        }
        throw new EmailError(res.status, detail);
      }

      try {
        const parsed = JSON.parse(body) as { id?: unknown };
        return { id: typeof parsed.id === "string" ? parsed.id : null };
      } catch {
        return { id: null };
      }
    },
  };
}

export type EmailSender = ReturnType<typeof createEmailSender>;

export function getEmailSender(): EmailSender | null {
  const config = emailConfigFromEnv();
  return config ? createEmailSender(config) : null;
}
