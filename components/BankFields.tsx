"use client";

import { useState } from "react";
import type { SensitiveDetails } from "./RevealSensitive";

export function BankFields({ masked }: { masked?: SensitiveDetails }) {
  const [method, setMethod] = useState(masked?.iban ? "iban" : "danish");
  const canKeep =
    method === "iban" ? Boolean(masked?.iban) : Boolean(masked?.account);
  return (
    <fieldset className="form-fieldset">
      <legend>Bank details</legend>
      {(masked?.iban || masked?.account) && (
        <p className="fine">
          Saved account · {masked.iban || masked.account}. Leave blank to keep
          it.
        </p>
      )}
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
            required={!canKeep}
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
              inputMode="numeric"
              pattern="[0-9]{4}"
              required={!canKeep}
              autoComplete="off"
            />
          </label>
          <label>
            Bank account number
            <input
              name="account"
              inputMode="numeric"
              pattern="[0-9]{6,10}"
              required={!canKeep}
              autoComplete="off"
            />
          </label>
        </div>
      )}
    </fieldset>
  );
}
