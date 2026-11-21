"use client";

type Attendance = "played" | "absent" | "issue";
export type AttendanceInput = {
  by: string;
  note: string;
  members: { id: string; status: FormDataEntryValue | null }[];
};
type Act = {
  expectedMembers: number;
  members: {
    id: string;
    name: string;
    attendance?: Attendance;
    attendanceLocked?: boolean;
    paymentId?: string;
  }[];
  attendanceNote?: string;
  confirmedAt?: string;
};

export function AttendanceEditor({
  booking,
  busy,
  by,
  onSave,
}: {
  booking: Act;
  busy: boolean;
  by: string;
  onSave: (data: AttendanceInput) => void;
}) {
  const incomplete = booking.members.length !== booking.expectedMembers;
  return (
    <details className="booking-form">
      <summary>
        {booking.confirmedAt
          ? "Update attendance"
          : "Record attendance or exceptions"}
      </summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          onSave({
            by,
            note: String(fields.get("note") || ""),
            members: booking.members.map((member) => ({
              id: member.id,
              status:
                member.attendanceLocked || member.paymentId
                  ? member.attendance || null
                  : fields.get(member.id),
            })),
          });
        }}
      >
        {booking.members.map((member) => (
          <label key={member.id}>
            {member.name}
            <select
              name={member.id}
              defaultValue={member.attendance || ""}
              disabled={Boolean(member.attendanceLocked || member.paymentId)}
              required
            >
              <option value="" disabled>
                Choose attendance
              </option>
              <option value="played">Played as agreed</option>
              <option value="absent">Absent</option>
              <option value="issue">Performance issue</option>
            </select>
          </label>
        ))}
        <label>
          {incomplete
            ? "Who performed without registering? Include any exceptions."
            : "Note any exceptions"}
          <textarea
            name="note"
            required={incomplete}
            maxLength={2000}
            rows={2}
            defaultValue={booking.attendanceNote}
          />
        </label>
        <button disabled={busy || by.trim().length < 2}>Save attendance</button>
      </form>
    </details>
  );
}
