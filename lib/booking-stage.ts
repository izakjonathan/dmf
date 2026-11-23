type StageFacts = {
  cancelled: boolean;
  sourceError?: string;
  mailIssue?: string;
  invited: boolean;
  registered: number;
  expected: number;
  scheduled: boolean;
  fee: number;
  issued: boolean;
  signed: number;
  signatureTarget: number;
  legacyApproval: boolean;
  venueSigned: boolean;
  confirmed: boolean;
  canConfirm: boolean;
  paymentStates: string[];
};

export function deriveBookingStage(f: StageFacts) {
  if (f.cancelled) return { label: "Cancelled", action: "none" } as const;
  if (f.sourceError)
    return {
      label: "Needs attention",
      action: "details",
      reason: f.sourceError,
    } as const;
  const complete =
    f.venueSigned &&
    f.confirmed &&
    f.paymentStates.length > 0 &&
    f.paymentStates.every((s) => s === "Paid" || s === "Exception resolved");
  if (complete && !f.mailIssue)
    return { label: "Complete", action: "none" } as const;
  if (!f.scheduled || f.registered !== f.expected) {
    if (f.mailIssue)
      return {
        label: "Needs attention",
        action: "details",
        reason: f.mailIssue,
      } as const;
    return {
      label: f.invited ? "Waiting for registrations" : "Booked",
      action: "none",
    } as const;
  }
  if (!f.fee)
    return {
      label: "Needs attention",
      action: "details",
      reason: "Enter the agreed fee.",
    } as const;
  if (f.legacyApproval)
    return { label: "Ready to sign", action: "sign" } as const;
  if (!f.issued)
    return {
      label: "Needs attention",
      action: "issue",
      reason: "Signing requests need issuing.",
    } as const;
  if (f.signed < f.signatureTarget) {
    if (f.mailIssue)
      return {
        label: "Needs attention",
        action: "details",
        reason: f.mailIssue,
      } as const;
    return { label: "Waiting for signatures", action: "none" } as const;
  }
  if (!f.confirmed)
    return {
      label: f.canConfirm ? "Ready to confirm" : "Booked",
      action: f.canConfirm ? "confirm" : "none",
      reason: f.canConfirm
        ? undefined
        : "Performance is confirmed on or after the booking date.",
    } as const;
  if (!f.venueSigned && f.signatureTarget > 0)
    return { label: "Ready to sign", action: "sign" } as const;
  if (f.paymentStates.includes("Ready to pay"))
    return { label: "Ready to pay", action: "pay" } as const;
  if (f.mailIssue)
    return {
      label: "Needs attention",
      action: "details",
      reason: f.mailIssue,
    } as const;
  if (complete) return { label: "Complete", action: "none" } as const;
  return {
    label: "Needs attention",
    action: "details",
    reason:
      f.paymentStates.find(
        (s) => !["Paid", "Exception resolved"].includes(s),
      ) || "Review the performance exception.",
  } as const;
}
