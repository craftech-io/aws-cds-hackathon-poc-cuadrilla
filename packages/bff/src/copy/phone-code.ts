// The SMS that carries the account's code (ADR-0029, phone/sms.ts), in the language of the screen that
// asked for it. Neutral product text (ADR-0023): the product's name, the code and its life, nothing else;
// no link, no world data, nothing the visitor typed.
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";

export const SMS_PRODUCT_NAME = "Cuadrilla";

export function phoneCodeSms(locale: LegalLocale, code: string, minutes: number): string {
  return locale === "en" ? `Your ${SMS_PRODUCT_NAME} code is ${code}. It expires in ${minutes} minutes.` : `Tu código de ${SMS_PRODUCT_NAME} es ${code}. Vence en ${minutes} minutos.`;
}
