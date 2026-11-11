"use client";

import { useState } from "react";
import type { Musician } from "@/lib/model";

export function BankFields({
  profile,
}: {
  profile?: Pick<Musician, "registration" | "account" | "iban">;
}) {
  const [method, setMethod] = useState(profile?.iban ? "iban" : "danish");
  return (
    <fieldset className="form-fieldset">
      <legend>Bank details</legend>
      <label>
        Account format
        <select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
        >
          <option value="danish">Danish registration and account number</option>
          <option value="iban">IBAN</option>
        </select>
      </label>
      {method === "iban" ? (
        <label>
          IBAN
          <input
            name="iban"
            defaultValue={profile?.iban}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
          />
        </label>
      ) : (
        <div className="grid">
          <label>
            Bank registration number
            <input
              name="registration"
              defaultValue={profile?.registration}
              inputMode="numeric"
              pattern="[0-9]{4}"
              required
              autoComplete="off"
            />
          </label>
          <label>
            Bank account number
            <input
              name="account"
              defaultValue={profile?.account}
              inputMode="numeric"
              pattern="[0-9]{6,10}"
              required
              autoComplete="off"
            />
          </label>
        </div>
      )}
    </fieldset>
  );
}
