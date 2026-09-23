import nodemailer from 'nodemailer';

/**
 * Envoi d'e-mails (liens de réinitialisation de mot de passe).
 *
 * Facultatif : sans `SUIVIINVEST_SMTP_URL`, aucun e-mail n'est envoyé et
 * l'interface ne propose que le code de récupération. On n'invente pas de
 * fonction qui ne marche pas.
 *
 * Aucun mot de passe SMTP n'est journalisé : l'URL de connexion est lue une
 * fois, au démarrage, et n'apparaît jamais dans un log ni dans une réponse.
 */

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface Mailer {
  readonly configured: boolean;
  send(message: MailMessage): Promise<void>;
}

/** Aucun envoi possible : le parcours par e-mail est simplement masqué. */
export class DisabledMailer implements Mailer {
  readonly configured = false;

  async send(): Promise<void> {
    throw new Error("L'envoi d'e-mails n'est pas configuré sur ce serveur.");
  }
}

/** Boîte d'envoi en mémoire, pour les tests : rien ne part sur le réseau. */
export class MemoryMailer implements Mailer {
  readonly configured = true;
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
  }
}

export class SmtpMailer implements Mailer {
  readonly configured = true;
  readonly #transport: nodemailer.Transporter;
  readonly #from: string;

  constructor(smtpUrl: string, from: string) {
    this.#transport = nodemailer.createTransport(smtpUrl);
    this.#from = from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    });
  }
}

export function createMailer(options: { smtpUrl: string | null; from: string | null }): Mailer {
  if (!options.smtpUrl) return new DisabledMailer();
  return new SmtpMailer(options.smtpUrl, options.from ?? 'SuiviInvest <no-reply@localhost>');
}

/** Contenu de l'e-mail de réinitialisation (texte + HTML sobre). */
export function passwordResetEmail(input: {
  readonly to: string;
  readonly link: string;
  readonly name: string;
  readonly validMinutes: number;
}): MailMessage {
  const text = [
    `Bonjour ${input.name},`,
    '',
    'Une réinitialisation du mot de passe de votre compte SuiviInvest a été demandée.',
    `Pour choisir un nouveau mot de passe, ouvrez ce lien (valable ${input.validMinutes} minutes, une seule fois) :`,
    '',
    input.link,
    '',
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.",
    '',
    '— SuiviInvest',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:20px;padding:32px">
<p style="margin:0 0 24px;font-weight:700;font-size:18px">SuiviInvest</p>
<p style="margin:0 0 12px;font-size:15px">Bonjour ${escapeHtml(input.name)},</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5">Une réinitialisation du mot de passe de votre compte a été demandée. Le lien est valable ${input.validMinutes} minutes et ne fonctionne qu'une fois.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#0a0a0a;color:#fff;text-decoration:none;font-weight:600">Choisir un nouveau mot de passe</a></p>
<p style="margin:0;font-size:13px;color:#666;line-height:1.5">Vous n'êtes pas à l'origine de cette demande&nbsp;? Ignorez ce message&nbsp;: votre mot de passe actuel reste valable.</p>
</div></body></html>`;
  return { to: input.to, subject: 'Réinitialisation de votre mot de passe', text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
