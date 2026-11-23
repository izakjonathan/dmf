import { z } from "zod";

export const privacyNoticeVersion = "2026-11-23";
export const privacyNotice = {
  purpose:
    "The venue uses your details to arrange the booking, administer the contract and process payments.",
  basis:
    "The venue processes the details needed to perform the contract. It collects CPR only where needed to meet tax reporting obligations.",
  data: {
    musician:
      "This includes your contact and identity details, booking and contract details, and payment information.",
    contact:
      "This includes your contact details, the act's lineup and schedule, and any promotional information you provide.",
  },
  retention:
    "The standard retention period for musician records is five years after the end of the income year of the last booking. Contact the venue for its current retention period and any legal exceptions.",
  recipients:
    "The venue may share the details needed for accounting and reporting with its accountant and the relevant public authorities. It uses Google and Vercel to operate Stagebook.",
  rights:
    "You can contact the venue to request access, rectification, erasure, restriction or portability, where applicable. You can also complain to the Danish Data Protection Agency.",
} as const;

const acknowledged = z.literal("on", {
  errorMap: () => ({ message: "Acknowledge the privacy notice to continue." }),
});

export type PrivacyAcknowledgement = {
  version: string;
  acknowledgedAt: string;
};

export function acknowledgePrivacy(value: unknown): PrivacyAcknowledgement {
  acknowledged.parse(value);
  return {
    version: privacyNoticeVersion,
    acknowledgedAt: new Date().toISOString(),
  };
}
