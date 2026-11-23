import { privacyNotice } from "@/lib/privacy";

export function PrivacyNotice({
  venue,
  kind,
}: {
  venue: { name: string; legalName: string; email: string };
  kind: keyof typeof privacyNotice.data;
}) {
  return (
    <fieldset className="form-fieldset">
      <legend>Privacy notice</legend>
      <p className="fine">
        {venue.legalName || venue.name} is the data controller. Contact{" "}
        <a href={"mailto:" + venue.email}>{venue.email}</a>.
      </p>
      <p className="fine">
        {privacyNotice.purpose} {privacyNotice.basis}
      </p>
      <p className="fine">
        {privacyNotice.data[kind]} {privacyNotice.retention}
      </p>
      <p className="fine">{privacyNotice.recipients}</p>
      <p className="fine">
        {privacyNotice.rights}{" "}
        <a href="https://www.datatilsynet.dk/english">Datatilsynet</a>
      </p>
      <label className="check">
        <input type="checkbox" name="privacyAcknowledged" required /> I
        acknowledge that I have read the privacy notice.
      </label>
    </fieldset>
  );
}
