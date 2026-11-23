import { z } from "zod";
import { admin, fail, json, sameOrigin, sheets } from "@/lib/server";

export const maxDuration = 60;

const target = z.union([
  z.object({ musicianId: z.string().uuid() }),
  z.object({ bookingId: z.string().uuid(), memberId: z.string().uuid() }),
]);

export async function POST(req: Request) {
  try {
    sameOrigin(req);
    await admin();
    const fields = target.parse(await req.json());
    const result = await sheets("sensitiveView", { ...fields, mode: "reveal" });
    return json({ details: result.records[0] });
  } catch (error) {
    return fail(error);
  }
}
