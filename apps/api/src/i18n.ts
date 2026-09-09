import type { Locale } from '@minnegela/shared';

type MailCopy = {
  otpSubject: (otp: string) => string;
  otpText: (otp: string) => string;
  linkSubject: string;
  linkText: (url: string) => string;
};

/** The only prose the API writes for people: sign-in mails. Everything else is a code the apps translate. */
export const MAIL: Record<Locale, MailCopy> = {
  nb: {
    otpSubject: (otp) => `${otp} er innloggingskoden din til Minnegela`,
    otpText: (otp) => `Innloggingskoden din er ${otp}. Den utløper om 10 minutter.\n\nHvis du ikke ba om denne, kan du se bort fra denne e-posten.`,
    linkSubject: 'Logg inn på Minnegela',
    linkText: (url) => `Klikk for å logge inn:\n\n${url}\n\nLenken utløper om 15 minutter. Hvis du ikke ba om denne, kan du se bort fra denne e-posten.`,
  },
  en: {
    otpSubject: (otp) => `${otp} is your Minnegela sign-in code`,
    otpText: (otp) => `Your sign-in code is ${otp}. It expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
    linkSubject: 'Sign in to Minnegela',
    linkText: (url) => `Click to sign in:\n\n${url}\n\nThe link expires in 15 minutes. If you didn't request this, you can ignore this email.`,
  },
};
