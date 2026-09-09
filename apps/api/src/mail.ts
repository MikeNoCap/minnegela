import { createTransport } from 'nodemailer';
import type { Config } from './config.js';
import type { Logger } from 'pino';

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** Console transport logs the full body (dev; links/codes are fished out of the logs). SMTP sends via SMTP_URL, e.g. smtps://resend:<key>@smtp.resend.com:465. */
export function createMailer(cfg: Config, log: Logger): Mailer {
  if (cfg.MAIL_TRANSPORT === 'console') {
    return {
      async send(msg) {
        log.info({ to: msg.to, subject: msg.subject, body: msg.text }, 'mail (console transport)');
      },
    };
  }
  const transport = createTransport(cfg.SMTP_URL);
  return {
    async send(msg) {
      await transport.sendMail({ from: cfg.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
      log.info({ to: msg.to, subject: msg.subject }, 'mail sent');
    },
  };
}
